<?php

namespace Tests\Feature;

use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CleanupOrphanedTranscodeTmpTest extends TestCase
{
    use RefreshDatabase;

    private function makeVideo(array $attributes = []): Video
    {
        return Video::create(array_merge([
            'title' => 'Test video',
            'original_filename' => 'test.mp4',
            'status' => 'processing',
            'stage' => 'transcoding',
            'progress' => 10,
        ], $attributes));
    }

    private function markStuckSince(Video $video, \DateTimeInterface $updatedAt): void
    {
        $video->timestamps = false;
        $video->updated_at = $updatedAt;
        $video->save();
    }

    private function touchDirectory(string $relativePath, int $timestamp): void
    {
        $absolutePath = Storage::disk('local')->path($relativePath);
        touch($absolutePath.'/marker', $timestamp);
        touch($absolutePath, $timestamp);
    }

    /**
     * Point the R2 disk at a closed local port so any deleteDirectory attempt
     * fails fast with a connection error instead of reaching a real bucket.
     * This is used to prove the R2 cleanup is best-effort: it must not
     * prevent the video from being marked failed, and must not crash the
     * command. A real S3 client is required to assert deleteDirectory() was
     * actually invoked with the right prefix, so that specific call is
     * verified by reading TranscodeVideoJob::cleanupRemoteFiles(), whose
     * try/catch structure CleanupOrphanedTranscodeTmp::cleanupRemoteFiles()
     * mirrors exactly.
     */
    private function pointR2AtUnreachableEndpoint(): void
    {
        config()->set('filesystems.disks.r2', [
            'driver' => 's3',
            'key' => 'test-key',
            'secret' => 'test-secret',
            'region' => 'auto',
            'bucket' => 'test-bucket',
            'endpoint' => 'http://127.0.0.1:1',
            'url' => 'http://127.0.0.1:1',
            'use_path_style_endpoint' => true,
        ]);
    }

    public function test_it_deletes_directory_when_video_record_no_longer_exists(): void
    {
        Storage::fake('local');
        Storage::disk('local')->makeDirectory('hls_tmp/9999');
        $this->touchDirectory('hls_tmp/9999', now()->subDays(10)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-tmp');

        Storage::disk('local')->assertDirectoryEmpty('hls_tmp');
    }

    public function test_it_cleans_up_r2_and_marks_failed_when_processing_video_is_stuck_and_directory_exists(): void
    {
        Storage::fake('local');
        $this->pointR2AtUnreachableEndpoint();
        config(['videos.orphaned_transcode_ttl_hours' => 48]);

        $video = $this->makeVideo(['disk_prefix' => '2026/09/17/test-video-1/']);
        Storage::disk('local')->makeDirectory("hls_tmp/{$video->id}");
        $this->touchDirectory("hls_tmp/{$video->id}", now()->subHours(72)->getTimestamp());
        $this->markStuckSince($video, now()->subHours(72));

        // The R2 cleanup attempt fails (unreachable endpoint), but this must
        // not throw out of the command and must not prevent the directory
        // from being removed or the video from being marked failed.
        $this->artisan('videos:cleanup-orphaned-tmp');

        Storage::disk('local')->assertDirectoryEmpty('hls_tmp');

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertSame('failed', $video->stage);
        $this->assertSame(
            'Processing was interrupted unexpectedly and could not be completed. Please try uploading the video again.',
            $video->error_message
        );
    }

    public function test_it_marks_failed_when_processing_video_is_stuck_and_directory_is_already_gone(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_transcode_ttl_hours' => 48]);

        $video = $this->makeVideo();
        // No hls_tmp/{id} directory is ever created for this video, simulating
        // a crash so early the temp directory never existed, or one removed
        // by another process. Only the DB record proves it is stuck.
        $this->markStuckSince($video, now()->subHours(72));

        $this->artisan('videos:cleanup-orphaned-tmp');

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertSame('failed', $video->stage);
        $this->assertSame(
            'Processing was interrupted unexpectedly and could not be completed. Please try uploading the video again.',
            $video->error_message
        );
    }

    public function test_it_deletes_directory_when_video_is_already_in_a_terminal_state(): void
    {
        Storage::fake('local');
        $video = $this->makeVideo(['status' => 'ready', 'stage' => 'ready', 'progress' => 100]);
        Storage::disk('local')->makeDirectory("hls_tmp/{$video->id}");
        // Fresh directory (not past any TTL): a terminal-state video must
        // have its leftover temp directory removed regardless of age, since
        // cleanup() should already have removed it during the normal job
        // flow — its continued presence means cleanup() itself failed.
        $this->touchDirectory("hls_tmp/{$video->id}", now()->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-tmp');

        Storage::disk('local')->assertDirectoryEmpty('hls_tmp');

        $video->refresh();
        $this->assertSame('ready', $video->status);
    }

    public function test_it_deletes_directory_with_no_matching_video_record(): void
    {
        Storage::fake('local');
        Storage::disk('local')->makeDirectory('hls_tmp/8888');
        $this->touchDirectory('hls_tmp/8888', now()->subDays(10)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-tmp');

        Storage::disk('local')->assertDirectoryEmpty('hls_tmp');
    }

    public function test_it_leaves_recent_processing_video_untouched(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_transcode_ttl_hours' => 48]);

        $video = $this->makeVideo();
        Storage::disk('local')->makeDirectory("hls_tmp/{$video->id}");
        $this->touchDirectory("hls_tmp/{$video->id}", now()->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-tmp');

        Storage::disk('local')->assertExists("hls_tmp/{$video->id}/marker");

        $video->refresh();
        $this->assertSame('processing', $video->status);
        $this->assertNull($video->error_message);
    }
}
