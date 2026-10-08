<?php

namespace Tests\Feature;

use App\Events\VideoStatusUpdated;
use App\Models\User;
use App\Models\Video;
use App\Models\VideoStatusLog;
use App\Support\ActivityLog;
use App\Support\VideoStatusLogger;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class ActivityLogTest extends TestCase
{
    use RefreshDatabase;

    private const UPLOAD_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

    private function login(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function makeVideo(array $attributes = []): Video
    {
        return Video::create($attributes + [
            'title' => 'video',
            'original_filename' => 'video.mp4',
            'status' => 'pending',
        ]);
    }

    private function uuid(int $n): string
    {
        return sprintf('%08x-0000-0000-0000-000000000000', $n);
    }

    private function row(array $attributes, $createdAt): VideoStatusLog
    {
        $log = VideoStatusLog::create($attributes);
        $log->forceFill(['created_at' => $createdAt])->save();

        return $log;
    }

    public function test_migration_adds_the_columns_and_video_id_accepts_null(): void
    {
        foreach (['upload_id', 'level', 'message'] as $column) {
            $this->assertTrue(Schema::hasColumn('video_status_logs', $column), $column);
        }

        $log = VideoStatusLog::create(['upload_id' => self::UPLOAD_A, 'message' => 'hello']);

        $this->assertNull($log->fresh()->video_id);
        $this->assertSame('info', $log->fresh()->level);
        $this->assertNull($log->fresh()->status);
    }

    public function test_prune_keeps_exactly_the_newest_100_groups(): void
    {
        $base = now()->subHours(5);

        // 105 groups: odd = video groups, even = upload-only groups; group $i is newer than $i-1.
        $videoIds = [];
        for ($i = 1; $i <= 105; $i++) {
            $at = $base->copy()->addMinutes($i);

            if ($i % 2 === 1) {
                $video = $this->makeVideo();
                $videoIds[$i] = $video->id;
                $this->row(['video_id' => $video->id, 'status' => 'pending', 'stage' => null, 'progress' => 0], $at);
                $this->row(['video_id' => $video->id, 'status' => 'processing', 'stage' => 'transcoding', 'progress' => 50], $at->copy()->addSeconds(10));
            } else {
                $this->row(['upload_id' => $this->uuid($i), 'message' => 'line'], $at);
            }
        }

        // Misc rows: one before the oldest kept group (group 6), one inside the window.
        $oldMisc = $this->row(['message' => 'old misc'], $base->copy()->addMinutes(2));
        $newMisc = $this->row(['message' => 'new misc'], $base->copy()->addMinutes(50));

        $this->assertSame(105, ActivityLog::groups()->count());

        ActivityLog::prune();

        $this->assertSame(100, ActivityLog::groups()->count());
        // Groups 1..5 are dropped (video groups 1,3,5 and upload groups 2,4).
        foreach ([1, 3, 5] as $i) {
            $this->assertSame(0, VideoStatusLog::where('video_id', $videoIds[$i])->count());
        }
        $this->assertSame(0, VideoStatusLog::whereIn('upload_id', [$this->uuid(2), $this->uuid(4)])->count());
        // Kept groups keep all their rows.
        $this->assertSame(2, VideoStatusLog::where('video_id', $videoIds[7])->count());
        $this->assertSame(2, VideoStatusLog::where('video_id', $videoIds[105])->count());
        $this->assertSame(1, VideoStatusLog::where('upload_id', $this->uuid(6))->count());
        $this->assertNull(VideoStatusLog::find($oldMisc->id));
        $this->assertNotNull(VideoStatusLog::find($newMisc->id));
    }

    public function test_progress_ticks_do_not_prune(): void
    {
        Event::fake([VideoStatusUpdated::class]);

        $video = $this->makeVideo();
        VideoStatusLogger::record($video->id, 'pending', null, 0);

        // Push the table over the retention limit without pruning.
        for ($i = 1; $i <= 101; $i++) {
            VideoStatusLog::create(['upload_id' => $this->uuid($i), 'message' => 'line']);
        }

        VideoStatusLogger::record($video->id, 'processing', 'transcoding', 10);
        VideoStatusLogger::record($video->id, 'processing', 'transcoding', 20);

        $this->assertSame(102, ActivityLog::groups()->count());
        $this->assertSame(3, VideoStatusLog::where('video_id', $video->id)->count());

        // A new group (first row of another video) does prune.
        $other = $this->makeVideo();
        VideoStatusLogger::record($other->id, 'pending', null, 0);

        $this->assertSame(100, ActivityLog::groups()->count());
    }

    public function test_logger_still_persists_and_broadcasts(): void
    {
        Event::fake([VideoStatusUpdated::class]);

        $video = $this->makeVideo();
        VideoStatusLogger::record($video->id, 'processing', 'merging', 7);

        $this->assertDatabaseHas('video_status_logs', ['video_id' => $video->id, 'status' => 'processing', 'stage' => 'merging', 'progress' => 7]);
        Event::assertDispatched(VideoStatusUpdated::class, fn ($e) => $e->videoId === $video->id && $e->progress === 7 && $e->uploadId === null);
    }

    public function test_broadcast_payload_carries_the_upload_id(): void
    {
        $uploadId = $this->uuid(1);

        $this->assertSame($uploadId, (new VideoStatusUpdated(1, 'pending', null, 0, $uploadId))->broadcastWith()['uploadId']);
        $this->assertNull((new VideoStatusUpdated(1, 'pending', null, 0))->broadcastWith()['uploadId']);
    }

    public function test_store_requires_authentication(): void
    {
        $this->post('/activity-log', ['entries' => [['message' => 'x']]])->assertRedirect(route('login'));
        $this->get('/activity-log')->assertRedirect(route('login'));
    }

    public function test_store_persists_entries_and_returns_the_count(): void
    {
        $this->login();

        $this->postJson('/activity-log', ['entries' => [
            ['upload_id' => self::UPLOAD_A, 'video_id' => null, 'level' => 'error', 'message' => '  Chunk failed  '],
            ['message' => 'No ids'],
        ]])->assertOk()->assertExactJson(['stored' => 2]);

        $this->assertDatabaseHas('video_status_logs', ['upload_id' => self::UPLOAD_A, 'video_id' => null, 'level' => 'error', 'message' => 'Chunk failed']);
        $this->assertDatabaseHas('video_status_logs', ['upload_id' => null, 'video_id' => null, 'level' => 'info', 'message' => 'No ids']);
    }

    public function test_store_validates_input(): void
    {
        $this->login();

        $this->postJson('/activity-log', [])->assertStatus(422);
        $this->postJson('/activity-log', ['entries' => []])->assertStatus(422);
        $this->postJson('/activity-log', ['entries' => [['message' => 'x', 'level' => 'debug']]])->assertStatus(422);
        $this->postJson('/activity-log', ['entries' => [['message' => 'x', 'upload_id' => 'not-a-uuid']]])->assertStatus(422);
        $this->postJson('/activity-log', ['entries' => [['level' => 'info']]])->assertStatus(422);
        $this->postJson('/activity-log', ['entries' => array_fill(0, 51, ['message' => 'x'])])->assertStatus(422);
        $this->postJson('/activity-log', ['entries' => array_fill(0, 50, ['message' => 'x'])])->assertOk()->assertJson(['stored' => 50]);
    }

    public function test_store_truncates_long_messages_and_strips_control_characters(): void
    {
        $this->login();

        $this->postJson('/activity-log', ['entries' => [
            ['message' => str_repeat('a', 600)],
            ['message' => "Hel\x00lo\x07 wor\nld"],
        ]])->assertOk();

        $long = VideoStatusLog::where('message', 'like', 'aaa%')->sole()->message;
        $this->assertSame(500, mb_strlen($long));
        $this->assertStringEndsWith('…', $long);
        $this->assertDatabaseHas('video_status_logs', ['message' => 'Hello world']);
    }

    public function test_store_clamps_the_timestamp(): void
    {
        $this->login();
        $this->freezeTime();

        $inside = now()->subHour();

        $this->postJson('/activity-log', ['entries' => [
            ['message' => 'inside', 'ts' => $inside->getTimestampMs()],
            ['message' => 'too old', 'ts' => now()->subDays(3)->getTimestampMs()],
            ['message' => 'future', 'ts' => now()->addHour()->getTimestampMs()],
            ['message' => 'none'],
        ]])->assertOk();

        $at = fn (string $m) => VideoStatusLog::where('message', $m)->value('created_at')->format('Y-m-d H:i:s');

        $this->assertSame($inside->format('Y-m-d H:i:s'), $at('inside'));
        $this->assertSame(now()->format('Y-m-d H:i:s'), $at('too old'));
        $this->assertSame(now()->format('Y-m-d H:i:s'), $at('future'));
        $this->assertSame(now()->format('Y-m-d H:i:s'), $at('none'));
    }

    public function test_store_nulls_unknown_video_ids_and_keeps_known_ones(): void
    {
        $this->login();
        $video = $this->makeVideo();

        $this->postJson('/activity-log', ['entries' => [
            ['video_id' => $video->id, 'message' => 'known'],
            ['video_id' => 999999, 'message' => 'unknown'],
        ]])->assertOk();

        $this->assertSame($video->id, VideoStatusLog::where('message', 'known')->value('video_id'));
        $this->assertNull(VideoStatusLog::where('message', 'unknown')->value('video_id'));
    }

    public function test_store_attaches_late_lines_to_the_video_created_from_that_upload(): void
    {
        $this->login();
        $video = $this->makeVideo(['upload_id' => self::UPLOAD_A]);

        $this->postJson('/activity-log', ['entries' => [['upload_id' => self::UPLOAD_A, 'message' => 'late']]])->assertOk();

        $this->assertSame($video->id, VideoStatusLog::where('message', 'late')->value('video_id'));
    }

    public function test_store_prunes_only_when_a_new_upload_group_starts(): void
    {
        $this->login();

        for ($i = 1; $i <= 100; $i++) {
            VideoStatusLog::create(['upload_id' => $this->uuid($i), 'message' => 'line'])
                ->forceFill(['created_at' => now()->subHours(2)->addMinutes($i)])->save();
        }

        // Existing group: no prune, 100 groups stay.
        $this->postJson('/activity-log', ['entries' => [['upload_id' => $this->uuid(50), 'message' => 'more']]])->assertOk();
        $this->assertSame(100, ActivityLog::groups()->count());

        // New group: pruned back to 100 and the oldest group is gone.
        $this->postJson('/activity-log', ['entries' => [['upload_id' => self::UPLOAD_A, 'message' => 'new group']]])->assertOk();
        $this->assertSame(100, ActivityLog::groups()->count());
        $this->assertSame(0, VideoStatusLog::where('upload_id', $this->uuid(1))->count());
        $this->assertSame(1, VideoStatusLog::where('upload_id', self::UPLOAD_A)->count());
    }

    public function test_store_rejects_an_unknown_kind(): void
    {
        $this->login();

        $this->postJson('/activity-log', ['entries' => [['message' => 'x', 'kind' => 'other']]])->assertStatus(422);
        $this->assertSame(0, VideoStatusLog::count());
    }

    public function test_store_keeps_an_interrupted_entry_when_no_video_exists(): void
    {
        $this->login();

        $this->postJson('/activity-log', ['entries' => [
            ['upload_id' => self::UPLOAD_A, 'level' => 'error', 'kind' => 'interrupted', 'message' => 'Upload interrupted: a.mp4.'],
            ['upload_id' => self::UPLOAD_A, 'message' => 'normal line'],
        ]])->assertOk()->assertJson(['stored' => 2]);

        $this->assertDatabaseHas('video_status_logs', ['upload_id' => self::UPLOAD_A, 'level' => 'error', 'message' => 'Upload interrupted: a.mp4.']);
    }

    public function test_store_skips_an_interrupted_entry_when_the_upload_already_has_a_video(): void
    {
        $this->login();
        $this->makeVideo(['upload_id' => self::UPLOAD_A]);

        $this->postJson('/activity-log', ['entries' => [
            ['upload_id' => self::UPLOAD_A, 'kind' => 'interrupted', 'level' => 'error', 'message' => 'Upload interrupted: a.mp4.'],
            ['upload_id' => self::UPLOAD_A, 'message' => 'normal line'],
        ]])->assertOk()->assertJson(['stored' => 1]);

        $this->assertSame(0, VideoStatusLog::where('message', 'like', 'Upload interrupted:%')->count());
        $this->assertDatabaseHas('video_status_logs', ['message' => 'normal line']);
    }

    public function test_store_interrupted_entry_is_idempotent_per_upload_id(): void
    {
        $this->login();
        $entry = ['upload_id' => self::UPLOAD_A, 'kind' => 'interrupted', 'level' => 'error', 'message' => 'Upload interrupted: a.mp4.'];

        $this->postJson('/activity-log', ['entries' => [$entry]])->assertOk()->assertJson(['stored' => 1]);
        $this->postJson('/activity-log', ['entries' => [$entry, $entry]])->assertOk()->assertJson(['stored' => 0]);

        $this->assertSame(1, VideoStatusLog::where('upload_id', self::UPLOAD_A)->count());

        // Duplicates inside a single request are skipped too.
        $this->postJson('/activity-log', ['entries' => [
            ['upload_id' => $this->uuid(7), 'kind' => 'interrupted', 'message' => 'Upload interrupted: b.mp4.'],
            ['upload_id' => $this->uuid(7), 'kind' => 'interrupted', 'message' => 'Upload interrupted: b.mp4. 2 more file(s) were not started.'],
        ]])->assertOk()->assertJson(['stored' => 1]);
    }

    public function test_store_interrupted_entry_without_upload_id_is_deduped_within_120_seconds(): void
    {
        $this->login();
        $this->freezeTime();
        $entry = ['kind' => 'interrupted', 'level' => 'error', 'message' => 'Upload interrupted: a.mp4.'];

        $this->postJson('/activity-log', ['entries' => [$entry]])->assertOk()->assertJson(['stored' => 1]);
        $this->postJson('/activity-log', ['entries' => [$entry]])->assertOk()->assertJson(['stored' => 0]);
        $this->assertSame(1, VideoStatusLog::where('message', $entry['message'])->count());

        $this->travel(121)->seconds();

        $this->postJson('/activity-log', ['entries' => [$entry]])->assertOk()->assertJson(['stored' => 1]);
        $this->assertSame(2, VideoStatusLog::where('message', $entry['message'])->count());
    }

    public function test_store_ignores_an_entry_whose_cid_was_already_stored(): void
    {
        $this->login();
        $failed = ['cid' => 'c0000001-aaaa', 'level' => 'error', 'message' => 'a.mp4 failed: Failed to fetch', 'upload_id' => self::UPLOAD_A];
        $summary = ['cid' => 'c0000002-aaaa', 'level' => 'error', 'message' => 'Upload failed: 0/1 file(s) uploaded.', 'upload_id' => self::UPLOAD_A];

        $this->postJson('/activity-log', ['entries' => [$failed, $summary]])->assertOk()->assertExactJson(['stored' => 2]);

        // Redelivery (retry, reload during an in-flight request), alone or mixed with a new line.
        $this->postJson('/activity-log', ['entries' => [$failed, $summary]])->assertOk()->assertExactJson(['stored' => 0]);
        $this->postJson('/activity-log', ['entries' => [$failed, ['cid' => 'c0000003-aaaa', 'message' => 'New line']]])->assertOk()->assertExactJson(['stored' => 1]);

        // The same cid twice inside one request is stored once.
        $this->postJson('/activity-log', ['entries' => [['cid' => 'c0000004-aaaa', 'message' => 'Twice'], ['cid' => 'c0000004-aaaa', 'message' => 'Twice']]])
            ->assertOk()->assertExactJson(['stored' => 1]);

        $this->assertSame(1, VideoStatusLog::where('message', 'a.mp4 failed: Failed to fetch')->count());
        $this->assertSame(1, VideoStatusLog::where('message', 'Upload failed: 0/1 file(s) uploaded.')->count());
        $this->assertSame(1, VideoStatusLog::where('message', 'Twice')->count());
        $this->assertSame(4, VideoStatusLog::count());
    }

    public function test_store_keeps_entries_without_a_cid_and_rejects_a_malformed_cid(): void
    {
        $this->login();

        $this->postJson('/activity-log', ['entries' => [['message' => 'Same'], ['message' => 'Same']]])->assertOk()->assertExactJson(['stored' => 2]);
        $this->postJson('/activity-log', ['entries' => [['cid' => 'bad cid!', 'message' => 'x']]])->assertStatus(422);
    }

    public function test_index_reports_which_pending_cids_are_already_stored(): void
    {
        $this->login();
        $this->postJson('/activity-log', ['entries' => [['cid' => 'c0000001-aaaa', 'message' => 'Stored line']]])->assertOk();

        $this->getJson('/activity-log?cids='.rawurlencode('c0000001-aaaa,c0000009-aaaa,bad cid!'))
            ->assertOk()
            ->assertJsonPath('stored_cids', ['c0000001-aaaa']);

        $this->getJson('/activity-log')->assertOk()->assertJsonPath('stored_cids', []);
    }

    public function test_store_does_not_dedupe_entries_without_a_kind(): void
    {
        $this->login();
        $entry = ['upload_id' => self::UPLOAD_A, 'message' => 'Upload interrupted: a.mp4.'];

        $this->postJson('/activity-log', ['entries' => [$entry]])->assertOk()->assertJson(['stored' => 1]);
        $this->postJson('/activity-log', ['entries' => [$entry]])->assertOk()->assertJson(['stored' => 1]);
    }

    public function test_store_is_throttled(): void
    {
        $this->login();

        for ($i = 0; $i < 120; $i++) {
            $this->postJson('/activity-log', ['entries' => [['message' => 'x']]])->assertOk();
        }

        $this->postJson('/activity-log', ['entries' => [['message' => 'x']]])->assertStatus(429);
    }

    public function test_index_returns_the_newest_ten_groups_chronologically_with_misc_rows(): void
    {
        $this->login();
        $base = now()->subHours(3);

        $videos = [];
        // 12 groups, alternating video / upload-only; group $i starts at base + $i minutes.
        for ($i = 1; $i <= 12; $i++) {
            $at = $base->copy()->addMinutes($i);

            if ($i % 2 === 0) {
                $videos[$i] = $this->makeVideo(['title' => "Video {$i}", 'status' => 'processing']);
                $this->row(['video_id' => $videos[$i]->id, 'status' => 'pending', 'stage' => null, 'progress' => 0], $at);
                $this->row(['video_id' => $videos[$i]->id, 'level' => 'info', 'message' => "client {$i}"], $at->copy()->addSeconds(20));
            } else {
                $this->row(['upload_id' => $this->uuid($i), 'level' => 'error', 'message' => "upload {$i}"], $at);
            }
        }

        $this->row(['message' => 'misc old'], $base->copy()->addMinutes(2)->addSeconds(30)); // before group 3 (oldest displayed)
        $this->row(['message' => 'misc in'], $base->copy()->addMinutes(7)->addSeconds(5));

        $response = $this->getJson('/activity-log')->assertOk();
        $entries = $response->json('entries');

        // Groups 3..12 are displayed.
        $messages = array_column($entries, 'message');
        $this->assertNotContains('upload 1', $messages);
        $this->assertNotContains('client 2', $messages);
        $this->assertNotContains('misc old', $messages);
        $this->assertContains('upload 3', $messages);
        $this->assertContains('misc in', $messages);
        $this->assertContains('client 12', $messages);

        // Chronological and interleaved: misc in (7m05s) sits between group 7 (7m00s) and group 8 (8m00s).
        $times = array_column($entries, 'created_at');
        $sorted = $times;
        sort($sorted);
        $this->assertSame($sorted, $times);
        $this->assertSame(
            ['upload 7', 'misc in'],
            array_slice(array_values(array_filter($messages, fn ($m) => in_array($m, ['upload 7', 'misc in'], true))), 0, 2),
        );

        $response->assertJsonPath("videos.{$videos[12]->id}.title", 'Video 12');
        $response->assertJsonPath("videos.{$videos[12]->id}.status", 'processing');
        $this->assertArrayNotHasKey($videos[2]->id, $response->json('videos'));

        $first = $entries[0];
        $this->assertEqualsCanonicalizing(
            ['id', 'video_id', 'upload_id', 'level', 'message', 'status', 'stage', 'progress', 'created_at'],
            array_keys($first),
        );
    }

    public function test_index_with_no_data_returns_empty_collections(): void
    {
        $this->login();

        $this->getJson('/activity-log')->assertOk()->assertExactJson(['entries' => [], 'videos' => [], 'stored_cids' => []]);
    }
}
