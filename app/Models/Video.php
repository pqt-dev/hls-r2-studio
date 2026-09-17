<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Video extends Model
{
    protected $fillable = [
        'title',
        'original_filename',
        'original_size_bytes',
        'status',
        'stage',
        'progress',
        'disk_prefix',
        'playlist_path',
        'thumbnail_path',
        'storyboard_path',
        'storyboard_meta_path',
        'duration',
        'error_message',
        'output_width',
        'output_height',
        'output_fps',
        'output_bitrate_kbps',
        'output_codec',
    ];

    protected $casts = [
        'duration' => 'float',
        'progress' => 'integer',
        'original_size_bytes' => 'integer',
        'output_width' => 'integer',
        'output_height' => 'integer',
        'output_fps' => 'float',
        'output_bitrate_kbps' => 'integer',
    ];

    public function getFormattedSizeAttribute(): string
    {
        if (! $this->original_size_bytes) {
            return '—';
        }

        $bytes = $this->original_size_bytes;

        if ($bytes >= 1024 ** 3) {
            return number_format($bytes / 1024 ** 3, 2).' GB';
        }

        if ($bytes >= 1024 ** 2) {
            return number_format($bytes / 1024 ** 2, 2).' MB';
        }

        return number_format($bytes / 1024, 2).' KB';
    }
}
