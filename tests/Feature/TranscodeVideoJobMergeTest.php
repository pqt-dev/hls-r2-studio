<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use App\Models\Video;
use App\Models\VideoStatusLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Storage;
use ReflectionClass;
use Tests\TestCase;

class TranscodeVideoJobMergeTest extends TestCase
{
    use RefreshDatabase;

    private const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        // Forces the job to fail right after the merge stage (at ffprobe),
        // so the merge can be tested without running a real transcode.
        config(['services.ffmpeg.ffprobe_binary' => '/nonexistent/ffprobe']);
        // Keeps the (successfully merged) original after the stubbed failure so it can be inspected.
        config(['videos.keep_original_upload' => true]);
    }

    private function videoBytes(int $size): string
    {
        $header = "\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41";

        return substr($header.str_repeat('v', $size), 0, $size);
    }

    /**
     * @param  list<string>  $chunks  chunk bodies keyed by chunk index
     */
    private function storeChunks(array $chunks): void
    {
        foreach ($chunks as $index => $body) {
            Storage::disk('local')->put('chunked_uploads/'.self::UPLOAD_ID."/chunks/{$index}.chunk", $body);
        }
    }

    private function makeVideo(int $size): Video
    {
        return Video::create([
            'title' => 'video',
            'original_filename' => 'video.mp4',
            'original_size_bytes' => $size,
            'status' => 'pending',
            'upload_id' => self::UPLOAD_ID,
        ]);
    }

    private function targetPath(): string
    {
        return Storage::disk('local')->path('uploads/target.mp4');
    }

    private function runJob(Video $video): ?\Throwable
    {
        try {
            (new TranscodeVideoJob($video->id, $this->targetPath(), self::UPLOAD_ID))->handle();
        } catch (\Throwable $e) {
            return $e;
        }

        return null;
    }

    public function test_it_merges_chunks_in_index_order_and_removes_the_chunk_directory(): void
    {
        $content = $this->videoBytes(3000);
        $parts = str_split($content, 1000);
        // Stored out of order and with a multi-digit index to prove numeric ordering.
        $this->storeChunks([2 => $parts[2], 0 => $parts[0], 1 => $parts[1]]);
        $video = $this->makeVideo(strlen($content));

        $this->runJob($video);

        $this->assertSame($content, file_get_contents($this->targetPath()));
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
        $this->assertTrue(VideoStatusLog::where('video_id', $video->id)->where('stage', 'merging')->exists());
        // The merge succeeded; the video only fails later, at the (stubbed-out) probe step.
        $this->assertStringContainsString('ffprobe', Video::find($video->id)->error_detail);
    }

    public function test_a_missing_chunk_fails_the_video_and_cleans_up(): void
    {
        $parts = str_split($this->videoBytes(3000), 1000);
        $this->storeChunks([0 => $parts[0], 2 => $parts[2]]);
        $video = $this->makeVideo(3000);

        $this->runJob($video);

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('Chunk 1 is missing', $video->error_detail);
        $this->assertFileDoesNotExist($this->targetPath());
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
    }

    public function test_a_size_mismatch_fails_the_video_and_removes_the_partial_file(): void
    {
        $this->storeChunks([0 => $this->videoBytes(900)]);
        $video = $this->makeVideo(1000);

        $this->runJob($video);

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('Assembled size 900 does not match expected 1000', $video->error_detail);
        $this->assertFileDoesNotExist($this->targetPath());
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
    }

    public function test_assembled_content_that_is_not_a_video_fails_the_video(): void
    {
        $this->storeChunks([0 => str_repeat('a', 1000)]);
        $video = $this->makeVideo(1000);

        $this->runJob($video);

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertStringContainsString('does not appear to be a valid video', $video->error_detail);
        $this->assertFileDoesNotExist($this->targetPath());
    }

    public function test_an_existing_target_skips_the_merge(): void
    {
        $this->storeChunks([0 => 'unused']);
        File::ensureDirectoryExists(dirname($this->targetPath()));
        file_put_contents($this->targetPath(), 'already merged');
        $video = $this->makeVideo(14);

        $this->runJob($video);

        $this->assertFalse(VideoStatusLog::where('video_id', $video->id)->where('stage', 'merging')->exists());
        $this->assertSame('already merged', file_get_contents($this->targetPath()));
    }

    public function test_failed_removes_a_partial_target_and_the_chunk_directory_when_killed_while_merging(): void
    {
        $this->storeChunks([0 => 'partial']);
        File::ensureDirectoryExists(dirname($this->targetPath()));
        file_put_contents($this->targetPath(), 'partial');
        $video = $this->makeVideo(1000);
        $video->update(['status' => 'processing', 'stage' => 'merging']);

        (new TranscodeVideoJob($video->id, $this->targetPath(), self::UPLOAD_ID))->failed(new \RuntimeException('Worker killed.'));

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertFileDoesNotExist($this->targetPath());
        Storage::disk('local')->assertMissing('chunked_uploads/'.self::UPLOAD_ID);
    }

    public function test_a_job_without_an_upload_id_does_not_merge(): void
    {
        $video = $this->makeVideo(10);

        try {
            (new TranscodeVideoJob($video->id, '/tmp/this-input-does-not-exist-'.uniqid().'.mp4'))->handle();
        } catch (\Throwable) {
            // Expected: ffprobe fails on the missing input.
        }

        $this->assertFalse(VideoStatusLog::where('video_id', $video->id)->where('stage', 'merging')->exists());
        $this->assertStringNotContainsString('Chunk', Video::find($video->id)->error_detail);
    }

    public function test_a_job_serialized_before_the_upload_id_existed_unserializes_with_null(): void
    {
        $job = (new ReflectionClass(TranscodeVideoJob::class))->newInstanceWithoutConstructor();

        $this->assertNull($job->uploadId);
    }
}
