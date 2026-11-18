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
            'output_fps' => 29.97,
            'output_bitrate_kbps' => 2400,
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
                'output_fps' => 29.97,
                'output_bitrate_kbps' => 2400,
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
            'output_width', 'output_height', 'output_fps', 'output_bitrate_kbps', 'output_codec', 'disk_prefix', 'playlist_path', 'thumbnail_path',
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

    private function ids(array $query): array
    {
        return array_column($this->list($query)->assertOk()->json('data'), 'id');
    }

    public function test_q_requires_every_word_in_any_order(): void
    {
        $both = $this->makeVideo(['title' => 'Summer holiday trip', 'original_filename' => 'a.mp4']);
        $reversed = $this->makeVideo(['title' => 'Trip of the holiday', 'original_filename' => 'b.mp4']);
        $this->makeVideo(['title' => 'Holiday only', 'original_filename' => 'c.mp4']);
        $this->makeVideo(['title' => 'Trip only', 'original_filename' => 'd.mp4']);

        $this->assertSame([$reversed->id, $both->id], $this->ids(['q' => ' trip   HOLIDAY ']));
        $this->list(['q' => 'trip holiday'])->assertJsonPath('meta.total', 2);
        $this->assertSame([], $this->ids(['q' => 'holiday missing']));
    }

    public function test_each_word_may_match_title_or_filename(): void
    {
        $video = $this->makeVideo(['title' => 'Holiday', 'original_filename' => 'raw-trip.mov']);
        $this->makeVideo(['title' => 'Holiday', 'original_filename' => 'other.mov']);

        $this->assertSame([$video->id], $this->ids(['q' => 'holiday trip']));
    }

    public function test_wildcards_are_escaped_per_word(): void
    {
        $match = $this->makeVideo(['title' => '100% my_clip done']);
        $this->makeVideo(['title' => '100 myXclip done']);

        $this->assertSame([$match->id], $this->ids(['q' => '% my_clip']));
    }

    public function test_default_sort_is_newest_and_oldest_reverses_it(): void
    {
        $first = $this->makeVideo(['title' => 'B']);
        $second = $this->makeVideo(['title' => 'A']);

        $this->assertSame([$second->id, $first->id], $this->ids([]));
        $this->assertSame([$second->id, $first->id], $this->ids(['sort' => 'newest']));
        $this->assertSame([$first->id, $second->id], $this->ids(['sort' => 'oldest']));
    }

    public function test_sort_by_title_uses_id_as_tie_breaker(): void
    {
        $b = $this->makeVideo(['title' => 'Banana']);
        $a1 = $this->makeVideo(['title' => 'Apple']);
        $a2 = $this->makeVideo(['title' => 'Apple']);
        $c = $this->makeVideo(['title' => 'Cherry']);

        $this->assertSame([$a2->id, $a1->id, $b->id, $c->id], $this->ids(['sort' => 'title_asc']));
        $this->assertSame([$c->id, $b->id, $a2->id, $a1->id], $this->ids(['sort' => 'title_desc']));
    }

    public function test_sort_by_duration_and_size_puts_missing_values_last(): void
    {
        $short = $this->makeVideo(['title' => 'Short', 'duration' => 10, 'original_size_bytes' => 5000]);
        $long = $this->makeVideo(['title' => 'Long', 'duration' => 300, 'original_size_bytes' => 100]);
        $unknown = $this->makeVideo(['title' => 'Unknown', 'status' => 'processing']);

        $this->assertSame([$long->id, $short->id, $unknown->id], $this->ids(['sort' => 'duration_desc']));
        $this->assertSame([$short->id, $long->id, $unknown->id], $this->ids(['sort' => 'size_desc']));
    }

    public function test_sort_and_search_combine_and_paginate_without_overlap(): void
    {
        $ids = [];

        foreach (['d', 'b', 'e', 'a', 'c'] as $letter) {
            $ids[$letter] = $this->makeVideo(['title' => "Clip $letter"])->id;
        }

        $this->makeVideo(['title' => 'Other', 'original_filename' => 'x.mp4']);

        $page1 = array_column($this->list(['q' => 'clip', 'sort' => 'title_asc', 'per_page' => 2, 'page' => 1])->json('data'), 'id');
        $page2 = array_column($this->list(['q' => 'clip', 'sort' => 'title_asc', 'per_page' => 2, 'page' => 2])->json('data'), 'id');
        $page3 = array_column($this->list(['q' => 'clip', 'sort' => 'title_asc', 'per_page' => 2, 'page' => 3])->json('data'), 'id');

        $this->assertSame([$ids['a'], $ids['b']], $page1);
        $this->assertSame([$ids['c'], $ids['d']], $page2);
        $this->assertSame([$ids['e']], $page3);
    }

    public function test_invalid_sort_returns_422(): void
    {
        $this->list(['sort' => 'random'])->assertUnprocessable()->assertJsonValidationErrors('sort');
        $this->list(['sort' => 'id; DROP TABLE videos'])->assertUnprocessable()->assertJsonValidationErrors('sort');
    }

    public function test_status_filter_keeps_only_that_status(): void
    {
        $ready = $this->makeVideo(['title' => 'R', 'status' => 'ready']);
        $processing = $this->makeVideo(['title' => 'P', 'status' => 'processing']);
        $failed = $this->makeVideo(['title' => 'F', 'status' => 'failed']);
        $pending = $this->makeVideo(['title' => 'N', 'status' => 'pending']);

        $this->assertSame([$ready->id], $this->ids(['status' => 'ready']));
        $this->assertSame([$processing->id], $this->ids(['status' => 'processing']));
        $this->assertSame([$failed->id], $this->ids(['status' => 'failed']));
        $this->assertSame([$pending->id], $this->ids(['status' => 'pending']));
        $this->list(['status' => 'ready'])->assertJsonPath('meta.total', 1);
    }

    public function test_absent_or_blank_status_returns_every_status(): void
    {
        $this->makeVideo(['status' => 'ready']);
        $this->makeVideo(['status' => 'failed']);

        $this->list()->assertOk()->assertJsonPath('meta.total', 2);
        $this->list(['status' => ''])->assertOk()->assertJsonPath('meta.total', 2);
    }

    public function test_status_combines_with_search_sort_and_pagination(): void
    {
        $a = $this->makeVideo(['title' => 'Clip a', 'status' => 'ready', 'original_filename' => 'x.mp4']);
        $c = $this->makeVideo(['title' => 'Clip c', 'status' => 'ready', 'original_filename' => 'x.mp4']);
        $b = $this->makeVideo(['title' => 'Clip b', 'status' => 'ready', 'original_filename' => 'x.mp4']);
        $this->makeVideo(['title' => 'Clip z', 'status' => 'failed', 'original_filename' => 'x.mp4']);
        $this->makeVideo(['title' => 'Other', 'status' => 'ready', 'original_filename' => 'y.mp4']);

        $query = ['status' => 'ready', 'q' => 'clip', 'sort' => 'title_asc', 'per_page' => 2];

        $this->assertSame([$a->id, $b->id], $this->ids($query + ['page' => 1]));
        $this->assertSame([$c->id], $this->ids($query + ['page' => 2]));
        $this->list($query)->assertJsonPath('meta.total', 3);
    }

    public function test_invalid_status_returns_422(): void
    {
        $this->list(['status' => 'done'])->assertUnprocessable()->assertJsonValidationErrors('status');
        $this->list(['status' => "ready' OR 1=1"])->assertUnprocessable()->assertJsonValidationErrors('status');
    }
}
