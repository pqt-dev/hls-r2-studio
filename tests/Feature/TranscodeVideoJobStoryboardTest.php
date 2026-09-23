<?php

namespace Tests\Feature;

use App\Services\StoryboardGenerator;
use Illuminate\Support\Facades\File;
use ReflectionMethod;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class TranscodeVideoJobStoryboardTest extends TestCase
{
    /**
     * Every grid size the job is expected to produce.
     */
    private const GRID_SIZES = [3, 4, 5];

    private function generateStoryboard(string $inputPath, string $tmpDir, ?float $duration): void
    {
        (new StoryboardGenerator)->generate($inputPath, $tmpDir, $duration, 1);
    }

    private function assertNoStoryboardOutput(string $tmpDir): void
    {
        foreach (self::GRID_SIZES as $size) {
            $this->assertFileDoesNotExist("{$tmpDir}/storyboard_{$size}x{$size}.jpg");
            $this->assertFileDoesNotExist("{$tmpDir}/storyboard_{$size}x{$size}.json");
        }
    }

    /**
     * Intermediate frames are plain .jpg files in the same directory that is
     * uploaded wholesale to R2, so leaving any behind would ship dozens of
     * junk objects with every video.
     */
    private function assertNoIntermediateFilesLeftBehind(string $tmpDir): void
    {
        $this->assertSame([], glob("{$tmpDir}/candidate_*.jpg"));
        $this->assertSame([], glob("{$tmpDir}/tile_*.jpg"));
    }

    public function test_generate_storyboard_does_nothing_when_duration_is_null(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->generateStoryboard('/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, null);

        $this->assertNoStoryboardOutput($tmpDir);

        File::deleteDirectory($tmpDir);
    }

    public function test_generate_storyboard_does_nothing_when_duration_is_zero_or_negative(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->generateStoryboard('/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, 0.0);

        $this->assertNoStoryboardOutput($tmpDir);

        File::deleteDirectory($tmpDir);
    }

    public function test_generate_storyboard_throws_when_input_does_not_exist(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->expectException(\RuntimeException::class);

        try {
            $this->generateStoryboard('/tmp/this-input-does-not-exist-'.uniqid().'.mp4', $tmpDir, 10.0);
        } finally {
            $this->assertNoStoryboardOutput($tmpDir);
            $this->assertNoIntermediateFilesLeftBehind($tmpDir);

            File::deleteDirectory($tmpDir);
        }
    }

    public function test_generate_storyboard_creates_every_grid_image_and_metadata_for_real_video(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $inputPath = "{$tmpDir}/input.mp4";

        $genProcess = new Process([
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
        $tileSize = config('videos.storyboard_tile_size');

        $this->generateStoryboard($inputPath, $tmpDir, $duration);

        foreach (self::GRID_SIZES as $size) {
            $imagePath = "{$tmpDir}/storyboard_{$size}x{$size}.jpg";
            $metaPath = "{$tmpDir}/storyboard_{$size}x{$size}.json";

            $this->assertFileExists($imagePath);
            $this->assertFileExists($metaPath);

            $dimensions = getimagesize($imagePath);
            $this->assertNotFalse($dimensions);
            $this->assertSame($tileSize * $size, $dimensions[0], "{$size}x{$size} grid width");
            $this->assertSame($tileSize * $size, $dimensions[1], "{$size}x{$size} grid height");

            $totalTiles = $size * $size;
            $tileDuration = $duration / $totalTiles;

            $meta = json_decode(File::get($metaPath), true);
            $this->assertCount($totalTiles, $meta);

            $this->assertEquals(0.0, $meta[0]['start']);
            $this->assertSame(0, $meta[0]['x']);
            $this->assertSame(0, $meta[0]['y']);

            // Second tile is the next column of the first row; the tile at
            // index $size starts the second row.
            $this->assertSame($tileSize, $meta[1]['x']);
            $this->assertSame(0, $meta[1]['y']);
            $this->assertSame(0, $meta[$size]['x']);
            $this->assertSame($tileSize, $meta[$size]['y']);

            $this->assertEquals(round($tileDuration, 2), $meta[0]['end']);
            $this->assertEquals(round($duration, 2), $meta[$totalTiles - 1]['end']);
        }

        $this->assertNoIntermediateFilesLeftBehind($tmpDir);

        File::deleteDirectory($tmpDir);
    }

    /**
     * @param  list<array<string, mixed>>  $candidates
     * @return list<array<string, mixed>>
     */
    private function chooseStoryboardFrames(array $candidates, int $totalTiles, float $duration): array
    {
        $method = new ReflectionMethod(StoryboardGenerator::class, 'chooseStoryboardFrames');
        $closure = $method->getClosure(new StoryboardGenerator);

        return $closure($candidates, $totalTiles, $duration);
    }

    private function candidate(string $path, float $timestamp, ?float $saturation, ?float $detail): array
    {
        return [
            'timestamp' => $timestamp,
            'path' => $path,
            'saturationScore' => $saturation,
            'detailScore' => $detail,
        ];
    }

    public function test_choose_storyboard_frames_picks_the_best_scoring_candidate_in_each_slot(): void
    {
        // Two slots over a 10s video: slot 0 covers [0, 5), slot 1 [5, 10).
        $candidates = [
            $this->candidate('/slot0-dull.jpg', 0.0, 20.0, 4.0),
            $this->candidate('/slot0-best.jpg', 2.0, 40.0, 9.0),
            $this->candidate('/slot0-mid.jpg', 4.0, 30.0, 6.0),
            $this->candidate('/slot1-best.jpg', 5.0, 60.0, 8.0),
            $this->candidate('/slot1-dull.jpg', 8.0, 10.0, 5.0),
        ];

        $chosen = $this->chooseStoryboardFrames($candidates, 2, 10.0);

        $this->assertCount(2, $chosen);
        $this->assertSame('/slot0-best.jpg', $chosen[0]['path']);
        $this->assertSame('/slot1-best.jpg', $chosen[1]['path']);
    }

    public function test_choose_storyboard_frames_prefers_a_lower_ranked_candidate_that_passes_the_quality_threshold(): void
    {
        // The highest-ranked frame of the slot is a near-detail-free frame
        // (detail 1.0, below MIN_THUMBNAIL_DETAIL of 3.0), e.g. a fade or a
        // flat colour card, so the passing frame must win despite ranking
        // lower.
        $candidates = [
            $this->candidate('/flat-but-saturated.jpg', 0.0, 200.0, 1.0),
            $this->candidate('/passes-threshold.jpg', 1.0, 20.0, 10.0),
        ];

        $chosen = $this->chooseStoryboardFrames($candidates, 1, 10.0);

        $this->assertCount(1, $chosen);
        $this->assertSame('/passes-threshold.jpg', $chosen[0]['path']);
    }

    public function test_choose_storyboard_frames_falls_back_to_the_best_candidate_when_none_passes_the_threshold(): void
    {
        // Every candidate is below MIN_THUMBNAIL_SATURATION (5.0), so the slot
        // must still be filled with the best-ranked one rather than left empty.
        $candidates = [
            $this->candidate('/worst.jpg', 0.0, 1.0, 1.0),
            $this->candidate('/least-bad.jpg', 1.0, 4.0, 2.0),
            $this->candidate('/unscored.jpg', 2.0, null, null),
        ];

        $chosen = $this->chooseStoryboardFrames($candidates, 1, 10.0);

        $this->assertCount(1, $chosen);
        $this->assertSame('/least-bad.jpg', $chosen[0]['path']);
    }

    public function test_choose_storyboard_frames_fills_an_empty_slot_from_the_nearest_slot_that_has_one(): void
    {
        // Four slots of 1s each, but candidates only fall into slots 0 and 3.
        $candidates = [
            $this->candidate('/first.jpg', 0.0, 50.0, 10.0),
            $this->candidate('/last.jpg', 3.5, 50.0, 10.0),
        ];

        $chosen = $this->chooseStoryboardFrames($candidates, 4, 4.0);

        $this->assertCount(4, $chosen);
        $this->assertSame('/first.jpg', $chosen[0]['path']);
        $this->assertSame('/first.jpg', $chosen[1]['path']);
        $this->assertSame('/last.jpg', $chosen[2]['path']);
        $this->assertSame('/last.jpg', $chosen[3]['path']);
    }

    public function test_storyboard_paths_maps_every_generated_grid_to_its_r2_paths(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        // Only the 3x3 and 5x5 grids made it; the 4x4 pair is incomplete and
        // must be left out entirely rather than half recorded.
        File::put("{$tmpDir}/storyboard_3x3.jpg", 'x');
        File::put("{$tmpDir}/storyboard_3x3.json", '[]');
        File::put("{$tmpDir}/storyboard_4x4.jpg", 'x');
        File::put("{$tmpDir}/storyboard_5x5.jpg", 'x');
        File::put("{$tmpDir}/storyboard_5x5.json", '[]');

        $this->assertSame([
            '3x3' => [
                'path' => '2026/09/22/test-1/storyboard_3x3.jpg',
                'meta_path' => '2026/09/22/test-1/storyboard_3x3.json',
            ],
            '5x5' => [
                'path' => '2026/09/22/test-1/storyboard_5x5.jpg',
                'meta_path' => '2026/09/22/test-1/storyboard_5x5.json',
            ],
        ], StoryboardGenerator::paths($tmpDir, '2026/09/22/test-1/'));

        File::deleteDirectory($tmpDir);
    }

    public function test_storyboard_paths_is_null_when_no_grid_was_generated(): void
    {
        $tmpDir = sys_get_temp_dir().'/transcode_storyboard_test_'.uniqid();
        File::ensureDirectoryExists($tmpDir);

        $this->assertNull(StoryboardGenerator::paths($tmpDir, '2026/09/22/test-1/'));

        File::deleteDirectory($tmpDir);
    }
}
