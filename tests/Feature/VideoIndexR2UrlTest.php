<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class VideoIndexR2UrlTest extends TestCase
{
    use RefreshDatabase;

    public function test_index_uses_db_configured_r2_url_for_thumbnail_and_playlist(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        Setting::current()->update([
            'r2_access_key_id' => 'db-key',
            'r2_secret_access_key' => 'db-secret',
            'r2_bucket' => 'db-bucket',
            'r2_endpoint' => 'https://db-endpoint.example.com',
            'r2_url' => 'https://db-cdn.example.com',
        ]);

        Video::create([
            'title' => 'My video',
            'original_filename' => 'my-video.mp4',
            'status' => 'ready',
            'disk_prefix' => '2026/10/06/my-video-1/',
            'playlist_path' => '2026/10/06/my-video-1/playlist.m3u8',
            'thumbnail_path' => '2026/10/06/my-video-1/thumb.jpg',
        ]);

        $response = $this->get('/videos');

        $response->assertOk();
        $response->assertSee('https://db-cdn.example.com/2026/10/06/my-video-1/thumb.jpg', false);
    }

    public function test_search_treats_percent_and_underscore_as_literal_characters(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        Setting::current()->update([
            'r2_access_key_id' => 'db-key',
            'r2_secret_access_key' => 'db-secret',
            'r2_bucket' => 'db-bucket',
            'r2_endpoint' => 'https://db-endpoint.example.com',
            'r2_url' => 'https://db-cdn.example.com',
        ]);

        foreach (['100% real', '100 percent', 'a_b clip', 'aXb clip', 'bang! clip'] as $title) {
            Video::create([
                'title' => $title,
                'original_filename' => 'f.mp4',
                'status' => 'ready',
                'disk_prefix' => 'p/',
                'playlist_path' => 'p/playlist.m3u8',
                'thumbnail_path' => 'p/thumb.jpg',
            ]);
        }

        $this->get('/videos?search='.urlencode('100%'))
            ->assertSee('100% real')
            ->assertDontSee('100 percent');

        $this->get('/videos?search='.urlencode('a_b'))
            ->assertSee('a_b clip')
            ->assertDontSee('aXb clip');

        $this->get('/videos?search='.urlencode('!'))
            ->assertSee('bang! clip', false)
            ->assertDontSee('aXb clip');
    }
}
