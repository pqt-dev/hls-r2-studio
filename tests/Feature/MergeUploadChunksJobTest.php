<?php

namespace Tests\Feature;

use App\Exceptions\StorageConfigurationException;
use App\Jobs\MergeUploadChunksJob;
use App\Jobs\TranscodeVideoJob;
use App\Models\Video;
use App\Support\VideoProgress;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use ReflectionClass;
use ReflectionMethod;
use Tests\TestCase;

class MergeUploadChunksJobTest extends TestCase
{
    use RefreshDatabase;

    private const UPLOAD_ID = '22222222-2222-4222-8222-222222222222';

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        Queue::fake();
    }

    private function videoBytes(int $size): string
    {
        $header = "\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41";

        return substr($header.str_repeat('v', $size), 0, $size);
    }

    /**
     * @param  array<int, string>  $chunks  chunk bodies keyed by chunk index
     */
    private function storeChunks(array $chunks): void
    {
        foreach ($chunks as $index => $body) {
            Storage::disk('local')->put('chunked_uploads/'.self::UPLOAD_ID."/chunks/{$index}.chunk", $body);
        }
    }

    private function makeVideo(int $size, array $attributes = []): Video
    {
        return Video::create(array_merge([
            'title' => 'video',
            'original_filename' => 'video.mp4',
            'original_size_bytes' => $size,
            'status' => 'pending',
            'stage' => 'queued',
            'progress' => VideoProgress::overall('queued', 0, $size, true),
            'upload_id' => self::UPLOAD_ID,
        ], $attributes));
    }

    private function targetPath(): string
    {
        return Storage::disk('local')->path('uploads/target.mp4');
    }

    private function job(Video $video): MergeUploadChunksJob
    {
        return new MergeUploadChunksJob($video->id, $this->targetPath(), self::UPLOAD_ID);
    }

    private function runJob(Video $video): ?\Throwable
    {
        try {
            $this->job($video)->handle();
        } catch (\Throwable $e) {
            return $e;
        }

        return null;
    }

    public function test_it_assembles_chunks_in_order_and_hands_over_to_the_transcode_job(): void
    {
        $content = $this->videoBytes(3000);
        $parts = str_split($content, 1000);
        $this->storeChunks([2 => $parts[2], 0 => $parts[0], 1 => $parts[1]]);
        $video = $this->makeVideo(strlen($content));

        $this->assertNull($this->runJob($video));

        $this->assertSame($content, file_get_contents($this->targetPath()));
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);

        $video->refresh();
        $this->assertSame('pending', $video->status);
        $this->assertSame('queued', $video->stage);
        $this->assertGreaterThanOrEqual(VideoProgress::overall('transcoding', 0, 3000, true), $video->progress);
        $this->assertDatabaseHas('video_status_logs', ['video_id' => $video->id, 'stage' => 'merging', 'status' => 'pending']);

        Queue::assertPushed(TranscodeVideoJob::class, 1);
        Queue::assertPushed(TranscodeVideoJob::class, fn (TranscodeVideoJob $job) => $job->videoId === $video->id
            && $job->localUploadPath === $this->targetPath()
            && $job->uploadId === null
            && $job->merged === true
            && $job->queue === null);
    }

    public function test_the_claim_makes_a_second_run_a_no_op(): void
    {
        $content = $this->videoBytes(1000);
        $this->storeChunks([0 => $content]);
        $video = $this->makeVideo(1000);

        $this->runJob($video);
        // Simulate the transcode job having claimed the video in between.
        $video->update(['status' => 'processing', 'stage' => 'transcoding']);
        $this->runJob($video);

        Queue::assertPushed(TranscodeVideoJob::class, 1);
        $this->assertSame('processing', $video->fresh()->status);
    }

    public function test_videos_that_are_not_pending_and_queued_are_ignored(): void
    {
        $this->storeChunks([0 => $this->videoBytes(1000)]);

        foreach ([['processing', 'queued'], ['pending', 'merging'], ['failed', 'failed'], ['ready', 'ready']] as [$status, $stage]) {
            $video = $this->makeVideo(1000, ['status' => $status, 'stage' => $stage]);

            $this->assertNull($this->runJob($video));
            $this->assertSame([$status, $stage], [$video->fresh()->status, $video->fresh()->stage]);
        }

        Queue::assertNothingPushed();
        $this->assertFileDoesNotExist($this->targetPath());
        (new MergeUploadChunksJob(999999, $this->targetPath(), self::UPLOAD_ID))->handle();
        Queue::assertNothingPushed();
    }

    public function test_an_existing_target_skips_the_merge_but_still_dispatches_the_transcode(): void
    {
        $this->storeChunks([0 => 'unused']);
        File::ensureDirectoryExists(dirname($this->targetPath()));
        file_put_contents($this->targetPath(), 'already merged');
        $video = $this->makeVideo(14);

        $this->assertNull($this->runJob($video));

        $this->assertSame('already merged', file_get_contents($this->targetPath()));
        $this->assertDatabaseMissing('video_status_logs', ['video_id' => $video->id, 'stage' => 'merging']);
        $this->assertSame('queued', $video->fresh()->stage);
        Queue::assertPushed(TranscodeVideoJob::class, 1);
    }

    public function test_a_missing_chunk_fails_the_video_and_cleans_up(): void
    {
        $parts = str_split($this->videoBytes(3000), 1000);
        $this->storeChunks([0 => $parts[0], 2 => $parts[2]]);
        $video = $this->makeVideo(3000);

        $error = $this->runJob($video);

        $this->assertInstanceOf(\RuntimeException::class, $error);
        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertSame('failed', $video->stage);
        $this->assertStringContainsString('Chunk 1 is missing', $video->error_detail);
        $this->assertNotNull($video->failed_at);
        $this->assertFileDoesNotExist($this->targetPath());
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
        Queue::assertNothingPushed();
    }

    public function test_a_size_mismatch_removes_the_partial_file(): void
    {
        $this->storeChunks([0 => $this->videoBytes(900)]);
        $video = $this->makeVideo(1000);

        $this->runJob($video);

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('Assembled size 900 does not match expected 1000', $video->error_detail);
        $this->assertFileDoesNotExist($this->targetPath());
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
        Queue::assertNothingPushed();
    }

    public function test_content_that_is_not_a_video_fails_the_video(): void
    {
        $this->storeChunks([0 => str_repeat('a', 1000)]);
        $video = $this->makeVideo(1000);

        $this->runJob($video);

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('does not appear to be a valid video', $video->error_detail);
        $this->assertFileDoesNotExist($this->targetPath());
        Queue::assertNothingPushed();
    }

    public function test_an_unwritable_target_fails_with_the_storage_configuration_message(): void
    {
        $this->storeChunks([0 => $this->videoBytes(1000)]);
        $video = $this->makeVideo(1000);
        if (function_exists('posix_geteuid') && posix_geteuid() === 0) {
            $this->markTestSkipped('Permissions are not enforced for root.');
        }

        // A read-only target directory makes fopen('wb') fail.
        File::ensureDirectoryExists(dirname($this->targetPath()));
        chmod(dirname($this->targetPath()), 0555);

        $error = $this->runJob($video);

        chmod(dirname($this->targetPath()), 0755);

        $this->assertInstanceOf(StorageConfigurationException::class, $error);
        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('Unable to open the merged upload file for writing', $video->error_detail);
        $this->assertStringContainsString('storage configuration issue', $video->error_message);
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
        Queue::assertNothingPushed();
    }

    public function test_failed_cleans_up_when_killed_while_merging_and_is_idempotent(): void
    {
        $this->storeChunks([0 => 'partial']);
        File::ensureDirectoryExists(dirname($this->targetPath()));
        file_put_contents($this->targetPath(), 'partial');
        $video = $this->makeVideo(1000, ['stage' => 'merging']);

        $this->job($video)->failed(new \RuntimeException('Worker killed.'));

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('Worker killed.', $video->error_detail);
        $this->assertFileDoesNotExist($this->targetPath());
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);

        $failedAt = $video->failed_at;
        $this->job($video)->failed(new \RuntimeException('Second call.'));
        $this->assertStringContainsString('Worker killed.', $video->fresh()->error_detail);
        $this->assertEquals($failedAt, $video->fresh()->failed_at);
    }

    public function test_failed_ignores_videos_that_are_not_pending_and_merging(): void
    {
        foreach ([['pending', 'queued'], ['processing', 'transcoding'], ['ready', 'ready']] as [$status, $stage]) {
            $video = $this->makeVideo(1000, ['status' => $status, 'stage' => $stage]);

            $this->job($video)->failed(new \RuntimeException('boom'));

            $this->assertSame($status, $video->fresh()->status);
        }

        (new MergeUploadChunksJob(999999, $this->targetPath(), self::UPLOAD_ID))->failed(new \RuntimeException('boom'));
        $this->addToAssertionCount(1);
    }

    public function test_progress_never_decreases_across_merge_and_transcode(): void
    {
        $content = $this->videoBytes(2000);
        $this->storeChunks([0 => $content]);
        $video = $this->makeVideo(2000);

        $this->runJob($video);
        $afterMerge = $video->fresh()->progress;

        // The merged TranscodeVideoJob keeps the progress when it claims the video.
        $transcode = new TranscodeVideoJob($video->id, $this->targetPath(), null, true);
        $closure = (new ReflectionMethod(TranscodeVideoJob::class, 'overallProgress'))->getClosure($transcode);
        $claimed = Video::find($video->id);

        $this->assertGreaterThanOrEqual($afterMerge, $closure($claimed, 'queued'));
        $this->assertGreaterThanOrEqual($afterMerge, $closure($claimed, 'transcoding'));
        $this->assertSame(
            VideoProgress::overall('transcoding', 0.5, 2000, true),
            $closure($claimed, 'transcoding', 0.5)
        );
    }

    public function test_a_merged_transcode_job_keeps_the_progress_on_claim_and_does_not_merge(): void
    {
        config(['services.ffmpeg.ffprobe_binary' => '/nonexistent/ffprobe', 'videos.keep_original_upload' => true]);
        $video = $this->makeVideo(1000, ['progress' => 12]);

        try {
            (new TranscodeVideoJob($video->id, $this->targetPath(), null, true))->handle();
        } catch (\Throwable) {
            // Expected: ffprobe is stubbed out and fails.
        }

        $video->refresh();
        $this->assertGreaterThanOrEqual(12, $video->progress);
        $this->assertDatabaseMissing('video_status_logs', ['video_id' => $video->id, 'stage' => 'merging']);
    }

    public function test_a_transcode_job_serialized_before_the_merged_flag_unserializes_as_not_merged(): void
    {
        $job = (new ReflectionClass(TranscodeVideoJob::class))->newInstanceWithoutConstructor();

        $this->assertFalse($job->merged);
    }
}
