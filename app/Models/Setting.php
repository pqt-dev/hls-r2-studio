<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Storage;

class Setting extends Model
{
    protected $fillable = [
        'r2_access_key_id',
        'r2_secret_access_key',
        'r2_bucket',
        'r2_endpoint',
        'r2_url',
        'delete_from_r2_on_destroy',
        'transcode_resolution',
        'transcode_segment_seconds',
        'transcode_fps',
        'videos_per_page',
        'display_timezone',
    ];

    protected $casts = [
        'r2_secret_access_key' => 'encrypted',
        'delete_from_r2_on_destroy' => 'boolean',
        'transcode_segment_seconds' => 'integer',
        'transcode_fps' => 'integer',
        'videos_per_page' => 'integer',
    ];

    public static function current(): self
    {
        return static::firstOrCreate(['id' => 1], [
            'delete_from_r2_on_destroy' => true,
            'transcode_resolution' => '720',
            'transcode_segment_seconds' => 6,
            'videos_per_page' => 24,
            'display_timezone' => 'Asia/Ho_Chi_Minh',
        ]);
    }

    public function effectiveR2Config(): array
    {
        $base = config('filesystems.disks.r2');
        $fields = ['r2_access_key_id' => 'key', 'r2_bucket' => 'bucket', 'r2_endpoint' => 'endpoint', 'r2_url' => 'url'];
        $result = [];
        foreach ($fields as $dbField => $envKey) {
            $dbValue = $this->{$dbField};
            $result[$dbField] = [
                'value' => $dbValue ?: ($base[$envKey] ?? null),
                'from_db' => (bool) $dbValue,
            ];
        }
        $result['r2_secret_access_key'] = ['from_db' => (bool) $this->r2_secret_access_key];

        return $result;
    }

    public function r2Disk()
    {
        $base = config('filesystems.disks.r2');

        return Storage::build([
            'driver' => 's3',
            'key' => $this->r2_access_key_id ?: $base['key'],
            'secret' => $this->r2_secret_access_key ?: $base['secret'],
            'region' => 'auto',
            'bucket' => $this->r2_bucket ?: $base['bucket'],
            'endpoint' => $this->r2_endpoint ?: $base['endpoint'],
            'url' => $this->r2_url ?: $base['url'],
            'use_path_style_endpoint' => true,
        ]);
    }
}
