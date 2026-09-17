<?php

namespace Tests\Unit;

use App\Jobs\TranscodeVideoJob;
use PHPUnit\Framework\Attributes\DataProvider;
use ReflectionMethod;
use Tests\TestCase;

class TranscodeVideoJobTest extends TestCase
{
    private function job(): TranscodeVideoJob
    {
        return new TranscodeVideoJob(1, '/tmp/does-not-matter.mp4');
    }

    #[DataProvider('timeoutDurationProvider')]
    public function test_calculate_process_timeout_scales_with_duration(float $duration, int $expected): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'calculateProcessTimeout');
        $closure = $method->getClosure();

        $this->assertSame($expected, $closure($duration));
    }

    public static function timeoutDurationProvider(): array
    {
        return [
            'short video (60s)' => [60.0, 600],
            'one hour video (3600s)' => [3600.0, 28800],
            'three hour video (10800s)' => [10800.0, 86400],
        ];
    }

    public function test_calculate_process_timeout_uses_unknown_duration_ceiling_when_duration_is_null(): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'calculateProcessTimeout');
        $closure = $method->getClosure();

        $this->assertSame(172800, $closure(null));
    }

    #[DataProvider('uploadableFileProvider')]
    public function test_is_uploadable_file_only_allows_ts_m3u8_and_jpg_extensions(string $filename, bool $expected): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'isUploadableFile');
        $closure = $method->getClosure();

        $this->assertSame($expected, $closure(new \SplFileInfo($filename)));
    }

    public static function uploadableFileProvider(): array
    {
        return [
            'segment file' => ['segment_000.ts', true],
            'playlist file' => ['playlist.m3u8', true],
            'thumbnail file' => ['thumbnail.jpg', true],
            'uppercase extension' => ['thumbnail.JPG', true],
            'progress file must not be uploaded' => ['ffmpeg_progress.txt', false],
            'stray temp file must not be uploaded' => ['thumb_candidate_0.jpg.tmp', false],
        ];
    }

    public function test_read_progress_increment_only_processes_newly_appended_bytes(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'ffmpeg_progress_');
        file_put_contents($path, '');

        $writeHandle = fopen($path, 'a');
        $readHandle = fopen($path, 'r');

        $method = new ReflectionMethod(TranscodeVideoJob::class, 'readProgressIncrement');
        $closure = $method->getClosure($this->job());

        $leftover = '';

        // First block written by ffmpeg.
        fwrite($writeHandle, "frame=1\nout_time_ms=1000000\nprogress=continue\n");
        fflush($writeHandle);

        $result1 = $closure($readHandle, $leftover);
        $positionAfterFirstRead = ftell($readHandle);

        $this->assertSame(1000000, $result1);
        $this->assertSame('', $leftover);
        // Position must be at end of the first block, not rewound to 0.
        $this->assertGreaterThan(0, $positionAfterFirstRead);

        // Simulate the file growing much larger with many more appended blocks.
        for ($i = 2; $i <= 500; $i++) {
            fwrite($writeHandle, "frame={$i}\nout_time_ms=".($i * 1000000)."\nprogress=continue\n");
        }
        fflush($writeHandle);

        $result2 = $closure($readHandle, $leftover);
        $positionAfterSecondRead = ftell($readHandle);

        // The reader must pick up the latest value from the new content only.
        $this->assertSame(500 * 1000000, $result2);

        // The read must have resumed from where it left off (no re-read from
        // byte 0): the file pointer keeps advancing forward, it is never
        // rewound back to the start of the (now much larger) file.
        $this->assertGreaterThan($positionAfterFirstRead, $positionAfterSecondRead);

        fclose($readHandle);
        fclose($writeHandle);
        unlink($path);
    }

    #[DataProvider('uploadProgressProvider')]
    public function test_upload_progress_percent_tracks_only_successfully_uploaded_files(int $uploaded, int $total, int $expected): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'uploadProgressPercent');
        $closure = $method->getClosure();

        $this->assertSame($expected, $closure($uploaded, $total));
    }

    public static function uploadProgressProvider(): array
    {
        return [
            'nothing uploaded yet' => [0, 10, 92],
            'half uploaded' => [5, 10, 96],
            'all uploaded' => [10, 10, 99],
            'single file done' => [1, 1, 99],
            // Guard against a division by zero when the output directory is
            // empty; the upload phase simply stays at its starting value.
            'no files at all' => [0, 0, 92],
        ];
    }

    #[DataProvider('uploadRetryDelayProvider')]
    public function test_upload_retry_delay_backs_off_between_attempts(int $attempt, int $expected): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'uploadRetryDelay');
        $closure = $method->getClosure();

        $this->assertSame($expected, $closure($attempt));
    }

    public static function uploadRetryDelayProvider(): array
    {
        return [
            'first attempt runs immediately' => [1, 0],
            'second attempt waits one second' => [2, 1],
            'third attempt waits two seconds' => [3, 2],
            // Defensive: anything past the configured schedule reuses the last
            // delay rather than falling back to no wait at all.
            'beyond the configured schedule' => [4, 2],
        ];
    }

    #[DataProvider('cleanupDecisionProvider')]
    public function test_should_cleanup_remote_files_only_once_a_prefix_was_recorded(?string $diskPrefix, bool $expected): void
    {
        $method = new ReflectionMethod(TranscodeVideoJob::class, 'shouldCleanupRemoteFiles');
        $closure = $method->getClosure();

        $this->assertSame($expected, $closure($diskPrefix));
    }

    public static function cleanupDecisionProvider(): array
    {
        return [
            'upload never started' => [null, false],
            'empty prefix' => ['', false],
            'blank prefix' => ['   ', false],
            'upload started or finished' => ['2026/09/17/my-video-1/', true],
        ];
    }

    public function test_read_progress_increment_keeps_incomplete_trailing_line_as_leftover(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'ffmpeg_progress_');
        file_put_contents($path, '');

        $writeHandle = fopen($path, 'a');
        $readHandle = fopen($path, 'r');

        $method = new ReflectionMethod(TranscodeVideoJob::class, 'readProgressIncrement');
        $closure = $method->getClosure($this->job());

        $leftover = '';

        // Write a value followed by an incomplete line (no trailing newline yet).
        fwrite($writeHandle, "out_time_ms=2000000\nout_time_ms=300");
        fflush($writeHandle);

        $result1 = $closure($readHandle, $leftover);

        $this->assertSame(2000000, $result1);
        $this->assertSame('out_time_ms=300', $leftover);

        // Complete the split line on the next write.
        fwrite($writeHandle, "0000\nprogress=continue\n");
        fflush($writeHandle);

        $result2 = $closure($readHandle, $leftover);

        $this->assertSame(3000000, $result2);
        $this->assertSame('', $leftover);

        fclose($readHandle);
        fclose($writeHandle);
        unlink($path);
    }
}
