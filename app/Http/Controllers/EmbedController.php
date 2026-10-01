<?php

namespace App\Http\Controllers;

use App\Models\Setting;
use App\Models\Video;
use Illuminate\Http\Request;

class EmbedController extends Controller
{
    /**
     * Display a standalone player page for embedding a video via iframe.
     */
    public function show(Request $request, Video $video)
    {
        if ($video->status !== 'ready') {
            abort(404);
        }

        $disk = Setting::current()->r2Disk();

        $playlistUrl = $disk->url($video->playlist_path);

        $autoplay = $request->boolean('autoplay');
        $muted = $request->boolean('muted') || $autoplay; // browsers require muted for unattended autoplay to actually work

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

        return view('embed.show', compact('video', 'playlistUrl', 'storyboardThumbnails', 'autoplay', 'muted'));
    }
}
