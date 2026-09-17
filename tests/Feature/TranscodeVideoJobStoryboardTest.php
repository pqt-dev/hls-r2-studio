<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use Illuminate\Support\Facades\File;
use ReflectionMethod;
use Tests\TestCase;

class TranscodeVideoJobStoryboardTest extends TestCase
{
    private function job(): TranscodeVideoJob
    {
        return new TranscodeVideoJob(1, '/tmp/does-not-matter.mp4');
    }

    private function generateStoryboard(TranscodeVideoJob $job, string $inputPath, string $tmpDir, ?float $duration): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'generateStoryboard');
        $closure = $method->getClosure($job);

        $closure($inputPath, $tmpDir, $duration);
    }

    public function test_generate_storyboard_does_nothing_when_duration_is_null(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->generateStoryboard($this->job(), '/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, null);

        $this->assertFileDoesNotExist("{$tmpDir}/storyboard.jpg");
        $this->assertFileDoesNotExist("{$tmpDir}/storyboard.json");

        File::deleteDirectory($tmpDir);
    }

    public function test_generate_storyboard_does_nothing_when_duration_is_zero_or_negative(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->generateStoryboard($this->job(), '/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, 0.0);

        $this->assertFileDoesNotExist("{$tmpDir}/storyboard.jpg");
        $this->assertFileDoesNotExist("{$tmpDir}/storyboard.json");

        File::deleteDirectory($tmpDir);
    }

    public function test_generate_storyboard_throws_when_input_does_not_exist(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->expectException(\RuntimeException::class);

        try {
            $this->generateStoryboard($this->job(), '/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, 10.0);
        } finally {
            $this->assertFileDoesNotExist("{$tmpDir}/storyboard.jpg");
            $this->assertFileDoesNotExist("{$tmpDir}/storyboard.json");

            File::deleteDirectory($tmpDir);
        }
    }

    public function test_generate_storyboard_creates_grid_image_and_metadata_for_real_video(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $inputPath = "{$tmpDir}/input.mp4";

        $genProcess = new \Symfony\Component\Process\Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-f', 'lavfi',
            '-i', 'testsrc=duration=10:size=320x240:rate=25',
            '-pix_fmt', 'yuv420p',
            $inputPath,
        ]);
        $genProcess->setTimeout(60);
        $genProcess->run();

        if (! $genProcess->isSuccessful()) {
            $this->markTestSkipped('ffmpeg is not available in this environment to generate a test input video.');
        }

        $duration = 10.0;

        $this->generateStoryboard($this->job(), $inputPath, $tmpDir, $duration);

        $this->assertFileExists("{$tmpDir}/storyboard.jpg");
        $this->assertFileExists("{$tmpDir}/storyboard.json");

        $dimensions = getimagesize("{$tmpDir}/storyboard.jpg");
        $this->assertNotFalse($dimensions);
        // Duration < 60s uses a 3x3 grid, tile size from config (default 160).
        $tileSize = config('videos.storyboard_tile_size');
        $this->assertSame($tileSize * 3, $dimensions[0]);
        $this->assertSame($tileSize * 3, $dimensions[1]);

        $meta = json_decode(File::get("{$tmpDir}/storyboard.json"), true);
        $this->assertCount(9, $meta);
        $this->assertEquals(0.0, $meta[0]['start']);
        $this->assertSame(0, $meta[0]['x']);
        $this->assertSame(0, $meta[0]['y']);
        $this->assertSame($tileSize, $meta[1]['x']);
        $this->assertSame($tileSize, $meta[3]['y']);

        File::deleteDirectory($tmpDir);
    }
}
