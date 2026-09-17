<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\File;
use ReflectionMethod;
use Tests\TestCase;

class TranscodeVideoJobUploadTest extends TestCase
{
    use RefreshDatabase;

    private function job(): TranscodeVideoJob
    {
        return new TranscodeVideoJob(1, '/tmp/does-not-matter.mp4');
    }

    private function makeVideo(): Video
    {
        return Video::create([
            'title' => 'Test video',
            'original_filename' => 'test.mp4',
            'status' => 'processing',
            'stage' => 'uploading_r2',
            'progress' => 92,
        ]);
    }

    /**
     * Point the R2 disk at a closed local port so every upload attempt fails
     * fast with a connection error instead of reaching a real bucket.
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

    public function test_upload_directory_does_nothing_when_the_output_directory_is_empty(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_upload_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $video = $this->makeVideo();

        $method = new ReflectionMethod(TranscodeVideoJob::class, 'uploadDirectory');
        $closure = $method->getClosure($this->job());

        // No R2 configuration is set up at all: an empty directory must return
        // before the disk is ever touched.
        $closure($tmpDir, '2026/09/17/test-1/', $video);

        $this->assertSame(92, $video->progress);

        File::deleteDirectory($tmpDir);
    }

    public function test_upload_directory_retries_then_reports_every_file_that_could_not_be_uploaded(): void
    {
        $this->pointR2AtUnreachableEndpoint();

        $tmpDir = sys_get_temp_dir().'/transcode_upload_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);
        File::put("{$tmpDir}/playlist.m3u8", "#EXTM3U\n");

        $video = $this->makeVideo();

        $method = new ReflectionMethod(TranscodeVideoJob::class, 'uploadDirectory');
        $closure = $method->getClosure($this->job());

        try {
            $closure($tmpDir, '2026/09/17/test-1/', $video);

            $this->fail('Expected the upload to fail after exhausting every attempt.');
        } catch (\RuntimeException $e) {
            // The message must name the exact file so the failure is debuggable
            // from the logs alone.
            $this->assertStringContainsString('playlist.m3u8', $e->getMessage());
            $this->assertStringContainsString('3 application-level attempts', $e->getMessage());
        }

        // A file that never uploaded must not count towards the progress bar.
        $this->assertSame(92, $video->progress);

        File::deleteDirectory($tmpDir);
    }
}
