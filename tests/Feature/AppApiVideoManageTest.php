<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\Video;
use App\Models\VideoStatusLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppApiVideoManageTest extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    private const PREFIX = '2026/11/03/clip-abcdefghij12/';

    private string $token;

    private $disk;

    protected function setUp(): void
    {
        parent::setUp();

        $this->configureR2();

        // Setting::r2Disk() uses Storage::build(), which Storage::fake() cannot intercept: hand back a fake disk.
        $this->disk = Storage::fake('r2-fake');
        Storage::partialMock()->shouldReceive('build')->andReturnUsing(fn () => $this->disk);

        $this->token = $this->tokenFor($this->makeUser());
    }

    private function makeVideo(array $attributes = []): Video
    {
        return Video::create($attributes + [
            'title' => 'Clip',
            'original_filename' => 'clip.mp4',
            'status' => 'ready',
        ]);
    }

    private function readyVideo(array $attributes = []): Video
    {
        return $this->makeVideo($attributes + [
            'public_id' => 'abcdefghij12',
            'disk_prefix' => self::PREFIX,
            'playlist_path' => self::PREFIX.'playlist.m3u8',
            'thumbnail_path' => self::PREFIX.'thumbnail.jpg',
            'storyboards' => [
                '3x3' => ['path' => self::PREFIX.'storyboard_3x3.jpg'],
                '5x5' => ['path' => self::PREFIX.'storyboard_5x5.jpg'],
            ],
        ]);
    }

    private function api(string $method, string $uri, array $data = [], ?string $token = 'default')
    {
        return $this->apiAs($token === 'default' ? $this->token : $token, $method, $uri, $data);
    }

    // ---- auth / not found / routing -------------------------------------------------------------------------------

    public function test_every_new_endpoint_requires_a_token(): void
    {
        $video = $this->makeVideo();

        foreach ([
            ['GET', "/api/app/videos/{$video->id}"],
            ['GET', '/api/app/videos/status?ids=1'],
            ['GET', "/api/app/videos/{$video->id}/status-log"],
            ['PUT', "/api/app/videos/{$video->id}"],
            ['DELETE', "/api/app/videos/{$video->id}"],
            ['DELETE', '/api/app/videos/bulk-destroy'],
            ['POST', "/api/app/videos/{$video->id}/image"],
            ['DELETE', "/api/app/videos/{$video->id}/image"],
            ['GET', '/api/app/overview'],
            ['GET', '/api/app/logs'],
        ] as [$method, $uri]) {
            $this->api($method, $uri, [], null)->assertUnauthorized();
        }
    }

    public function test_missing_video_answers_404_with_the_error_shape_on_every_video_endpoint(): void
    {
        foreach ([
            ['GET', '/api/app/videos/9999'],
            ['GET', '/api/app/videos/9999/status-log'],
            ['PUT', '/api/app/videos/9999'],
            ['DELETE', '/api/app/videos/9999'],
            ['POST', '/api/app/videos/9999/image'],
            ['DELETE', '/api/app/videos/9999/image'],
        ] as [$method, $uri]) {
            $this->api($method, $uri)->assertNotFound()->assertExactJson(['error' => 'not_found']);
        }
    }

    public function test_literal_paths_are_not_captured_by_the_video_wildcard(): void
    {
        // "status" and "bulk-destroy" must hit their own actions, never {video}.
        $this->api('GET', '/api/app/videos/status?ids=1')->assertOk()->assertExactJson(['data' => []]);
        $this->api('DELETE', '/api/app/videos/bulk-destroy', ['selected_ids' => [999]])->assertUnprocessable();
    }

    public function test_responses_are_no_store_and_a_second_users_token_sees_the_same_library(): void
    {
        $video = $this->readyVideo();
        $other = $this->tokenFor($this->makeUser('second'));

        $response = $this->api('GET', "/api/app/videos/{$video->id}", [], $other);

        $this->assertNoStore($response);
        // Single-tenant: videos have no owner, exactly like the web admin.
        $response->assertOk()->assertJsonPath('id', $video->id);
    }

    // ---- show -----------------------------------------------------------------------------------------------------

    public function test_show_returns_the_documented_detail(): void
    {
        $video = $this->readyVideo([
            'original_size_bytes' => 1234, 'duration' => 12.5, 'output_width' => 1280, 'output_height' => 720,
            'output_fps' => 30, 'output_bitrate_kbps' => 2500, 'output_codec' => 'h264',
            'stage' => 'ready', 'progress' => 100,
        ]);

        $json = $this->api('GET', "/api/app/videos/{$video->id}")->assertOk()->json();

        $this->assertSame($video->id, $json['id']);
        $this->assertSame('abcdefghij12', $json['public_id']);
        $this->assertSame('ready', $json['status']);
        $this->assertNull($json['error']);
        $this->assertSame(12.5, $json['duration']);
        $this->assertSame(route('embed.show', ['video' => 'abcdefghij12']), $json['embed_url']);
        $this->assertSame(self::PREFIX, $json['disk_prefix']);
        $this->assertSame($this->disk->url(self::PREFIX.'playlist.m3u8'), $json['playlist_url']);
        $this->assertSame($this->disk->url(self::PREFIX.'thumbnail.jpg'), $json['thumbnail_url']);
        $this->assertFalse($json['has_custom_image']);
        $this->assertNull($json['custom_image_url']);
        $this->assertSame(['3x3', '5x5'], array_keys($json['storyboards']));
        $this->assertSame(['url' => $this->disk->url(self::PREFIX.'storyboard_5x5.jpg'), 'columns' => 5, 'count' => 25], $json['storyboards']['5x5']);
        // The embed page picks the largest grid.
        $this->assertSame(
            ['url' => $this->disk->url(self::PREFIX.'storyboard_5x5.jpg'), 'number' => 25, 'column' => 5, 'width' => config('videos.storyboard_tile_size'), 'height' => config('videos.storyboard_tile_size')],
            $json['embed_storyboard'],
        );
        $this->assertSame($video->fresh()->updated_at->toIso8601String(), $json['updated_at']);
    }

    public function test_show_returns_a_null_disk_prefix_when_unset(): void
    {
        $video = $this->makeVideo();

        $json = $this->api('GET', "/api/app/videos/{$video->id}")->assertOk()->json();

        $this->assertArrayHasKey('disk_prefix', $json);
        $this->assertNull($json['disk_prefix']);
    }

    public function test_show_with_a_custom_image_has_a_cache_busting_url(): void
    {
        $video = $this->readyVideo(['custom_image_path' => self::PREFIX.'custom-clip-abcdefghij12.jpg']);

        $json = $this->api('GET', "/api/app/videos/{$video->id}")->assertOk()->json();

        $this->assertTrue($json['has_custom_image']);
        $this->assertSame($this->disk->url(self::PREFIX.'custom-clip-abcdefghij12.jpg').'?v='.$video->fresh()->updated_at->timestamp, $json['custom_image_url']);
    }

    public function test_show_of_a_failed_video_includes_the_sanitized_error_only(): void
    {
        $video = $this->makeVideo([
            'status' => 'failed', 'error_message' => 'Unable to process this video.',
            'error_detail' => 'RuntimeException: ffmpeg failed at [storage]/x', 'failed_at' => now(),
        ]);

        $json = $this->api('GET', "/api/app/videos/{$video->id}")->assertOk()->json();

        $this->assertSame('Unable to process this video.', $json['error']['message']);
        $this->assertSame('RuntimeException: ffmpeg failed at [storage]/x', $json['error']['detail']);
        $this->assertNotNull($json['error']['failed_at']);
    }

    public function test_show_does_not_leak_secrets_or_internal_fields(): void
    {
        $this->configureR2();
        $video = $this->readyVideo(['upload_id' => 'upl-secret-1']);

        $body = $this->api('GET', "/api/app/videos/{$video->id}")->assertOk()->getContent();

        foreach (['super-secret-value', 'AKIDEXAMPLE1234', 'upl-secret-1', 'upload_id', 'playlist_path', 'r2_secret'] as $needle) {
            $this->assertStringNotContainsString($needle, $body);
        }
    }

    // ---- status / status-log --------------------------------------------------------------------------------------

    public function test_status_returns_rows_for_the_given_ids_deduplicated(): void
    {
        $processing = $this->makeVideo(['status' => 'processing', 'stage' => 'transcoding', 'progress' => 42]);
        $ready = $this->makeVideo(['status' => 'ready', 'progress' => 100]);
        $other = $this->makeVideo();

        $response = $this->api('GET', "/api/app/videos/status?ids={$processing->id}, {$ready->id},{$processing->id}")->assertOk();

        $response->assertJsonCount(2, 'data');
        $response->assertJsonFragment(['id' => $processing->id, 'status' => 'processing', 'stage' => 'transcoding', 'progress' => 42]);
        $response->assertJsonMissing(['id' => $other->id]);
    }

    public function test_status_requires_ids_ignores_junk_and_caps_the_count(): void
    {
        $this->api('GET', '/api/app/videos/status')->assertUnprocessable()->assertJsonValidationErrors('ids');
        $this->api('GET', '/api/app/videos/status?ids=abc,0,-3')->assertOk()->assertExactJson(['data' => []]);

        $ids = [];
        for ($i = 0; $i < 55; $i++) {
            $ids[] = $this->makeVideo()->id;
        }

        $this->api('GET', '/api/app/videos/status?ids='.implode(',', $ids))->assertOk()->assertJsonCount(50, 'data');
    }

    public function test_status_log_returns_only_server_origin_rows_of_that_video(): void
    {
        $video = $this->makeVideo();
        $other = $this->makeVideo();
        VideoStatusLog::create(['video_id' => $video->id, 'status' => 'pending', 'stage' => null, 'progress' => 0]);
        VideoStatusLog::create(['video_id' => $video->id, 'status' => 'processing', 'stage' => 'transcoding', 'progress' => 50]);
        VideoStatusLog::create(['video_id' => $video->id, 'level' => 'info', 'message' => 'Browser line']);
        VideoStatusLog::create(['video_id' => $other->id, 'status' => 'failed', 'stage' => null, 'progress' => 0]);

        $response = $this->api('GET', "/api/app/videos/{$video->id}/status-log")->assertOk();

        $response->assertJsonCount(2, 'data');
        $this->assertSame(['pending', 'processing'], array_column($response->json('data'), 'status'));
        $this->assertSame(['status', 'stage', 'progress', 'created_at'], array_keys($response->json('data.0')));
        $this->assertStringNotContainsString('Browser line', $response->getContent());
    }

    // ---- update ---------------------------------------------------------------------------------------------------

    public function test_update_changes_the_title_and_returns_the_detail(): void
    {
        $video = $this->readyVideo();

        $this->api('PUT', "/api/app/videos/{$video->id}", ['title' => 'New title'])
            ->assertOk()->assertJsonPath('title', 'New title')->assertJsonPath('id', $video->id);

        $this->assertSame('New title', $video->fresh()->title);
    }

    public function test_update_validates_the_title(): void
    {
        $video = $this->makeVideo();

        $this->api('PUT', "/api/app/videos/{$video->id}", [])->assertUnprocessable()->assertJsonValidationErrors('title');
        $this->api('PUT', "/api/app/videos/{$video->id}", ['title' => str_repeat('a', 256)])->assertUnprocessable()->assertJsonValidationErrors('title');
        $this->api('PUT', "/api/app/videos/{$video->id}", ['title' => ['x']])->assertUnprocessable()->assertJsonValidationErrors('title');
        $this->assertSame('Clip', $video->fresh()->title);
    }

    public function test_update_ignores_other_fields(): void
    {
        $video = $this->readyVideo();

        $this->api('PUT', "/api/app/videos/{$video->id}", ['title' => 'T', 'status' => 'failed', 'public_id' => 'zzzzzzzzzzzz'])->assertOk();

        $this->assertSame('ready', $video->fresh()->status);
        $this->assertSame('abcdefghij12', $video->fresh()->public_id);
    }

    // ---- destroy / bulk -------------------------------------------------------------------------------------------

    public function test_destroy_deletes_the_record_and_the_r2_folder(): void
    {
        $this->disk->put(self::PREFIX.'playlist.m3u8', 'x');
        $video = $this->readyVideo();

        $this->api('DELETE', "/api/app/videos/{$video->id}")
            ->assertOk()->assertExactJson(['status' => 'deleted', 'message' => 'Video has been deleted.']);

        $this->assertNull(Video::find($video->id));
        $this->disk->assertMissing(self::PREFIX.'playlist.m3u8');
    }

    public function test_destroy_keeps_r2_files_when_the_setting_says_so(): void
    {
        Setting::current()->update(['delete_from_r2_on_destroy' => false]);
        $this->disk->put(self::PREFIX.'playlist.m3u8', 'x');
        $video = $this->readyVideo();

        $this->api('DELETE', "/api/app/videos/{$video->id}")
            ->assertOk()->assertJsonPath('status', 'deleted')->assertJsonPath('message', 'Record deleted, file on R2 was KEPT.');

        $this->disk->assertExists(self::PREFIX.'playlist.m3u8');
    }

    public function test_destroy_skips_videos_still_processing(): void
    {
        foreach (['pending', 'processing'] as $status) {
            $video = $this->makeVideo(['status' => $status]);

            $this->api('DELETE', "/api/app/videos/{$video->id}")
                ->assertOk()->assertJsonPath('status', 'skipped');
            $this->assertNotNull(Video::find($video->id));
        }
    }

    public function test_destroy_keeps_the_record_when_r2_cleanup_fails(): void
    {
        $video = $this->readyVideo();
        $this->disk = \Mockery::mock($this->disk)->makePartial();
        $this->disk->shouldReceive('deleteDirectory')->andThrow(new \RuntimeException('boom endpoint secret'));

        $response = $this->api('DELETE', "/api/app/videos/{$video->id}")->assertOk()->assertJsonPath('status', 'failed');

        $this->assertStringNotContainsString('boom', $response->getContent());
        $this->assertNotNull(Video::find($video->id));
    }

    public function test_bulk_destroy_reports_counts(): void
    {
        $a = $this->readyVideo();
        $b = $this->makeVideo(['status' => 'failed']);
        $busy = $this->makeVideo(['status' => 'processing']);

        $this->api('DELETE', '/api/app/videos/bulk-destroy', ['selected_ids' => [$a->id, $b->id, $busy->id]])
            ->assertOk()
            ->assertJson(['deleted' => 2, 'failed' => 0, 'skipped' => 1])
            ->assertJsonPath('message', 'Deleted 2 videos (1 skipped: still processing).');

        $this->assertNull(Video::find($a->id));
        $this->assertNotNull(Video::find($busy->id));
    }

    public function test_bulk_destroy_validates_and_caps_the_size(): void
    {
        $video = $this->makeVideo();

        $this->api('DELETE', '/api/app/videos/bulk-destroy', [])->assertUnprocessable()->assertJsonValidationErrors('selected_ids');
        $this->api('DELETE', '/api/app/videos/bulk-destroy', ['selected_ids' => []])->assertUnprocessable()->assertJsonValidationErrors('selected_ids');
        $this->api('DELETE', '/api/app/videos/bulk-destroy', ['selected_ids' => [$video->id, 9999]])->assertUnprocessable()->assertJsonValidationErrors('selected_ids.1');
        $this->api('DELETE', '/api/app/videos/bulk-destroy', ['selected_ids' => range(1, 101)])->assertUnprocessable()->assertJsonValidationErrors('selected_ids');
        $this->assertNotNull(Video::find($video->id));
    }

    // ---- custom image ---------------------------------------------------------------------------------------------

    public function test_image_upload_stores_under_the_video_prefix(): void
    {
        $video = $this->readyVideo();

        $response = $this->api('POST', "/api/app/videos/{$video->id}/image", ['image' => UploadedFile::fake()->image('cover.jpeg', 100, 100)]);

        $path = $video->fresh()->custom_image_path;
        $this->assertSame(self::PREFIX.'custom-clip-abcdefghij12.jpg', $path);
        $response->assertOk()->assertJson(['label' => 'Custom image', 'url' => $this->disk->url($path).'?v='.$video->fresh()->updated_at->timestamp]);
        $this->disk->assertExists($path);
    }

    public function test_image_replace_with_another_extension_removes_the_old_object(): void
    {
        $old = self::PREFIX.'custom-clip-abcdefghij12.png';
        $this->disk->put($old, 'old');
        $video = $this->readyVideo(['custom_image_path' => $old]);

        $this->api('POST', "/api/app/videos/{$video->id}/image", ['image' => UploadedFile::fake()->image('n.jpg', 50, 50)])->assertOk();

        $this->disk->assertMissing($old);
        $this->disk->assertExists(self::PREFIX.'custom-clip-abcdefghij12.jpg');
    }

    public function test_image_upload_rejects_bad_files(): void
    {
        $video = $this->readyVideo();
        $url = "/api/app/videos/{$video->id}/image";

        $this->api('POST', $url, [])->assertUnprocessable()->assertJsonValidationErrors('image');
        $this->api('POST', $url, ['image' => UploadedFile::fake()->create('doc.pdf', 10, 'application/pdf')])->assertUnprocessable()->assertJsonValidationErrors('image');
        $this->api('POST', $url, ['image' => UploadedFile::fake()->image('big.jpg', 100, 100)->size(5121)])->assertUnprocessable()->assertJsonValidationErrors('image');
        // Content is checked, not just the extension: text renamed to .jpg is refused.
        // (UploadedFile::fake() guesses the type from the name, so use a real upload object that sniffs the bytes.)
        $probe = Storage::fake('probe');
        $probe->put('evil.jpg', 'not an image, just text');
        $evil = new UploadedFile($probe->path('evil.jpg'), 'evil.jpg', 'image/jpeg', null, true);
        $this->api('POST', $url, ['image' => $evil])->assertUnprocessable()->assertJsonValidationErrors('image');
        $this->api('POST', $url, ['image' => 'a string'])->assertUnprocessable()->assertJsonValidationErrors('image');

        $this->assertNull($video->fresh()->custom_image_path);
        $this->assertSame([], $this->disk->allFiles());
    }

    public function test_image_upload_accepts_png_and_webp_at_the_size_limit(): void
    {
        $video = $this->readyVideo();

        $this->api('POST', "/api/app/videos/{$video->id}/image", ['image' => UploadedFile::fake()->image('a.png', 20, 20)->size(5120)])->assertOk();
        $this->api('POST', "/api/app/videos/{$video->id}/image", ['image' => UploadedFile::fake()->image('a.webp', 20, 20)])->assertOk();
    }

    public function test_image_upload_needs_a_storage_folder(): void
    {
        $video = $this->makeVideo(['status' => 'processing']);

        $this->api('POST', "/api/app/videos/{$video->id}/image", ['image' => UploadedFile::fake()->image('a.jpg', 20, 20)])
            ->assertUnprocessable()->assertJsonPath('error', 'no_storage_folder');
    }

    public function test_image_upload_failure_is_a_generic_500(): void
    {
        $video = $this->readyVideo();
        $this->disk = \Mockery::mock($this->disk)->makePartial();
        $this->disk->shouldReceive('putFileAs')->andThrow(new \RuntimeException('secret endpoint'));

        $response = $this->api('POST', "/api/app/videos/{$video->id}/image", ['image' => UploadedFile::fake()->image('a.jpg', 20, 20)]);

        $response->assertStatus(500)->assertJsonPath('error', 'image_store_failed');
        $this->assertStringNotContainsString('secret endpoint', $response->getContent());
        $this->assertNull($video->fresh()->custom_image_path);
    }

    public function test_image_upload_route_is_throttled_like_the_web_one(): void
    {
        $video = $this->readyVideo();

        $this->assertContains('throttle:20,1', app('router')->getRoutes()->getByName('api.app.videos.image.store')->gatherMiddleware());

        for ($i = 0; $i < 20; $i++) {
            $this->api('POST', "/api/app/videos/{$video->id}/image", [])->assertUnprocessable();
        }

        $this->api('POST', "/api/app/videos/{$video->id}/image", [])->assertStatus(429);
    }

    public function test_image_destroy_removes_object_and_column(): void
    {
        $path = self::PREFIX.'custom-clip-abcdefghij12.jpg';
        $this->disk->put($path, 'x');
        $video = $this->readyVideo(['custom_image_path' => $path]);

        $this->api('DELETE', "/api/app/videos/{$video->id}/image")->assertOk()->assertExactJson(['ok' => true]);

        $this->assertNull($video->fresh()->custom_image_path);
        $this->disk->assertMissing($path);
    }

    public function test_image_destroy_without_an_image_is_404(): void
    {
        $video = $this->readyVideo();

        $this->api('DELETE', "/api/app/videos/{$video->id}/image")->assertNotFound()->assertJsonPath('error', 'no_custom_image');
    }

    public function test_image_destroy_keeps_the_column_when_r2_delete_fails(): void
    {
        $path = self::PREFIX.'custom-clip-abcdefghij12.jpg';
        $video = $this->readyVideo(['custom_image_path' => $path]);
        $this->disk = \Mockery::mock($this->disk)->makePartial();
        $this->disk->shouldReceive('delete')->andReturn(false);

        $this->api('DELETE', "/api/app/videos/{$video->id}/image")->assertStatus(500)->assertJsonPath('error', 'image_delete_failed');

        $this->assertSame($path, $video->fresh()->custom_image_path);
    }

    // ---- overview / logs ------------------------------------------------------------------------------------------

    public function test_overview_returns_counts_and_system_figures(): void
    {
        $this->makeVideo(['status' => 'ready']);
        $this->makeVideo(['status' => 'ready']);
        $this->makeVideo(['status' => 'pending']);
        $this->makeVideo(['status' => 'processing']);
        $this->makeVideo(['status' => 'failed']);

        $response = $this->api('GET', '/api/app/overview')->assertOk();

        $response->assertJsonPath('videos', ['total' => 5, 'ready' => 2, 'processing' => 2, 'failed' => 1]);
        $this->assertSame(
            ['cpu_percent', 'cpu_cores', 'load_avg_1min', 'ram_percent', 'ram_used_gb', 'ram_total_gb', 'disk_percent', 'disk_used_gb', 'disk_total_gb'],
            array_keys($response->json('system')),
        );
        $this->assertNoStore($response);
    }

    public function test_logs_summary_mirrors_the_web_page(): void
    {
        $this->makeVideo(['status' => 'ready']);
        $failed = $this->makeVideo(['status' => 'failed', 'error_message' => 'bad', 'error_detail' => 'detail', 'failed_at' => now()]);
        $busy = $this->makeVideo(['status' => 'pending']);

        $response = $this->api('GET', '/api/app/logs')->assertOk();

        $response->assertJsonPath('counts', ['total' => 3, 'success' => 1, 'error' => 1, 'processing' => 1]);
        $response->assertJsonCount(1, 'success')->assertJsonCount(1, 'error')->assertJsonCount(1, 'processing');
        $response->assertJsonPath('error.0.id', $failed->id)->assertJsonPath('error.0.error_message', 'bad')->assertJsonPath('error.0.error_detail', 'detail');
        $response->assertJsonPath('processing.0.id', $busy->id);
    }

    public function test_logs_summary_caps_the_lists_like_the_web_page(): void
    {
        for ($i = 0; $i < 12; $i++) {
            $this->makeVideo(['status' => 'ready']);
            $this->makeVideo(['status' => 'failed']);
        }

        $response = $this->api('GET', '/api/app/logs')->assertOk();

        $response->assertJsonCount(10, 'success')->assertJsonCount(10, 'error')->assertJsonPath('counts.success', 12);
    }

    public function test_logs_by_type_is_paginated(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->makeVideo(['status' => 'failed']);
        }
        $this->makeVideo(['status' => 'ready']);

        $this->api('GET', '/api/app/logs?type=error&per_page=2&page=3')->assertOk()
            ->assertJsonPath('meta', ['page' => 3, 'per_page' => 2, 'total' => 5, 'last_page' => 3])
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('counts.total', 6);
    }

    public function test_logs_validates_query_values(): void
    {
        $this->api('GET', '/api/app/logs?type=bogus')->assertUnprocessable()->assertJsonValidationErrors('type');
        $this->api('GET', '/api/app/logs?type=error&per_page=51')->assertUnprocessable()->assertJsonValidationErrors('per_page');
        $this->api('GET', '/api/app/logs?type=error&page=0')->assertUnprocessable()->assertJsonValidationErrors('page');
    }

    public function test_the_whole_group_keeps_the_app_api_throttle(): void
    {
        foreach (['api.app.videos.show', 'api.app.videos.update', 'api.app.videos.destroy', 'api.app.videos.bulk-destroy', 'api.app.videos.status',
            'api.app.videos.status-log', 'api.app.videos.image.store', 'api.app.videos.image.destroy', 'api.app.overview', 'api.app.logs.index'] as $name) {
            $middleware = app('router')->getRoutes()->getByName($name)->gatherMiddleware();

            $this->assertContains('throttle:app-api', $middleware, $name);
            $this->assertContains('auth:sanctum', $middleware, $name);
        }
    }
}
