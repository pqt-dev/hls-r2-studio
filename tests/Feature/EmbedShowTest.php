<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
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

    public function test_guest_can_view_ready_video_with_db_configured_playlist_url(): void
    {
        Setting::current()->update([
            'r2_access_key_id' => 'db-key',
            'r2_secret_access_key' => 'db-secret',
            'r2_bucket' => 'db-bucket',
            'r2_endpoint' => 'https://db-endpoint.example.com',
            'r2_url' => 'https://db-cdn.example.com',
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
}
