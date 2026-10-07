<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use App\Models\VideoStatusLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class VideoStatusEndpointsTest extends TestCase
{
    use RefreshDatabase;

    private function makeVideo(array $attributes = []): Video
    {
        return Video::create($attributes + [
            'title' => 'video',
            'original_filename' => 'video.mp4',
            'status' => 'pending',
        ]);
    }

    public function test_status_requires_authentication(): void
    {
        $this->get('/videos/status?ids=1')->assertRedirect(route('login'));
    }

    public function test_status_requires_ids_parameter(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->getJson('/videos/status')->assertStatus(422)->assertJsonValidationErrors('ids');
    }

    public function test_status_returns_status_stage_and_progress_for_given_ids(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $processing = $this->makeVideo(['status' => 'processing', 'stage' => 'transcoding', 'progress' => 42]);
        $ready = $this->makeVideo(['status' => 'ready', 'progress' => 100]);
        $other = $this->makeVideo();

        $response = $this->getJson("/videos/status?ids={$processing->id}, {$ready->id},{$processing->id}");

        $response->assertOk()->assertJsonCount(2);
        $response->assertJsonFragment(['id' => $processing->id, 'status' => 'processing', 'stage' => 'transcoding', 'progress' => 42]);
        $response->assertJsonFragment(['id' => $ready->id, 'status' => 'ready', 'progress' => 100]);
        $response->assertJsonMissing(['id' => $other->id]);
    }

    public function test_status_ignores_unknown_ids(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->getJson('/videos/status?ids=999999')->assertOk()->assertExactJson([]);
    }

    public function test_status_returns_empty_list_when_no_valid_ids_are_given(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->getJson('/videos/status?ids=abc,0,-5')->assertOk()->assertExactJson([]);
    }

    public function test_status_log_requires_authentication(): void
    {
        $video = $this->makeVideo();

        $this->get("/videos/{$video->id}/status-log")->assertRedirect(route('login'));
    }

    public function test_status_log_returns_entries_for_the_video_in_order(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $video = $this->makeVideo();
        $other = $this->makeVideo();

        VideoStatusLog::create(['video_id' => $video->id, 'status' => 'pending', 'stage' => null, 'progress' => 0])
            ->forceFill(['created_at' => now()->subMinutes(2)])->save();
        VideoStatusLog::create(['video_id' => $video->id, 'status' => 'processing', 'stage' => 'transcoding', 'progress' => 50])
            ->forceFill(['created_at' => now()->subMinute()])->save();
        VideoStatusLog::create(['video_id' => $other->id, 'status' => 'failed', 'stage' => null, 'progress' => 0]);

        $response = $this->getJson("/videos/{$video->id}/status-log");

        $response->assertOk()->assertJsonCount(2);
        $response->assertJsonPath('0.status', 'pending');
        $response->assertJsonPath('1.status', 'processing');
        $response->assertJsonPath('1.stage', 'transcoding');
        $response->assertJsonPath('1.progress', 50);
    }

    public function test_status_log_excludes_client_origin_rows(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $video = $this->makeVideo();

        VideoStatusLog::create(['video_id' => $video->id, 'status' => 'pending', 'stage' => null, 'progress' => 0]);
        VideoStatusLog::create(['video_id' => $video->id, 'level' => 'info', 'message' => 'Browser line']);

        $this->getJson("/videos/{$video->id}/status-log")->assertOk()->assertJsonCount(1)->assertJsonPath('0.status', 'pending');
    }

    public function test_status_log_returns_404_for_missing_video(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->getJson('/videos/999999/status-log')->assertNotFound();
    }
}
