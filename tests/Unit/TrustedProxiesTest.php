<?php

namespace Tests\Unit;

use App\Support\TrustedProxies;
use PHPUnit\Framework\TestCase;

class TrustedProxiesTest extends TestCase
{
    public function test_wildcard_stays_wildcard(): void
    {
        $this->assertSame('*', TrustedProxies::resolve('*'));
        $this->assertSame('*', TrustedProxies::resolve('  * '));
    }

    public function test_cloudflare_keyword_expands_to_the_cloudflare_ranges(): void
    {
        $this->assertSame(TrustedProxies::CLOUDFLARE_RANGES, TrustedProxies::resolve('cloudflare'));
    }

    public function test_cloudflare_keyword_is_case_insensitive(): void
    {
        $this->assertSame(TrustedProxies::CLOUDFLARE_RANGES, TrustedProxies::resolve('Cloudflare'));
        $this->assertSame(TrustedProxies::CLOUDFLARE_RANGES, TrustedProxies::resolve(' CLOUDFLARE '));
    }

    public function test_cloudflare_can_be_combined_with_extra_entries(): void
    {
        $result = TrustedProxies::resolve('cloudflare,127.0.0.1');

        foreach (TrustedProxies::CLOUDFLARE_RANGES as $range) {
            $this->assertContains($range, $result);
        }
        $this->assertContains('127.0.0.1', $result);
        $this->assertSame(count(TrustedProxies::CLOUDFLARE_RANGES) + 1, count($result));
    }

    public function test_plain_list_is_unchanged(): void
    {
        $this->assertSame(['10.0.0.1', '10.0.0.2'], TrustedProxies::resolve('10.0.0.1, 10.0.0.2'));
    }

    public function test_remote_addr_passes_through(): void
    {
        $this->assertSame(['REMOTE_ADDR'], TrustedProxies::resolve('REMOTE_ADDR'));
    }

    public function test_empty_string_resolves_to_an_empty_array(): void
    {
        $this->assertSame([], TrustedProxies::resolve(''));
        $this->assertSame([], TrustedProxies::resolve(' , '));
    }

    public function test_duplicates_are_removed_and_list_is_reindexed(): void
    {
        $this->assertSame(['10.0.0.1', '10.0.0.2'], TrustedProxies::resolve('10.0.0.1,10.0.0.2,10.0.0.1'));
        $this->assertSame(TrustedProxies::CLOUDFLARE_RANGES, TrustedProxies::resolve('cloudflare,173.245.48.0/20,cloudflare'));
    }
}
