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

    /**
     * Read-only lookup of the settings row: never creates it and never
     * throws, so it is safe before migrations ran or while the DB is down.
     */
    public static function findWithoutCreating(): ?self
    {
        try {
            return static::query()->find(1);
        } catch (\Throwable) {
            return null;
        }
    }

    /**
     * The validated, lowercased embed allowlist entries,
     * capped at the entry limit.
     *
     * @return list<string>
     */
    public static function embedAllowlistEntries(?string $text): array
    {
        return array_slice(self::parseEmbedEntries($text)['valid'], 0, self::EMBED_MAX_ENTRIES);
    }

    /**
     * Exact CORS origins derived from the embed allowlist: entries without
     * a scheme become https://host[:port], entries with a scheme are kept as
     * given. Wildcard entries are handled by embedAllowlistCorsPatterns().
     *
     * @return list<string>
     */
    public static function embedAllowlistCorsOrigins(?string $text): array
    {
        $origins = [];

        foreach (self::embedAllowlistEntries($text) as $entry) {
            [$scheme, $hostPort] = self::splitScheme($entry);

            if (str_starts_with($hostPort, '*.')) {
                continue;
            }

            $origin = ($scheme ?? 'https').'://'.$hostPort;
            $origins[$origin] = $origin;
        }

        return array_values($origins);
    }

    /**
     * CORS origin regex patterns for wildcard embed allowlist entries: *.host[:port]
     * matches one or more subdomain labels of host (never the apex itself),
     * using the entry's scheme or https by default.
     *
     * @return list<string>
     */
    public static function embedAllowlistCorsPatterns(?string $text): array
    {
        $patterns = [];

        foreach (self::embedAllowlistEntries($text) as $entry) {
            [$scheme, $hostPort] = self::splitScheme($entry);

            if (! str_starts_with($hostPort, '*.')) {
                continue;
            }

            $pattern = '#^'.preg_quote(($scheme ?? 'https').'://', '#')
                .'(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+'
                .preg_quote(substr($hostPort, 2), '#').'$#D';
            $patterns[$pattern] = $pattern;
        }

        return array_values($patterns);
    }

    /**
     * Hosts accepted in a report's page URL, derived from the embed
     * allowlist entries with scheme and port removed. Wildcard entries keep their
     * "*." prefix; see embedAllowlistHostMatches().
     *
     * @return list<string>
     */
    public static function embedAllowlistReportHosts(?string $text): array
    {
        $hosts = [];

        foreach (self::embedAllowlistEntries($text) as $entry) {
            $host = preg_replace('/:[0-9]+$/', '', self::splitScheme($entry)[1]);
            $hosts[$host] = $host;
        }

        return array_values($hosts);
    }

    /**
     * Whether a host matches one of the embed allowlist report hosts: exact entries
     * match the host exactly, *.host matches any subdomain of host but not host.
     *
     * @param  list<string>  $allowlistHosts
     */
    public static function embedAllowlistHostMatches(string $host, array $allowlistHosts): bool
    {
        $host = strtolower($host);

        if ($host === '') {
            return false;
        }

        foreach ($allowlistHosts as $allowed) {
            if (str_starts_with($allowed, '*.')) {
                if (str_ends_with($host, substr($allowed, 1)) && strlen($host) > strlen($allowed) - 1) {
                    return true;
                }
            } elseif ($host === $allowed) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return array{0: ?string, 1: string} The scheme (null when absent) and the rest of the entry.
     */
    private static function splitScheme(string $entry): array
    {
        if (preg_match('#^(https?)://(.+)$#', $entry, $matches) === 1) {
            return [$matches[1], $matches[2]];
        }

        return [null, $entry];
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
