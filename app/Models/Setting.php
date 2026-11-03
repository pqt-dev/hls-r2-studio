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
        'r2_access_key_id',
        'r2_secret_access_key',
        'r2_bucket',
        'r2_endpoint',
        'r2_url',
    ];

    protected $hidden = [
        'r2_access_key_id',
        'r2_secret_access_key',
    ];

    protected $casts = [
        'delete_from_r2_on_destroy' => 'boolean',
        'transcode_segment_seconds' => 'integer',
        'transcode_fps' => 'integer',
        'r2_access_key_id' => 'encrypted',
        'r2_secret_access_key' => 'encrypted',
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

    /**
     * The R2 values stored in the DB, or null unless all five are present
     * and decryptable (a changed APP_KEY counts as not configured).
     *
     * @return array{key: string, secret: string, bucket: string, endpoint: string, url: string}|null
     */
    private function storedR2Config(): ?array
    {
        try {
            $config = [
                'key' => $this->r2_access_key_id,
                'secret' => $this->r2_secret_access_key,
                'bucket' => $this->r2_bucket,
                'endpoint' => $this->r2_endpoint,
                'url' => $this->r2_url,
            ];
        } catch (\Throwable) {
            return null;
        }

        foreach ($config as $value) {
            if (! is_string($value) || trim($value) === '') {
                return null;
            }
        }

        return $config;
    }

    /**
     * A decrypted R2 credential column, or null when empty or undecryptable.
     */
    private function readR2Credential(string $column): ?string
    {
        try {
            $value = $this->{$column};
        } catch (\Throwable) {
            return null;
        }

        return is_string($value) && trim($value) !== '' ? $value : null;
    }

    /**
     * Last 4 characters of the stored access key id, null when none is stored.
     */
    public function r2AccessKeyLast4(): ?string
    {
        $key = $this->readR2Credential('r2_access_key_id');

        return $key === null ? null : mb_substr($key, -4);
    }

    public function hasR2Secret(): bool
    {
        return $this->readR2Credential('r2_secret_access_key') !== null;
    }

    /**
     * Whether the DB holds a complete, decryptable R2 config.
     */
    public function hasR2Config(): bool
    {
        return $this->storedR2Config() !== null;
    }

    /**
     * Disk definition for R2: DB values when complete, otherwise the env config.
     *
     * @return array<string, mixed>
     */
    public function r2DiskConfig(): array
    {
        $base = $this->storedR2Config() ?? config('filesystems.disks.r2');

        return [
            'driver' => 's3',
            'key' => $base['key'],
            'secret' => $base['secret'],
            'region' => 'auto',
            'bucket' => $base['bucket'],
            'endpoint' => $base['endpoint'],
            'url' => $base['url'],
            'use_path_style_endpoint' => true,
        ];
    }

    public function r2Disk()
    {
        return Storage::build($this->r2DiskConfig());
    }
}
