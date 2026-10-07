<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Builder;
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
        'storyboards',
        'custom_image_path',
        'duration',
        'error_message',
        'error_detail',
        'failed_at',
        'upload_id',
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
        'storyboards' => 'array',
        'failed_at' => 'datetime',
    ];

    /**
     * Videos that are still queued or being transcoded.
     */
    public function scopeInProgress(Builder $query): Builder
    {
        return $query->whereIn('status', ['pending', 'processing']);
    }

    /**
     * Compact list of queued/processing videos (id, status, progress, upload_id) for the floating progress ring.
     *
     * @return list<array{id: int, status: string, progress: int, upload_id: string|null}>
     */
    public static function inProgressSnapshot(int $limit = 100): array
    {
        return static::inProgress()
            ->orderBy('id')
            ->limit($limit)
            ->get(['id', 'status', 'progress', 'upload_id'])
            ->map(fn (Video $video) => [
                'id' => $video->id,
                'status' => $video->status,
                'progress' => max(0, min(100, (int) $video->progress)),
                'upload_id' => $video->upload_id,
            ])
            ->all();
    }

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
