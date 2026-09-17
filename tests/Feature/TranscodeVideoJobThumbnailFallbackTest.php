<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use Illuminate\Support\Facades\File;
use ReflectionMethod;
use Tests\TestCase;

class TranscodeVideoJobThumbnailFallbackTest extends TestCase
{
    private function job(): TranscodeVideoJob
    {
        return new TranscodeVideoJob(1, '/tmp/does-not-matter.mp4');
    }

    public function test_generate_thumbnail_leaves_no_file_and_does_not_throw_when_no_candidate_can_be_extracted(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_thumb_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $method = new ReflectionMethod(TranscodeVideoJob::class, 'generateThumbnail');
        $closure = $method->getClosure($this->job());

        // Nonexistent input path: every candidate extraction attempt fails at
        // the ffmpeg level, so no candidate is ever produced.
        $closure('/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, 10.0, 1920, 1080);

        $this->assertFileDoesNotExist("{$tmpDir}/thumbnail.jpg");

        File::deleteDirectory($tmpDir);
    }

    public function test_generate_thumbnail_leaves_no_file_and_does_not_throw_for_short_video_when_extraction_fails(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_thumb_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $method = new ReflectionMethod(TranscodeVideoJob::class, 'generateThumbnail');
        $closure = $method->getClosure($this->job());

        // Duration below the 3s threshold takes the short-video branch,
        // which must also swallow the extraction failure instead of throwing.
        $closure('/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, 1.0, 1920, 1080);

        $this->assertFileDoesNotExist("{$tmpDir}/thumbnail.jpg");

        File::deleteDirectory($tmpDir);
    }
}
