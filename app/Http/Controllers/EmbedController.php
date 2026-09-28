<?php

namespace App\Http\Controllers;

use App\Models\Setting;
use App\Models\Video;

class EmbedController extends Controller
{
    /**
     * Display a standalone player page for embedding a video via iframe.
     */
    public function show(Video $video)
    {
        if ($video->status !== 'ready') {
            abort(404);
        }

        $disk = Setting::current()->r2Disk();

        $playlistUrl = $disk->url($video->playlist_path);
        $thumbnailUrl = $video->thumbnail_path ? $disk->url($video->thumbnail_path) : null;

        $storyboards = $video->storyboards ?? [];
        $tileSize = config('videos.storyboard_tile_size');
        $storyboardThumbnails = null;

        foreach ([5, 4, 3] as $size) {
            $entry = $storyboards["{$size}x{$size}"] ?? null;

            if ($entry && ! empty($entry['path'])) {
                $storyboardThumbnails = [
                    'url' => $disk->url($entry['path']),
                    'number' => $size * $size,
                    'column' => $size,
                    'width' => $tileSize,
                    'height' => $tileSize,
                ];

                break;
            }
        }

        return view('embed.show', compact('video', 'playlistUrl', 'thumbnailUrl', 'storyboardThumbnails'));
    }

    /**
     * Display a standalone Video.js player page for embedding a video via iframe.
     */
    public function showVideoJs(Video $video)
    {
        if ($video->status !== 'ready') {
            abort(404);
        }

        $disk = Setting::current()->r2Disk();

        $playlistUrl = $disk->url($video->playlist_path);
        $thumbnailUrl = $video->thumbnail_path ? $disk->url($video->thumbnail_path) : null;

        $storyboards = $video->storyboards ?? [];
        $tileSize = config('videos.storyboard_tile_size');
        $spriteThumbnails = null;

        foreach ([5, 4, 3] as $size) {
            $entry = $storyboards["{$size}x{$size}"] ?? null;

            if ($entry && ! empty($entry['path'])) {
                $totalTiles = $size * $size;

                if ($video->duration && $video->duration > 0 && $totalTiles > 0) {
                    $spriteThumbnails = [
                        'url' => $disk->url($entry['path']),
                        'width' => $tileSize,
                        'height' => $tileSize,
                        'columns' => $size,
                        'rows' => $size,
                        'interval' => (float) $video->duration / $totalTiles,
                    ];
                }

                break;
            }
        }

        return view('embed.videojs', compact('video', 'playlistUrl', 'thumbnailUrl', 'spriteThumbnails'));
    }
}
