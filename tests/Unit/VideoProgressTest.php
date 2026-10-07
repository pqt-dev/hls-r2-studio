<?php

namespace Tests\Unit;

use App\Support\VideoProgress;
use InvalidArgumentException;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class VideoProgressTest extends TestCase
{
    private const MB = 1048576;

    public static function sizeProvider(): array
    {
        return [
            'empty' => [0],
            '5 MB' => [5 * self::MB],
            '100 MB' => [100 * self::MB],
            '1 GB' => [1024 * self::MB],
            '2 GB' => [2048 * self::MB],
        ];
    }

    #[DataProvider('sizeProvider')]
    public function test_weights_sum_to_100(int $size): void
    {
        $this->assertEqualsWithDelta(100, array_sum(VideoProgress::weights($size)), 0.0001);
        $this->assertEqualsWithDelta(100, array_sum(VideoProgress::weights($size, false)), 0.0001);
    }

    public function test_weights_without_merge_stage_drop_merging(): void
    {
        $this->assertArrayHasKey('merging', VideoProgress::weights(5 * self::MB));
        $this->assertArrayNotHasKey('merging', VideoProgress::weights(5 * self::MB, false));
    }

    public function test_light_and_heavy_files_get_different_splits(): void
    {
        $light = VideoProgress::weights(5 * self::MB);
        $heavy = VideoProgress::weights(2048 * self::MB);

        $this->assertGreaterThan($light['uploading_r2'], $heavy['uploading_r2']);
        $this->assertLessThan($light['transcoding'], $heavy['transcoding']);
    }

    #[DataProvider('sizeProvider')]
    public function test_overall_is_non_decreasing_across_the_ordered_samples(int $size): void
    {
        $previous = 0;

        foreach (VideoProgress::STAGES as $stage) {
            foreach ([0.0, 0.25, 0.5, 0.75, 1.0] as $fraction) {
                $value = VideoProgress::overall($stage, $fraction, $size);

                $this->assertGreaterThanOrEqual($previous, $value, "{$stage} {$fraction}");
                $this->assertLessThan(100, $value);
                $previous = $value;
            }
        }
    }

    public function test_ready_is_100(): void
    {
        $this->assertSame(100, VideoProgress::overall('ready', 0.0, 5 * self::MB));
    }

    public function test_non_final_stages_never_reach_100_even_with_out_of_range_fractions(): void
    {
        $this->assertSame(99, VideoProgress::overall('uploading_r2', 5.0, 5 * self::MB));
        $this->assertSame(
            VideoProgress::overall('transcoding', 0.0, 5 * self::MB),
            VideoProgress::overall('transcoding', -3.0, 5 * self::MB)
        );
    }

    public function test_upload_complete_value_is_the_floored_upload_weight(): void
    {
        foreach ([5 * self::MB, 2048 * self::MB] as $size) {
            $expected = (int) floor(VideoProgress::weights($size)['upload']);

            $this->assertSame($expected, VideoProgress::overall('queued', 0.0, $size));
            $this->assertSame($expected, VideoProgress::overall('merging', 0.0, $size));
        }
    }

    public function test_a_stage_missing_from_the_job_is_rejected(): void
    {
        $this->expectException(InvalidArgumentException::class);

        VideoProgress::overall('merging', 0.0, 5 * self::MB, false);
    }
}
