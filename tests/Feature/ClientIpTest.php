<?php

namespace Tests\Feature;

use App\Support\TrustedProxies;
use Illuminate\Http\Middleware\TrustProxies;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class ClientIpTest extends TestCase
{
    private const FORWARDED_FOR = '6.6.6.6, 9.9.9.9';

    protected function setUp(): void
    {
        parent::setUp();

        Route::get('/_test/client-ip', fn () => response(request()->ip()));
    }

    protected function tearDown(): void
    {
        TrustProxies::at(config('app.trusted_proxies'));

        parent::tearDown();
    }

    private function fetchIp(string $remoteAddr): string
    {
        return $this->withServerVariables(['REMOTE_ADDR' => $remoteAddr])
            ->withHeaders(['X-Forwarded-For' => self::FORWARDED_FOR])
            ->get('/_test/client-ip')
            ->assertOk()
            ->getContent();
    }

    public function test_forwarded_for_is_honoured_from_a_cloudflare_proxy(): void
    {
        TrustProxies::at(TrustedProxies::resolve('cloudflare'));

        $this->assertSame('9.9.9.9', $this->fetchIp('173.245.48.5'));
    }

    public function test_forwarded_for_is_ignored_from_a_non_cloudflare_proxy(): void
    {
        TrustProxies::at(TrustedProxies::resolve('cloudflare'));

        $this->assertSame('203.0.113.7', $this->fetchIp('203.0.113.7'));
    }

    public function test_wildcard_trusts_a_spoofed_leftmost_forwarded_for_value(): void
    {
        TrustProxies::at(TrustedProxies::resolve('*'));

        $this->assertSame('6.6.6.6', $this->fetchIp('173.245.48.5'));
    }
}
