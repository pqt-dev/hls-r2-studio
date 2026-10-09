<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Facades\Storage;

class Setting extends Model
{
    protected $fillable = [
        'delete_from_r2_on_destroy',
        'transcode_resolution',
        'transcode_segment_seconds',
        'transcode_fps',
        'display_timezone',
        'embed_allowed_domains',
    ];

    protected $casts = [
        'delete_from_r2_on_destroy' => 'boolean',
        'transcode_segment_seconds' => 'integer',
        'transcode_fps' => 'integer',
    ];

    public static function current(): self
    {
        $settings = static::find(1);

        if (! $settings) {
            $settings = (new static)->forceFill([
                'id' => 1,
                'delete_from_r2_on_destroy' => true,
                'transcode_resolution' => '720',
                'transcode_segment_seconds' => 6,
                'display_timezone' => 'Asia/Ho_Chi_Minh',
            ]);
            $settings->save();
        }

        return $settings;
    }

    public const EMBED_MAX_ENTRIES = 50;

    public const EMBED_MAX_ENTRY_LENGTH = 255;

    private const EMBED_ENTRY_PATTERN = '/^(?:https?:\/\/)?(?:\*\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[0-9]{1,5})?$/D';

    /**
     * Split raw text (one entry per line, commas tolerated) into unique,
     * lowercased CSP-safe entries and the entries that failed validation.
     *
     * @return array{valid: list<string>, invalid: list<string>}
     */
    public static function parseEmbedEntries(?string $text): array
    {
        $valid = [];
        $invalid = [];

        foreach (preg_split('/[\r\n,]+/', (string) $text) as $raw) {
            $entry = trim($raw);

            if ($entry === '') {
                continue;
            }

            $entry = strtolower($entry);

            if (strlen($entry) <= self::EMBED_MAX_ENTRY_LENGTH && preg_match(self::EMBED_ENTRY_PATTERN, $entry) === 1) {
                $valid[$entry] = $entry;
            } else {
                $invalid[$raw] = $raw;
            }
        }

        return ['valid' => array_values($valid), 'invalid' => array_values($invalid)];
    }

    /**
     * Valid CSP frame-ancestors source expressions from the stored allowlist.
     *
     * @return list<string>
     */
    public function embedAllowedOrigins(): array
    {
        return array_slice(self::parseEmbedEntries($this->embed_allowed_domains)['valid'], 0, self::EMBED_MAX_ENTRIES);
    }

    public function r2Disk()
    {
        $base = config('filesystems.disks.r2');

        return Storage::build([
            'driver' => 's3',
            'key' => $base['key'],
            'secret' => $base['secret'],
            'region' => 'auto',
            'bucket' => $base['bucket'],
            'endpoint' => $base['endpoint'],
            'url' => $base['url'],
            'use_path_style_endpoint' => true,
        ]);
    }
}
