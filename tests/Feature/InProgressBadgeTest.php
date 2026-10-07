<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Tests\TestCase;

class InProgressBadgeTest extends TestCase
{
    use RefreshDatabase;

    private function seedVideo(string $status, int $progress = 0, ?string $uploadId = null): Video
    {
        return Video::create([
            'upload_id' => $uploadId,
            'title' => 'v-'.$status,
            'original_filename' => 'f.mp4',
            'status' => $status,
            'progress' => $progress,
            'disk_prefix' => 'p/',
        ]);
    }

    private function login(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function ringTag(string $html): string
    {
        $this->assertMatchesRegularExpression('/<a [^>]*data-in-progress-ring[^>]*>/s', $html);
        preg_match('/<a [^>]*data-in-progress-ring[^>]*>/s', $html, $m);

        return $m[0];
    }

    public function test_ring_contains_initial_data_for_pending_and_processing_videos_only(): void
    {
        $this->login();
        $pending = $this->seedVideo('pending', 7, 'aaaaaaaa-0000-0000-0000-000000000001');
        $p1 = $this->seedVideo('processing', 40, 'aaaaaaaa-0000-0000-0000-000000000002');
        $p2 = $this->seedVideo('processing', 90);
        $this->seedVideo('ready', 100);
        $this->seedVideo('failed', 30);

        $html = $this->get(route('logs.index'))->assertOk()->getContent();
        $tag = $this->ringTag($html);

        $this->assertDoesNotMatchRegularExpression('/\shidden[\s>]/', $tag);
        $this->assertStringContainsString(
            e(json_encode([
                ['id' => $pending->id, 'status' => 'pending', 'progress' => 7, 'upload_id' => 'aaaaaaaa-0000-0000-0000-000000000001'],
                ['id' => $p1->id, 'status' => 'processing', 'progress' => 40, 'upload_id' => 'aaaaaaaa-0000-0000-0000-000000000002'],
                ['id' => $p2->id, 'status' => 'processing', 'progress' => 90, 'upload_id' => null],
            ])),
            $tag
        );
    }

    public function test_ring_is_hidden_when_nothing_is_in_progress(): void
    {
        $this->login();
        $this->seedVideo('ready', 100);
        $this->seedVideo('failed');

        $html = $this->get(route('dashboard.overview'))->assertOk()->getContent();

        $this->assertMatchesRegularExpression('/\shidden[\s>]/', $this->ringTag($html));
        $this->assertStringContainsString('data-videos="[]"', $html);
    }

    public function test_old_sidebar_and_header_badge_markup_is_gone(): void
    {
        $this->login();
        $this->seedVideo('processing', 10);

        $this->get(route('settings.edit'))->assertOk()
            ->assertDontSee('data-in-progress-badge', false)
            ->assertDontSee('data-in-progress-text', false)
            ->assertDontSee('videos processing', false);
    }

    public function test_count_endpoint_redirects_guests_to_login(): void
    {
        $this->get(route('videos.in-progress-count'))->assertRedirect(route('login'));
    }

    public function test_count_endpoint_returns_count_and_progress_for_pending_and_processing_only(): void
    {
        $this->login();
        $pending = $this->seedVideo('pending', 5, 'bbbbbbbb-0000-0000-0000-000000000001');
        $processing = $this->seedVideo('processing', 55);
        $this->seedVideo('ready', 100);
        $this->seedVideo('failed', 20);

        $this->getJson('/videos/in-progress-count')->assertOk()->assertExactJson([
            'count' => 2,
            'videos' => [
                ['id' => $pending->id, 'status' => 'pending', 'progress' => 5, 'upload_id' => 'bbbbbbbb-0000-0000-0000-000000000001'],
                ['id' => $processing->id, 'status' => 'processing', 'progress' => 55, 'upload_id' => null],
            ],
        ]);
    }

    public function test_count_endpoint_is_not_shadowed_by_video_wildcard_routes(): void
    {
        $this->login();

        $this->assertSame('videos.in-progress-count', app('router')->getRoutes()->match(
            Request::create('/videos/in-progress-count')
        )->getName());
    }

    public function test_login_page_renders_without_ring(): void
    {
        $this->get(route('login'))->assertOk()->assertDontSee('data-in-progress-ring', false);
    }
}
