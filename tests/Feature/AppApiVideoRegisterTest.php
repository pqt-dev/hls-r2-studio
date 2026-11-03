<?php

namespace Tests\Feature;

use App\Models\Video;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppApiVideoRegisterTest extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    private const PUBLIC_ID = 'ab12cd34ef56';

    private const PREFIX = '2026/11/03/my-clip-ab12cd34ef56/';

    private string $token;

    protected function setUp(): void
    {
        parent::setUp();

        $this->configureR2();
        $this->token = $this->tokenFor($this->makeUser());
    }

    private function payload(array $overrides = []): array
    {
        return $overrides + [
            'public_id' => self::PUBLIC_ID,
            'title' => 'My clip',
            'original_filename' => 'my clip.mp4',
            'original_size_bytes' => 123456,
            'disk_prefix' => self::PREFIX,
            'playlist_path' => self::PREFIX.'playlist.m3u8',
            'thumbnail_path' => self::PREFIX.'thumbnail.jpg',
            'storyboards' => [
                '3x3' => ['path' => self::PREFIX.'storyboard_3x3.jpg'],
                '5x5' => ['path' => self::PREFIX.'storyboard_5x5.jpg'],
            ],
            'duration' => 12.5,
            'output_width' => 1280,
            'output_height' => 720,
            'output_fps' => 29.97,
            'output_bitrate_kbps' => 2500,
            'output_codec' => 'h264',
        ];
    }

    private function fakeR2(bool $withPlaylist = true): Filesystem
    {
        $fake = Storage::fake('r2-test');

        if ($withPlaylist) {
            $fake->put(self::PREFIX.'playlist.m3u8', '#EXTM3U');
        }

        Storage::partialMock()->shouldReceive('build')->andReturn($fake);

        return $fake;
    }

    private function register(array $payload): TestResponse
    {
        return $this->apiAs($this->token, 'POST', '/api/app/videos', $payload);
    }

    public function test_requires_a_token(): void
    {
        $this->apiAs(null, 'POST', '/api/app/videos', $this->payload())->assertUnauthorized();
        $this->assertSame(0, Video::count());
    }

    public function test_registers_a_ready_video(): void
    {
        $this->fakeR2();

        $response = $this->register($this->payload());

        $video = Video::firstOrFail();
        $this->assertNoStore($response);
        $response->assertCreated()
            ->assertExactJson([
                'id' => $video->id,
                'public_id' => self::PUBLIC_ID,
                'embed_url' => url('/embed/'.self::PUBLIC_ID),
            ]);
        $this->assertSame('ready', $video->status);
        $this->assertSame('ready', $video->stage);
        $this->assertSame(100, $video->progress);
        $this->assertNull($video->error_message);
        $this->assertNull($video->error_detail);
        $this->assertNull($video->failed_at);
        $this->assertSame(self::PREFIX, $video->disk_prefix);
        $this->assertSame(self::PREFIX.'playlist.m3u8', $video->playlist_path);
        $this->assertSame(self::PREFIX.'thumbnail.jpg', $video->thumbnail_path);
        $this->assertSame(['3x3', '5x5'], array_keys($video->storyboards));
        $this->assertSame(123456, $video->original_size_bytes);
        $this->assertSame(1280, $video->output_width);
        $this->assertSame('h264', $video->output_codec);
    }

    public function test_minimal_payload_is_accepted(): void
    {
        $this->fakeR2();

        $this->register([
            'public_id' => self::PUBLIC_ID,
            'title' => 'T',
            'original_filename' => 'a.mp4',
            'original_size_bytes' => 1,
            'disk_prefix' => self::PREFIX,
            'playlist_path' => self::PREFIX.'playlist.m3u8',
        ])->assertCreated();

        $this->assertNull(Video::first()->thumbnail_path);
        $this->assertNull(Video::first()->storyboards);
    }

    public function test_new_video_is_reachable_on_the_public_embed_page(): void
    {
        $this->fakeR2();
        $this->register($this->payload())->assertCreated();

        $this->get('/embed/'.self::PUBLIC_ID)->assertOk();
    }

    public function test_repeating_the_same_registration_is_idempotent(): void
    {
        $this->fakeR2();
        $first = $this->register($this->payload())->assertCreated()->json();

        $this->register($this->payload(['title' => 'Changed title']))->assertOk()->assertExactJson($first);

        $this->assertSame(1, Video::count());
        $this->assertSame('My clip', Video::first()->title);
    }

    public function test_idempotent_retry_does_not_need_r2(): void
    {
        Video::create([
            'public_id' => self::PUBLIC_ID, 'title' => 'x', 'original_filename' => 'x.mp4', 'status' => 'ready',
            'disk_prefix' => self::PREFIX, 'playlist_path' => self::PREFIX.'playlist.m3u8',
        ]);
        Storage::partialMock()->shouldReceive('build')->never();

        $this->register($this->payload())->assertOk()->assertJsonPath('public_id', self::PUBLIC_ID);
    }

    public function test_same_public_id_with_another_prefix_conflicts(): void
    {
        $this->fakeR2();
        $this->register($this->payload())->assertCreated();

        $other = '2026/11/04/another-clip-'.self::PUBLIC_ID.'/';
        $this->register($this->payload([
            'disk_prefix' => $other,
            'playlist_path' => $other.'playlist.m3u8',
            'thumbnail_path' => null,
            'storyboards' => null,
        ]))->assertStatus(409)->assertExactJson(['error' => 'public_id_conflict']);

        $this->assertSame(1, Video::count());
        $this->assertSame(self::PREFIX, Video::first()->disk_prefix);
    }

    public function test_unique_race_is_resolved_by_rereading(): void
    {
        $this->fakeR2();
        $created = false;
        // Simulate another request inserting the row between the existence check and the insert.
        Video::creating(function (Video $video) use (&$created) {
            if (! $created) {
                $created = true;
                DB::table('videos')->insert([
                    'public_id' => $video->public_id, 'title' => 'racer', 'original_filename' => 'r.mp4', 'status' => 'ready',
                    'disk_prefix' => $video->disk_prefix, 'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        });

        $this->register($this->payload())->assertOk()->assertJsonPath('public_id', self::PUBLIC_ID);
        $this->assertSame(1, Video::count());
    }

    public function test_unique_race_with_another_prefix_conflicts(): void
    {
        $this->fakeR2();
        $created = false;
        Video::creating(function (Video $video) use (&$created) {
            if (! $created) {
                $created = true;
                DB::table('videos')->insert([
                    'public_id' => $video->public_id, 'title' => 'racer', 'original_filename' => 'r.mp4', 'status' => 'ready',
                    'disk_prefix' => '2026/11/03/zzz-'.$video->public_id.'/', 'created_at' => now(), 'updated_at' => now(),
                ]);
            }
        });

        $this->register($this->payload())->assertStatus(409)->assertExactJson(['error' => 'public_id_conflict']);
    }

    public function test_missing_playlist_on_r2_returns_422(): void
    {
        $this->fakeR2(withPlaylist: false);

        $this->register($this->payload())->assertStatus(422)->assertExactJson(['error' => 'playlist_not_found']);

        $this->assertSame(0, Video::count());
    }

    public function test_r2_failure_returns_503_without_details(): void
    {
        $disk = \Mockery::mock(Filesystem::class);
        $disk->shouldReceive('exists')->andThrow(new \RuntimeException('boom secret-leak https://acc.r2.cloudflarestorage.com'));
        Storage::partialMock()->shouldReceive('build')->once()->andReturn($disk);

        $response = $this->register($this->payload());

        $response->assertStatus(503)->assertExactJson(['error' => 'storage_unavailable']);
        $this->assertStringNotContainsString('secret-leak', $response->getContent());
        $this->assertSame(0, Video::count());
    }

    /**
     * @return array<string, array{0: array<string, mixed>, 1: string}>
     */
    public static function invalidPayloads(): array
    {
        $prefix = self::PREFIX;

        return [
            'public_id too short' => [['public_id' => 'abc'], 'public_id'],
            'public_id uppercase' => [['public_id' => 'AB12CD34EF56'], 'public_id'],
            'public_id too long' => [['public_id' => 'ab12cd34ef567'], 'public_id'],
            'public_id numeric legacy' => [['public_id' => '123'], 'public_id'],
            'missing title' => [['title' => ''], 'title'],
            'long title' => [['title' => str_repeat('a', 256)], 'title'],
            'missing filename' => [['original_filename' => null], 'original_filename'],
            'long filename' => [['original_filename' => str_repeat('a', 256)], 'original_filename'],
            'zero size' => [['original_size_bytes' => 0], 'original_size_bytes'],
            'non-integer size' => [['original_size_bytes' => 'big'], 'original_size_bytes'],
            'prefix of another public id' => [['disk_prefix' => '2026/11/03/my-clip-zz12cd34ef56/'], 'disk_prefix'],
            'prefix without trailing slash' => [['disk_prefix' => '2026/11/03/my-clip-ab12cd34ef56'], 'disk_prefix'],
            'prefix with bad date' => [['disk_prefix' => '26/11/03/my-clip-ab12cd34ef56/'], 'disk_prefix'],
            'prefix with traversal' => [['disk_prefix' => '2026/11/03/../x-ab12cd34ef56/'], 'disk_prefix'],
            'prefix with uppercase slug' => [['disk_prefix' => '2026/11/03/My-clip-ab12cd34ef56/'], 'disk_prefix'],
            'prefix with extra segment' => [['disk_prefix' => 'evil/2026/11/03/my-clip-ab12cd34ef56/'], 'disk_prefix'],
            'prefix missing' => [['disk_prefix' => null], 'disk_prefix'],
            'wrong playlist' => [['playlist_path' => $prefix.'other.m3u8'], 'playlist_path'],
            'playlist outside prefix' => [['playlist_path' => 'other/playlist.m3u8'], 'playlist_path'],
            'playlist missing' => [['playlist_path' => null], 'playlist_path'],
            'wrong thumbnail' => [['thumbnail_path' => $prefix.'thumb.jpg'], 'thumbnail_path'],
            'thumbnail outside prefix' => [['thumbnail_path' => 'x/thumbnail.jpg'], 'thumbnail_path'],
            'unknown storyboard key' => [['storyboards' => ['2x2' => ['path' => $prefix.'storyboard_2x2.jpg']]], 'storyboards'],
            'storyboard key mismatch' => [['storyboards' => ['3x3' => ['path' => $prefix.'storyboard_4x4.jpg']]], 'storyboards'],
            'storyboard outside prefix' => [['storyboards' => ['3x3' => ['path' => 'x/storyboard_3x3.jpg']]], 'storyboards'],
            'storyboard extra field' => [['storyboards' => ['3x3' => ['path' => $prefix.'storyboard_3x3.jpg', 'x' => 1]]], 'storyboards'],
            'storyboard without path' => [['storyboards' => ['3x3' => []]], 'storyboards'],
            'storyboard as list' => [['storyboards' => [['path' => $prefix.'storyboard_3x3.jpg']]], 'storyboards'],
            'storyboard not array' => [['storyboards' => 'x'], 'storyboards'],
            'negative duration' => [['duration' => -1], 'duration'],
            'non-numeric duration' => [['duration' => 'long'], 'duration'],
            'zero width' => [['output_width' => 0], 'output_width'],
            'zero height' => [['output_height' => 0], 'output_height'],
            'fractional bitrate' => [['output_bitrate_kbps' => 1.5], 'output_bitrate_kbps'],
            'non-numeric fps' => [['output_fps' => 'fast'], 'output_fps'],
            'long codec' => [['output_codec' => str_repeat('a', 21)], 'output_codec'],
        ];
    }

    #[DataProvider('invalidPayloads')]
    public function test_validation_rejects_bad_input(array $overrides, string $field): void
    {
        $this->fakeR2();

        $this->register($this->payload($overrides))->assertStatus(422)->assertJsonValidationErrors($field);

        $this->assertSame(0, Video::count());
    }

    public function test_all_three_storyboard_sizes_are_accepted(): void
    {
        $this->fakeR2();
        $storyboards = [];
        foreach (['3x3', '4x4', '5x5'] as $size) {
            $storyboards[$size] = ['path' => self::PREFIX."storyboard_{$size}.jpg"];
        }

        $this->register($this->payload(['storyboards' => $storyboards]))->assertCreated();
    }

    private function longPrefix(int $length): string
    {
        $head = '2026/11/03/';
        $tail = '-'.self::PUBLIC_ID.'/';
        $prefix = $head.str_repeat('a', $length - strlen($head) - strlen($tail)).$tail;
        $this->assertSame($length, strlen($prefix));

        return $prefix;
    }

    public function test_prefix_over_255_chars_is_a_validation_error(): void
    {
        $this->fakeR2();
        $prefix = $this->longPrefix(256);

        $response = $this->register($this->payload([
            'disk_prefix' => $prefix,
            'playlist_path' => $prefix.'playlist.m3u8',
            'thumbnail_path' => null,
            'storyboards' => null,
        ]));

        $response->assertStatus(422)->assertJsonValidationErrors('disk_prefix');
        $this->assertSame(0, Video::count());
    }

    public function test_paths_at_the_255_char_boundary_are_accepted(): void
    {
        // 237 + len('storyboard_3x3.jpg') = 255 characters.
        $prefix = $this->longPrefix(237);
        $fake = $this->fakeR2(withPlaylist: false);
        $fake->put($prefix.'playlist.m3u8', '#EXTM3U');

        $this->register($this->payload([
            'disk_prefix' => $prefix,
            'playlist_path' => $prefix.'playlist.m3u8',
            'thumbnail_path' => $prefix.'thumbnail.jpg',
            'storyboards' => ['3x3' => ['path' => $prefix.'storyboard_3x3.jpg']],
        ]))->assertCreated();

        $this->assertSame($prefix, Video::firstOrFail()->disk_prefix);
        $this->assertSame(255, strlen(Video::first()->storyboards['3x3']['path']));
    }

    public function test_storyboard_path_over_255_chars_is_a_validation_error(): void
    {
        $prefix = $this->longPrefix(238);
        $this->fakeR2();

        $this->register($this->payload([
            'disk_prefix' => $prefix,
            'playlist_path' => $prefix.'playlist.m3u8',
            'thumbnail_path' => null,
            'storyboards' => ['3x3' => ['path' => $prefix.'storyboard_3x3.jpg']],
        ]))->assertStatus(422)->assertJsonValidationErrors('storyboards');

        $this->assertSame(0, Video::count());
    }

    public function test_playlist_path_over_255_chars_is_a_validation_error(): void
    {
        $prefix = $this->longPrefix(250);
        $this->fakeR2();

        $this->register($this->payload([
            'disk_prefix' => $prefix,
            'playlist_path' => $prefix.'playlist.m3u8',
            'thumbnail_path' => null,
            'storyboards' => null,
        ]))->assertStatus(422)->assertJsonValidationErrors('playlist_path');
    }

    private function existingVideo(): Video
    {
        return Video::create([
            'public_id' => self::PUBLIC_ID, 'title' => 'x', 'original_filename' => 'x.mp4', 'status' => 'ready',
            'disk_prefix' => self::PREFIX, 'playlist_path' => self::PREFIX.'playlist.m3u8',
        ]);
    }

    public function test_retry_of_an_existing_video_skips_the_remaining_validation(): void
    {
        $video = $this->existingVideo();
        Storage::partialMock()->shouldReceive('build')->never();

        $response = $this->register($this->payload([
            'title' => '   ',
            'original_size_bytes' => 'bad',
            'playlist_path' => 'wrong',
            'storyboards' => 'x',
        ]));

        $response->assertOk()->assertExactJson([
            'id' => $video->id,
            'public_id' => self::PUBLIC_ID,
            'embed_url' => url('/embed/'.self::PUBLIC_ID),
        ]);
        $this->assertSame(1, Video::count());
    }

    public function test_retry_of_an_existing_video_with_another_prefix_conflicts_without_leaks(): void
    {
        $this->existingVideo();

        $response = $this->register($this->payload(['disk_prefix' => '2026/11/04/other-'.self::PUBLIC_ID.'/', 'title' => '']));

        $response->assertStatus(409)->assertExactJson(['error' => 'public_id_conflict']);
        $this->assertNoLeak($response);
    }

    public function test_retry_of_an_existing_video_without_a_prefix_conflicts(): void
    {
        $this->existingVideo();

        foreach ([null, ['x'], 123] as $value) {
            $payload = $this->payload(['disk_prefix' => $value]);
            if ($value === null) {
                unset($payload['disk_prefix']);
            }

            $response = $this->register($payload);

            $response->assertStatus(409)->assertExactJson(['error' => 'public_id_conflict']);
            $this->assertNoLeak($response);
        }
    }

    public function test_malformed_public_id_is_validated_and_not_looked_up(): void
    {
        $this->existingVideo();

        $response = $this->register($this->payload(['public_id' => self::PUBLIC_ID.'x']));

        $response->assertStatus(422)->assertJsonValidationErrors('public_id');
        $this->assertNoLeak($response);
    }

    public function test_new_public_id_with_invalid_fields_is_a_validation_error(): void
    {
        $this->fakeR2();

        $response = $this->register($this->payload(['title' => '   ']));

        $response->assertStatus(422)->assertJsonValidationErrors('title');
        $this->assertNoLeak($response);
        $this->assertSame(0, Video::count());
    }

    private function assertNoLeak(TestResponse $response): void
    {
        $content = $response->getContent();
        foreach (['exception', 'trace', 'Exception', 'SQLSTATE', 'vendor/', 'file'] as $needle) {
            $this->assertStringNotContainsString($needle, $content);
        }
    }

    public function test_validation_runs_before_any_r2_call(): void
    {
        Storage::partialMock()->shouldReceive('build')->never();

        $this->register($this->payload(['public_id' => 'bad']))->assertStatus(422);
    }
}
