<?php

namespace App\Support;

/**
 * Resolves the TRUSTED_PROXIES env value into the list Laravel's TrustProxies expects.
 */
final class TrustedProxies
{
    /**
     * Cloudflare's published edge IP ranges.
     *
     * Source: https://www.cloudflare.com/ips-v4, https://www.cloudflare.com/ips-v6 and
     * https://api.cloudflare.com/client/v4/ips (verified 2026-10-26). Cloudflare occasionally
     * adds ranges, so compare this list with https://www.cloudflare.com/ips/ from time to time.
     * Extra ranges can be appended via the env value, e.g. `cloudflare,203.0.113.0/24`.
     */
    public const CLOUDFLARE_RANGES = [
        // IPv4
        '173.245.48.0/20',
        '103.21.244.0/22',
        '103.22.200.0/22',
        '103.31.4.0/22',
        '141.101.64.0/18',
        '108.162.192.0/18',
        '190.93.240.0/20',
        '188.114.96.0/20',
        '197.234.240.0/22',
        '198.41.128.0/17',
        '162.158.0.0/15',
        '104.16.0.0/13',
        '104.24.0.0/14',
        '172.64.0.0/13',
        '131.0.72.0/22',
        // IPv6
        '2400:cb00::/32',
        '2606:4700::/32',
        '2803:f800::/32',
        '2405:b500::/32',
        '2405:8100::/32',
        '2a06:98c0::/29',
        '2c0f:f248::/32',
    ];

    /**
     * @return string|array<int, string> '*' to trust every proxy, otherwise a de-duplicated list of IPs/CIDRs.
     */
    public static function resolve(string $value): string|array
    {
        $value = trim($value);

        if ($value === '*') {
            return '*';
        }

        $entries = [];

        foreach (array_filter(array_map('trim', explode(',', $value))) as $entry) {
            if (strtolower($entry) === 'cloudflare') {
                array_push($entries, ...self::CLOUDFLARE_RANGES);
            } else {
                $entries[] = $entry;
            }
        }

        return array_values(array_unique($entries));
    }
}
