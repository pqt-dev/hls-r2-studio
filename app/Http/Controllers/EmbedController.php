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

        return view('embed.show', compact('video', 'playlistUrl', 'thumbnailUrl'));
    }
}
