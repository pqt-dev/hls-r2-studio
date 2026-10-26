<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class RobotsTagTest extends TestCase
{
    use RefreshDatabase;

    private const TAG = 'noindex, nofollow, noarchive';

    public function test_login_page_has_robots_header_and_meta(): void
    {
        $response = $this->get('/login');

        $response->assertOk();
        $response->assertHeader('X-Robots-Tag', self::TAG);
        $response->assertSee('<meta name="robots" content="noindex, nofollow">', false);
    }

    public function test_guest_redirect_from_root_has_robots_header(): void
    {
        $response = $this->get('/');

        $response->assertRedirect(route('login'));
        $response->assertHeader('X-Robots-Tag', self::TAG);
    }

    public function test_unknown_url_404_has_robots_header(): void
    {
        $response = $this->get('/does-not-exist');

        $response->assertNotFound();
        $response->assertHeader('X-Robots-Tag', self::TAG);
    }

    public function test_health_endpoint_has_robots_header(): void
    {
        $response = $this->get('/up');

        $response->assertOk();
        $response->assertHeader('X-Robots-Tag', self::TAG);
    }

    public function test_authenticated_page_has_robots_header(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $response = $this->get('/settings');

        $response->assertOk();
        $response->assertHeader('X-Robots-Tag', self::TAG);
    }

    public function test_embed_page_keeps_its_own_robots_header(): void
    {
        $video = Video::create([
            'title' => 'Embed me',
            'original_filename' => 'embed.mp4',
            'status' => 'ready',
            'disk_prefix' => '2026/10/07/embed-1/',
            'playlist_path' => '2026/10/07/embed-1/playlist.m3u8',
        ]);

        $response = $this->get(route('embed.show', $video));

        $response->assertOk();
        $this->assertSame('noindex, nofollow', $response->headers->get('X-Robots-Tag'));
    }
}
