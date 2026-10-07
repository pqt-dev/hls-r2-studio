<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SettingsEmbedProtectionTest extends TestCase
{
    use RefreshDatabase;

    private function makeReadyVideo(): Video
    {
        return Video::create([
            'title' => 'Embed me',
            'original_filename' => 'embed.mp4',
            'status' => 'ready',
            'disk_prefix' => '2026/10/07/embed-1/',
            'playlist_path' => '2026/10/07/embed-1/playlist.m3u8',
        ]);
    }

    public function test_guest_cannot_update_embed_settings(): void
    {
        $this->put('/settings/embed', ['embed_allowed_domains' => 'a.com'])->assertRedirect(route('login'));
    }

    public function test_embed_domains_are_saved_and_normalized(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $response = $this->put('/settings/embed', [
            'embed_allowed_domains' => " Example.com \r\n\r\n*.Example.org, https://a.com:8443\nexample.com\nhttp://localhost:3000",
        ]);

        $response->assertRedirect();
        $response->assertSessionHasNoErrors();
        $response->assertSessionHas('success');

        $this->assertSame(
            "example.com\n*.example.org\nhttps://a.com:8443\nhttp://localhost:3000",
            Setting::current()->embed_allowed_domains
        );
        $this->assertSame(
            ['example.com', '*.example.org', 'https://a.com:8443', 'http://localhost:3000'],
            Setting::current()->embedAllowedOrigins()
        );
    }

    public function test_empty_value_clears_the_allowlist(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
        Setting::current()->update(['embed_allowed_domains' => 'a.com']);

        $this->put('/settings/embed', ['embed_allowed_domains' => ''])->assertSessionHasNoErrors();

        $this->assertNull(Setting::current()->embed_allowed_domains);
    }

    public function test_invalid_entries_are_rejected(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        foreach (['foo bar', 'https://a.com/path', 'a.com; script-src *', '*', "'none'", 'a.com?x=1', '"a.com"', 'ftp://a.com'] as $bad) {
            $this->from('/settings')
                ->put('/settings/embed', ['embed_allowed_domains' => "ok.com\n".$bad])
                ->assertSessionHasErrors('embed_allowed_domains');
        }

        $this->assertNull(Setting::current()->embed_allowed_domains);
    }

    public function test_too_many_entries_are_rejected(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $lines = implode("\n", array_map(fn ($i) => "d{$i}.example.com", range(1, 51)));

        $this->from('/settings')
            ->put('/settings/embed', ['embed_allowed_domains' => $lines])
            ->assertSessionHasErrors('embed_allowed_domains');
    }

    public function test_embed_response_has_frame_ancestors_header_when_configured(): void
    {
        Setting::current()->update(['embed_allowed_domains' => "example.com\n*.example.org\nhttps://a.com:8443"]);

        $response = $this->get(route('embed.show', $this->makeReadyVideo()));

        $response->assertOk();
        $response->assertHeader('Content-Security-Policy', "frame-ancestors 'self' example.com *.example.org https://a.com:8443");
    }

    public function test_embed_response_has_no_csp_header_when_empty(): void
    {
        $response = $this->get(route('embed.show', $this->makeReadyVideo()));

        $response->assertOk();
        $response->assertHeaderMissing('Content-Security-Policy');
    }

    public function test_settings_page_renders_embed_section(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/settings')->assertOk()->assertSee('Embed protection');
    }
}
