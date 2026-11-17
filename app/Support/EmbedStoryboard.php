<?php

namespace App\Support;

use Illuminate\Contracts\Filesystem\Filesystem;

/**
 * Picks the storyboard grid the embed player uses for seek thumbnails: the largest generated one.
 */
final class EmbedStoryboard
{
    /**
     * @param  array<string, mixed>|null  $storyboards  the video's `storyboards` column
     * @param  Filesystem  $disk
     * @return array{url: string, number: int, column: int, width: int, height: int}|null
     */
    public static function pick(?array $storyboards, $disk): ?array
    {
        $storyboards ??= [];
        $tileSize = config('videos.storyboard_tile_size');

        foreach ([5, 4, 3] as $size) {
            $entry = $storyboards["{$size}x{$size}"] ?? null;

            if ($entry && ! empty($entry['path'])) {
                return [
                    'url' => $disk->url($entry['path']),
                    'number' => $size * $size,
                    'column' => $size,
                    'width' => $tileSize,
                    'height' => $tileSize,
                ];
            }
        }

        return null;
    }
}
