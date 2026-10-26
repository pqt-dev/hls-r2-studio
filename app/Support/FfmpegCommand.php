<?php

namespace App\Support;

use Symfony\Component\Process\ExecutableFinder;

final class FfmpegCommand
{
    /** Resolved path of the `nice` executable; null = not looked up yet, false = not found. */
    private static string|false|null $nicePath = null;

    /**
     * Prefix the command with `nice` so ffmpeg runs at a lower CPU priority.
     *
     * `nice` execs the command, so the PID, timeouts and progress handling of
     * the Process keep working. Returns the args unchanged when disabled or
     * when `nice` is not available.
     *
     * @param  list<string>  $args
     * @return list<string>
     */
    public static function wrap(array $args): array
    {
        $level = (int) config('services.ffmpeg.nice');

        if ($level <= 0) {
            return $args;
        }

        self::$nicePath ??= (new ExecutableFinder)->find('nice') ?? false;

        if (self::$nicePath === false) {
            return $args;
        }

        return [self::$nicePath, '-n', (string) $level, ...$args];
    }

    /**
     * Output options limiting the encoder threads, or an empty list when not configured.
     *
     * @return list<string>
     */
    public static function threadArgs(): array
    {
        $threads = config('services.ffmpeg.threads');

        return $threads ? ['-threads', (string) $threads] : [];
    }

    /**
     * Forget the cached `nice` lookup (for tests).
     */
    public static function resetCache(): void
    {
        self::$nicePath = null;
    }
}
