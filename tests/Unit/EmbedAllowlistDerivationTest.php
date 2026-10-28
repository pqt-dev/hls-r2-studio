<?php

namespace Tests\Unit;

use App\Models\Setting;
use PHPUnit\Framework\TestCase;

class EmbedAllowlistDerivationTest extends TestCase
{
    private const LIST = "main-site.com\nwww.main-site.com\n*.main-site.com\nhttps://host:8443\nhttp://host";

    public function test_empty_list_derives_nothing(): void
    {
        foreach ([null, '', "  \n , \r\n"] as $text) {
            $this->assertSame([], Setting::embedAllowlistCorsOrigins($text));
            $this->assertSame([], Setting::embedAllowlistCorsPatterns($text));
            $this->assertSame([], Setting::embedAllowlistReportHosts($text));
        }
    }

    public function test_cors_origins_default_to_https_and_keep_explicit_schemes(): void
    {
        $this->assertSame(
            ['https://main-site.com', 'https://www.main-site.com', 'https://host:8443', 'http://host'],
            Setting::embedAllowlistCorsOrigins(self::LIST)
        );
    }

    public function test_cors_origin_without_scheme_keeps_its_port(): void
    {
        $this->assertSame(['https://main-site.com:8443'], Setting::embedAllowlistCorsOrigins('main-site.com:8443'));
    }

    public function test_wildcard_becomes_a_pattern_for_subdomains_only(): void
    {
        $patterns = Setting::embedAllowlistCorsPatterns(self::LIST);

        $this->assertCount(1, $patterns);
        $this->assertSame('#^https\://(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+main\-site\.com$#D', $patterns[0]);

        $this->assertMatchesPattern($patterns, 'https://blog.main-site.com');
        $this->assertMatchesPattern($patterns, 'https://a.b.main-site.com');
        $this->assertNotMatchesPattern($patterns, 'https://main-site.com');
        $this->assertNotMatchesPattern($patterns, 'http://blog.main-site.com');
        $this->assertNotMatchesPattern($patterns, 'https://blog.main-site.com:8443');
        $this->assertNotMatchesPattern($patterns, 'https://blogmain-site.com');
        $this->assertNotMatchesPattern($patterns, 'https://blog.main-sitexcom');
        $this->assertNotMatchesPattern($patterns, 'https://main-site.com.evil.com');
        $this->assertNotMatchesPattern($patterns, "https://blog.main-site.com\n");
    }

    public function test_wildcard_with_scheme_and_port_keeps_them(): void
    {
        $patterns = Setting::embedAllowlistCorsPatterns("http://*.main-site.com:8080\n*.other.com:8443");

        $this->assertCount(2, $patterns);
        $this->assertMatchesPattern([$patterns[0]], 'http://blog.main-site.com:8080');
        $this->assertNotMatchesPattern([$patterns[0]], 'https://blog.main-site.com:8080');
        $this->assertNotMatchesPattern([$patterns[0]], 'http://blog.main-site.com');
        $this->assertMatchesPattern([$patterns[1]], 'https://blog.other.com:8443');
        $this->assertNotMatchesPattern([$patterns[1]], 'https://blog.other.com');
    }

    public function test_wildcards_are_never_exact_origins(): void
    {
        $this->assertSame([], Setting::embedAllowlistCorsOrigins("*.main-site.com\nhttps://*.other.com"));
    }

    public function test_report_hosts_drop_scheme_and_port(): void
    {
        $this->assertSame(
            ['main-site.com', 'www.main-site.com', '*.main-site.com', 'host'],
            Setting::embedAllowlistReportHosts(self::LIST)
        );
        $this->assertSame(['*.main-site.com'], Setting::embedAllowlistReportHosts('http://*.main-site.com:8080'));
    }

    public function test_report_host_matching(): void
    {
        $hosts = Setting::embedAllowlistReportHosts("main-site.com\n*.blog.com");

        $this->assertTrue(Setting::embedAllowlistHostMatches('main-site.com', $hosts));
        $this->assertTrue(Setting::embedAllowlistHostMatches('MAIN-SITE.com', $hosts));
        $this->assertFalse(Setting::embedAllowlistHostMatches('www.main-site.com', $hosts));
        $this->assertTrue(Setting::embedAllowlistHostMatches('a.blog.com', $hosts));
        $this->assertTrue(Setting::embedAllowlistHostMatches('a.b.blog.com', $hosts));
        $this->assertFalse(Setting::embedAllowlistHostMatches('blog.com', $hosts));
        $this->assertFalse(Setting::embedAllowlistHostMatches('evilblog.com', $hosts));
        $this->assertFalse(Setting::embedAllowlistHostMatches('blog.com.evil.com', $hosts));
        $this->assertFalse(Setting::embedAllowlistHostMatches('', $hosts));
        $this->assertFalse(Setting::embedAllowlistHostMatches('main-site.com', []));
    }

    public function test_duplicates_and_uppercase_are_normalized(): void
    {
        $text = "Main-Site.com\nmain-site.com, HTTPS://MAIN-SITE.COM\n*.Main-Site.com\n*.main-site.com\nhttp://main-site.com:80";

        $this->assertSame(['https://main-site.com', 'http://main-site.com:80'], Setting::embedAllowlistCorsOrigins($text));
        $this->assertCount(1, Setting::embedAllowlistCorsPatterns($text));
        $this->assertSame(['main-site.com', '*.main-site.com'], Setting::embedAllowlistReportHosts($text));
    }

    public function test_invalid_entries_are_ignored(): void
    {
        $text = "foo bar\nhttps://a.com/path\na.com; script-src *\n*\n'none'\nftp://b.com\nmain-site.com";

        $this->assertSame(['https://main-site.com'], Setting::embedAllowlistCorsOrigins($text));
        $this->assertSame([], Setting::embedAllowlistCorsPatterns($text));
        $this->assertSame(['main-site.com'], Setting::embedAllowlistReportHosts($text));
    }

    public function test_more_than_the_entry_limit_is_truncated(): void
    {
        $text = implode("\n", array_map(fn ($i) => "d{$i}.example.com", range(1, Setting::EMBED_MAX_ENTRIES + 5)));

        $origins = Setting::embedAllowlistCorsOrigins($text);
        $hosts = Setting::embedAllowlistReportHosts($text);

        $this->assertCount(Setting::EMBED_MAX_ENTRIES, $origins);
        $this->assertCount(Setting::EMBED_MAX_ENTRIES, $hosts);
        $this->assertSame('https://d50.example.com', end($origins));
        $this->assertNotContains('d51.example.com', $hosts);
    }

    /**
     * @param  list<string>  $patterns
     */
    private function assertMatchesPattern(array $patterns, string $origin): void
    {
        $this->assertTrue($this->anyPatternMatches($patterns, $origin), "Expected {$origin} to match.");
    }

    /**
     * @param  list<string>  $patterns
     */
    private function assertNotMatchesPattern(array $patterns, string $origin): void
    {
        $this->assertFalse($this->anyPatternMatches($patterns, $origin), "Expected {$origin} not to match.");
    }

    /**
     * @param  list<string>  $patterns
     */
    private function anyPatternMatches(array $patterns, string $origin): bool
    {
        foreach ($patterns as $pattern) {
            if (preg_match($pattern, $origin) === 1) {
                return true;
            }
        }

        return false;
    }
}
