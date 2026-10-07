<?php

namespace App\Support;

use InvalidArgumentException;

/**
 * Single overall progress (0-100) of a video, from the moment the user clicks
 * Upload until the HLS output is on R2.
 *
 * Every stage gets a share of the 100% that is proportional to its estimated
 * cost in seconds (fixed + per_mb * size in MB, see config/videos.php
 * 'progress'), so the split adapts to the weight of the video: a light file
 * spends most of its time on fixed costs, a heavy one on transcoding.
 */
final class VideoProgress
{
    /**
     * Stages in the order they run.
     */
    public const STAGES = [
        'upload',
        'merging',
        'transcoding',
        'generating_thumbnail',
        'generating_storyboard',
        'uploading_r2',
    ];

    private const BYTES_PER_MB = 1048576;

    /**
     * Share (in percent, as floats summing to 100) of each stage for a video
     * of the given size. Old-style jobs without a merge stage drop the
     * 'merging' share and the rest is renormalised to 100.
     *
     * @return array<string, float>
     */
    public static function weights(int $sizeBytes, bool $hasMergeStage = true): array
    {
        $sizeMb = max(0, $sizeBytes) / self::BYTES_PER_MB;
        $costs = [];

        foreach (self::STAGES as $stage) {
            if ($stage === 'merging' && ! $hasMergeStage) {
                continue;
            }

            $cost = config("videos.progress.stages.{$stage}", []);
            $costs[$stage] = max(0.0, (float) ($cost['fixed'] ?? 0) + (float) ($cost['per_mb'] ?? 0) * $sizeMb);
        }

        $total = array_sum($costs);

        if ($total <= 0) {
            $equal = 100 / count($costs);

            return array_map(fn (): float => $equal, $costs);
        }

        return array_map(fn (float $cost): float => $cost / $total * 100, $costs);
    }

    /**
     * Overall progress (integer percent) for being $stageFraction (0..1)
     * through $stage. The stage 'queued' means "upload finished, nothing else
     * started yet" and 'ready' is the only value that reaches 100; every
     * other stage is clamped to 0..99.
     */
    public static function overall(string $stage, float $stageFraction, int $sizeBytes, bool $hasMergeStage = true): int
    {
        if ($stage === 'ready') {
            return 100;
        }

        $weights = self::weights($sizeBytes, $hasMergeStage);

        if ($stage === 'queued') {
            $stage = 'upload';
            $stageFraction = 1.0;
        } elseif (! array_key_exists($stage, $weights)) {
            throw new InvalidArgumentException("Unknown progress stage '{$stage}'.");
        }

        $before = 0.0;

        foreach ($weights as $name => $weight) {
            if ($name === $stage) {
                break;
            }

            $before += $weight;
        }

        $fraction = min(1.0, max(0.0, $stageFraction));

        return (int) min(99, max(0, floor($before + $weights[$stage] * $fraction)));
    }
}
