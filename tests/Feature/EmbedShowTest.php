<?php

namespace Tests\Feature;

use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class EmbedShowTest extends TestCase
{
    use RefreshDatabase;

    private function makeVideo(string $status): Video
    {
        return Video::create([
            'title' => 'Embed me',
            'original_filename' => 'embed.mp4',
            'status' => $status,
            'disk_prefix' => '2026/10/07/embed-1/',
            'playlist_path' => '2026/10/07/embed-1/playlist.m3u8',
        ]);
    }

    public function test_guest_can_view_ready_video_with_configured_playlist_url(): void
    {
        config([
            'filesystems.disks.r2.key' => 'db-key',
            'filesystems.disks.r2.secret' => 'db-secret',
            'filesystems.disks.r2.bucket' => 'db-bucket',
            'filesystems.disks.r2.endpoint' => 'https://db-endpoint.example.com',
            'filesystems.disks.r2.url' => 'https://db-cdn.example.com',
        ]);

        $video = $this->makeVideo('ready');

        $response = $this->get(route('embed.show', $video));

        $response->assertOk();
        // The URL is emitted through @json, so slashes are escaped.
        $response->assertSee('https:\/\/db-cdn.example.com\/2026\/10\/07\/embed-1\/playlist.m3u8', false);
        $response->assertDontSee('Server disk');
        $response->assertDontSee(route('logout'), false);
    }

    public function test_non_ready_videos_return_404(): void
    {
        foreach (['pending', 'processing', 'failed'] as $status) {
            $video = $this->makeVideo($status);

            $this->get(route('embed.show', $video))->assertNotFound();
        }
    }

    public function test_missing_video_returns_404(): void
    {
        $this->get('/embed/999999')->assertNotFound();
    }

    public function test_embed_route_is_throttled_to_60_requests_per_minute(): void
    {
        $video = $this->makeVideo('pending');

        for ($i = 0; $i < 60; $i++) {
            $this->get(route('embed.show', $video))->assertNotFound();
        }

        $this->get(route('embed.show', $video))->assertStatus(429);
    }

    public function test_embed_response_sets_no_cookies(): void
    {
        $video = $this->makeVideo('ready');

        $response = $this->get(route('embed.show', $video));

        $response->assertOk();
        $this->assertSame([], $response->headers->getCookies());
        $this->assertFalse($response->headers->has('Set-Cookie'));
    }

    public function test_embed_view_does_not_create_session_rows(): void
    {
        $video = $this->makeVideo('ready');
        $before = DB::table('sessions')->count();

        $this->get(route('embed.show', $video))->assertOk();

        $this->assertSame($before, DB::table('sessions')->count());
    }

    public function test_embed_ok_response_is_publicly_cacheable(): void
    {
        $video = $this->makeVideo('ready');

        $cacheControl = (string) $this->get(route('embed.show', $video))->assertOk()->headers->get('Cache-Control');

        $this->assertStringContainsString('public', $cacheControl);
        $this->assertStringContainsString('max-age=60', $cacheControl);
        $this->assertStringContainsString('s-maxage=300', $cacheControl);
        $this->assertStringNotContainsString('private', $cacheControl);
        $this->assertStringNotContainsString('no-cache', $cacheControl);
    }

    public function test_embed_ok_response_has_noindex_header(): void
    {
        $video = $this->makeVideo('ready');

        $response = $this->get(route('embed.show', $video));

        $response->assertOk();
        $response->assertHeader('X-Robots-Tag', 'noindex, nofollow');
    }

    public function test_embed_404_response_is_not_publicly_cacheable(): void
    {
        $video = $this->makeVideo('pending');

        $cacheControl = (string) $this->get(route('embed.show', $video))->assertNotFound()->headers->get('Cache-Control');

        $this->assertStringNotContainsString('s-maxage=300', $cacheControl);
    }
}
