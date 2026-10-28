<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Schema;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class EmbedAllowlistCorsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        // Start every test from an env-only config with no extras, whatever the local .env says.
        config([
            'cors.allowed_origins' => [],
            'cors.allowed_origins_patterns' => [],
            'videos.report_allowed_hosts' => [],
        ]);
    }

    private function setEmbedAllowlist(string $text): void
    {
        Setting::current()->update(['embed_allowed_domains' => $text]);
    }

    private function preflight(string $origin): TestResponse
    {
        return $this->withHeaders([
            'Origin' => $origin,
            'Access-Control-Request-Method' => 'POST',
        ])->options('/api/reports');
    }

    private function postReport(string $origin, string $pageUrl = 'https://www.main-site.com/some-post'): TestResponse
    {
        return $this->withHeaders(['Origin' => $origin])->postJson('/api/reports', ['page_url' => $pageUrl]);
    }

    public function test_listed_origin_is_allowed_for_preflight_and_post(): void
    {
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com");

        $this->preflight('https://www.main-site.com')
            ->assertNoContent()
            ->assertHeader('Access-Control-Allow-Origin', 'https://www.main-site.com');

        $this->postReport('https://www.main-site.com')
            ->assertStatus(201)
            ->assertHeader('Access-Control-Allow-Origin', 'https://www.main-site.com');
    }

    public function test_unlisted_origin_gets_no_allow_origin_header(): void
    {
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com");

        $this->preflight('https://evil.example.com')->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->postReport('https://evil.example.com')->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_http_origin_is_not_allowed_for_an_entry_without_scheme(): void
    {
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com");

        $this->preflight('http://www.main-site.com')->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_env_origin_still_works_alongside_the_settings_list(): void
    {
        config(['cors.allowed_origins' => ['https://env-site.com']]);
        $this->setEmbedAllowlist('main-site.com');

        $this->preflight('https://env-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://env-site.com');
        $this->preflight('https://main-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://main-site.com');
        $this->preflight('https://evil.example.com')->assertHeaderMissing('Access-Control-Allow-Origin');

        $this->assertSame(['https://env-site.com', 'https://main-site.com'], config('cors.allowed_origins'));
    }

    public function test_env_only_config_works_without_settings_list(): void
    {
        config(['cors.allowed_origins' => ['https://env-site.com', 'https://www.env-site.com']]);

        $this->preflight('https://env-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://env-site.com');
        $this->preflight('https://evil.example.com')->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_merge_is_idempotent_and_follows_list_changes(): void
    {
        config(['cors.allowed_origins' => ['https://env-site.com']]);
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com");

        $this->preflight('https://main-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://main-site.com');
        $this->preflight('https://main-site.com');

        $this->setEmbedAllowlist('www.main-site.com');

        $this->preflight('https://main-site.com')->assertHeaderMissing('Access-Control-Allow-Origin');
        $this->assertSame(['https://env-site.com', 'https://www.main-site.com'], config('cors.allowed_origins'));
    }

    public function test_wildcard_entry_allows_subdomains_but_not_the_apex(): void
    {
        $this->setEmbedAllowlist('*.main-site.com');

        $this->preflight('https://blog.main-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://blog.main-site.com');
        $this->preflight('https://main-site.com')->assertHeaderMissing('Access-Control-Allow-Origin');
    }

    public function test_report_host_from_settings_list_is_accepted(): void
    {
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com");

        $this->postJson('/api/reports', ['page_url' => 'https://www.main-site.com/some-post'])->assertStatus(201);
    }

    public function test_report_host_outside_settings_list_is_rejected(): void
    {
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com");

        $this->postJson('/api/reports', ['page_url' => 'https://evil.example.com/some-post'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('page_url');
        $this->postJson('/api/reports', ['page_url' => 'https://blog.main-site.com/some-post'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('page_url');

        $this->assertDatabaseCount('reports', 0);
    }

    public function test_report_host_matching_a_wildcard_entry_is_accepted(): void
    {
        $this->setEmbedAllowlist('*.main-site.com');

        $this->postJson('/api/reports', ['page_url' => 'https://blog.main-site.com/some-post'])->assertStatus(201);
        $this->postJson('/api/reports', ['page_url' => 'https://main-site.com/some-post'])
            ->assertStatus(422)
            ->assertJsonValidationErrors('page_url');
    }

    public function test_report_host_from_env_is_accepted_alongside_the_settings_list(): void
    {
        config(['videos.report_allowed_hosts' => ['env-site.com']]);
        $this->setEmbedAllowlist('main-site.com');

        $this->postJson('/api/reports', ['page_url' => 'https://env-site.com/a'])->assertStatus(201);
        $this->postJson('/api/reports', ['page_url' => 'https://main-site.com/b'])->assertStatus(201);
        $this->postJson('/api/reports', ['page_url' => 'https://evil.example.com/c'])->assertStatus(422);
    }

    public function test_env_report_hosts_stay_exact_match(): void
    {
        config(['videos.report_allowed_hosts' => ['*.env-site.com']]);

        $this->postJson('/api/reports', ['page_url' => 'https://blog.env-site.com/a'])->assertStatus(422);
    }

    public function test_env_only_report_hosts_still_work(): void
    {
        config(['videos.report_allowed_hosts' => ['env-site.com']]);

        $this->postJson('/api/reports', ['page_url' => 'https://env-site.com/a'])->assertStatus(201);
        $this->postJson('/api/reports', ['page_url' => 'https://evil.example.com/b'])->assertStatus(422);
    }

    public function test_report_host_is_unrestricted_when_both_lists_are_empty(): void
    {
        config(['videos.report_allowed_hosts' => []]);
        $this->setEmbedAllowlist('');

        $this->postJson('/api/reports', ['page_url' => 'https://anything.example.com/a'])->assertStatus(201);
    }

    public function test_missing_settings_row_falls_back_to_env_and_is_not_created(): void
    {
        config(['cors.allowed_origins' => ['https://env-site.com', 'https://www.env-site.com']]);
        $this->assertDatabaseCount('settings', 0);

        $this->preflight('https://env-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://env-site.com');
        $this->postReport('https://env-site.com', 'https://anything.example.com/a')->assertStatus(201);

        $this->assertDatabaseCount('settings', 0);
    }

    public function test_missing_settings_table_falls_back_to_env_without_error(): void
    {
        config(['cors.allowed_origins' => ['https://env-site.com', 'https://www.env-site.com']]);
        Schema::drop('settings');

        $this->preflight('https://env-site.com')->assertHeader('Access-Control-Allow-Origin', 'https://env-site.com');
        $this->postReport('https://env-site.com', 'https://anything.example.com/a')->assertStatus(201);
        $this->assertNull(Setting::findWithoutCreating());
        $this->assertFalse(Schema::hasTable('settings'));
    }

    public function test_non_api_routes_do_not_merge_cors_config(): void
    {
        $this->setEmbedAllowlist('main-site.com');

        $this->get('/login')->assertOk();

        $this->assertSame([], config('cors.allowed_origins'));
        $this->assertSame([], config('cors.allowed_origins_patterns'));
        $this->assertFalse(config()->has('cors.embed_allowlist_base_allowed_origins'));
    }

    public function test_embed_csp_is_unchanged_by_the_embed_allowlist(): void
    {
        $this->setEmbedAllowlist("main-site.com\nwww.main-site.com\n*.main-site.com\nhttps://host:8443\nhttp://host");

        $video = Video::create([
            'title' => 'Embed me',
            'original_filename' => 'embed.mp4',
            'status' => 'ready',
            'disk_prefix' => '2026/10/07/embed-1/',
            'playlist_path' => '2026/10/07/embed-1/playlist.m3u8',
        ]);

        $this->get(route('embed.show', $video))
            ->assertOk()
            ->assertHeader('Content-Security-Policy', "frame-ancestors 'self' main-site.com www.main-site.com *.main-site.com https://host:8443 http://host");
    }
}
