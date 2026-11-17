<?php

namespace Tests\Feature;

use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppApiVideoListTest extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    private string $token;

    protected function setUp(): void
    {
        parent::setUp();

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

    private function list(array $query = [])
    {
        return $this->apiAs($this->token, 'GET', '/api/app/videos?'.http_build_query($query));
    }

    public function test_list_requires_a_token(): void
    {
        $this->apiAs(null, 'GET', '/api/app/videos')->assertUnauthorized();
    }

    public function test_list_returns_the_documented_shape(): void
    {
        $prefix = '2026/11/03/clip-abcdefghij12/';
        $video = $this->makeVideo([
            'public_id' => 'abcdefghij12',
            'title' => 'My clip',
            'original_filename' => 'my clip.mp4',
            'original_size_bytes' => 1234,
            'duration' => 12.5,
            'output_width' => 1280,
            'output_height' => 720,
            'output_codec' => 'h264',
            'disk_prefix' => $prefix,
            'playlist_path' => $prefix.'playlist.m3u8',
            'thumbnail_path' => $prefix.'thumbnail.jpg',
            'custom_image_path' => $prefix.'custom.jpg',
            'storyboards' => ['3x3' => ['path' => $prefix.'storyboard_3x3.jpg']],
        ]);

        $response = $this->list();

        $this->assertNoStore($response);
        $response->assertOk()
            ->assertJsonPath('meta', ['page' => 1, 'per_page' => 24, 'total' => 1, 'last_page' => 1])
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0', [
                'id' => $video->id,
                'public_id' => 'abcdefghij12',
                'title' => 'My clip',
                'original_filename' => 'my clip.mp4',
                'original_size_bytes' => 1234,
                'status' => 'ready',
                'duration' => 12.5,
                'output_width' => 1280,
                'output_height' => 720,
                'output_codec' => 'h264',
                'disk_prefix' => $prefix,
                'playlist_path' => $prefix.'playlist.m3u8',
                'thumbnail_path' => $prefix.'thumbnail.jpg',
                'custom_image_path' => $prefix.'custom.jpg',
                'storyboards' => ['3x3' => ['path' => $prefix.'storyboard_3x3.jpg']],
                'embed_url' => route('embed.show', ['video' => 'abcdefghij12']),
                'created_at' => $video->fresh()->created_at->toIso8601String(),
            ]);
    }

    public function test_list_exposes_only_whitelisted_fields(): void
    {
        $this->makeVideo([
            'status' => 'failed',
            'error_detail' => 'secret trace',
            'error_message' => 'boom',
            'upload_id' => 'upl-1',
        ]);

        $item = $this->list()->assertOk()->json('data.0');

        $this->assertEqualsCanonicalizing([
            'id', 'public_id', 'title', 'original_filename', 'original_size_bytes', 'status', 'duration',
            'output_width', 'output_height', 'output_codec', 'disk_prefix', 'playlist_path', 'thumbnail_path',
            'custom_image_path', 'storyboards', 'embed_url', 'created_at',
        ], array_keys($item));
        $this->assertStringNotContainsString('secret trace', json_encode($item));
    }

    public function test_list_is_newest_first_and_includes_all_statuses(): void
    {
        $first = $this->makeVideo(['status' => 'pending']);
        $second = $this->makeVideo(['status' => 'processing']);
        $third = $this->makeVideo(['status' => 'failed']);
        $fourth = $this->makeVideo(['status' => 'ready']);

        $response = $this->list()->assertOk();

        $this->assertSame([$fourth->id, $third->id, $second->id, $first->id], array_column($response->json('data'), 'id'));
        $this->assertSame(['ready', 'failed', 'processing', 'pending'], array_column($response->json('data'), 'status'));
    }

    public function test_pagination_meta_and_pages(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $this->makeVideo();
        }

        $this->list(['per_page' => 2, 'page' => 3])->assertOk()
            ->assertJsonPath('meta', ['page' => 3, 'per_page' => 2, 'total' => 5, 'last_page' => 3])
            ->assertJsonCount(1, 'data');

        $this->list(['per_page' => 2, 'page' => 1])->assertOk()->assertJsonCount(2, 'data');
    }

    public function test_page_beyond_the_last_is_empty(): void
    {
        $this->makeVideo();

        $this->list(['page' => 9])->assertOk()
            ->assertJsonPath('data', [])
            ->assertJsonPath('meta.total', 1)
            ->assertJsonPath('meta.page', 9);
    }

    public function test_empty_library_returns_empty_data(): void
    {
        $this->list()->assertOk()->assertJsonPath('data', [])->assertJsonPath('meta.total', 0);
    }

    public function test_q_matches_title_or_original_filename(): void
    {
        $byTitle = $this->makeVideo(['title' => 'Holiday trip', 'original_filename' => 'a.mp4']);
        $byFile = $this->makeVideo(['title' => 'Other', 'original_filename' => 'holiday-raw.mov']);
        $this->makeVideo(['title' => 'Unrelated', 'original_filename' => 'b.mp4']);

        $ids = array_column($this->list(['q' => '  HOLIDAY '])->assertOk()->json('data'), 'id');

        $this->assertSame([$byFile->id, $byTitle->id], $ids);
    }

    public function test_blank_q_applies_no_filter(): void
    {
        $this->makeVideo();
        $this->makeVideo();

        $this->list(['q' => '   '])->assertOk()->assertJsonPath('meta.total', 2);
    }

    public function test_q_wildcards_are_escaped(): void
    {
        $percent = $this->makeVideo(['title' => '100% done']);
        $underscore = $this->makeVideo(['title' => 'my_clip']);
        $this->makeVideo(['title' => 'myXclip']);
        $backslash = $this->makeVideo(['title' => 'a\\b']);
        $this->makeVideo(['title' => 'plain']);

        $this->assertSame([$percent->id], array_column($this->list(['q' => '%'])->json('data'), 'id'));
        $this->assertSame([$underscore->id], array_column($this->list(['q' => 'my_clip'])->json('data'), 'id'));
        $this->assertSame([$backslash->id], array_column($this->list(['q' => '\\'])->json('data'), 'id'));
    }

    public function test_invalid_query_values_return_422(): void
    {
        $this->list(['per_page' => 51])->assertUnprocessable()->assertJsonValidationErrors('per_page');
        $this->list(['per_page' => 0])->assertUnprocessable()->assertJsonValidationErrors('per_page');
        $this->list(['page' => 0])->assertUnprocessable()->assertJsonValidationErrors('page');
        $this->list(['page' => 'abc'])->assertUnprocessable()->assertJsonValidationErrors('page');
        $this->list(['q' => str_repeat('a', 101)])->assertUnprocessable()->assertJsonValidationErrors('q');
    }
}
