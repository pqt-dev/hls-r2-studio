<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LogsPageTest extends TestCase
{
    use RefreshDatabase;

    private function seedVideos(string $status, int $count, string $prefix): void
    {
        for ($i = 1; $i <= $count; $i++) {
            $video = Video::create([
                'title' => sprintf('%s-%03d', $prefix, $i),
                'original_filename' => 'f.mp4',
                'status' => $status,
                'disk_prefix' => 'p/',
            ]);
            $video->forceFill(['created_at' => now()->subMinutes(1000 - $i)])->save();
        }
    }

    private function logTitles(string $html, string $prefix): int
    {
        return preg_match_all('/'.$prefix.'-\d{3}/', $html);
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function seedInProgress(string $status, ?string $stage, string $title): void
    {
        $video = Video::create([
            'title' => $title,
            'original_filename' => 'f.mp4',
            'status' => $status,
            'disk_prefix' => 'p/',
        ]);
        $video->forceFill(['stage' => $stage])->save();
    }

    public function test_success_list_shows_only_latest_10_with_caption_and_true_total(): void
    {
        $this->seedVideos('ready', 30, 'ok');

        $response = $this->get('/logs')->assertOk()
            ->assertSee('Showing latest 10 of 30')
            ->assertDontSee('success_page', false)
            ->assertDontSee('Next', false);
        $html = $response->getContent();
        $this->assertSame(10, $this->logTitles($html, 'ok'));
        $this->assertStringContainsString('ok-030', $html);
        $this->assertStringNotContainsString('ok-020', $html);
        $this->assertMatchesRegularExpression('/>\s*30\s*<\/span>/', $html);
    }

    public function test_error_list_is_limited_to_10_and_no_caption_when_within_limit(): void
    {
        $this->seedVideos('failed', 27, 'bad');
        $this->seedVideos('ready', 3, 'ok');

        $response = $this->get('/logs')->assertOk()
            ->assertSee('Showing latest 10 of 27');
        $this->assertSame(10, $this->logTitles($response->getContent(), 'bad'));
        $this->assertSame(3, $this->logTitles($response->getContent(), 'ok'));
        $this->assertSame(1, substr_count($response->getContent(), 'Showing latest'));
    }

    public function test_in_progress_card_lists_pending_and_processing_videos(): void
    {
        $this->seedInProgress('pending', null, 'wait-video');
        $this->seedInProgress('processing', 'uploading_r2', 'busy-video');

        $this->get('/logs')->assertOk()
            ->assertSee('data-in-progress-card', false)
            ->assertSee('Processing 2 videos')
            ->assertSee('wait-video')
            ->assertSee('busy-video')
            ->assertSee('Queued')
            ->assertSee('Uploading to R2')
            ->assertSee('View live progress')
            ->assertSee('data-log-list="processing"', false)
            ->assertViewHas('processingCount', 2);
    }

    public function test_in_progress_card_renders_per_row_percent_and_overall_percent(): void
    {
        $this->seedInProgress('pending', null, 'wait-video');
        $busy = Video::create([
            'title' => 'busy-video',
            'original_filename' => 'f.mp4',
            'status' => 'processing',
            'disk_prefix' => 'p/',
        ]);
        $busy->forceFill(['stage' => 'transcoding', 'progress' => 60])->save();
        $pending = Video::where('title', 'wait-video')->first();

        $html = $this->get('/logs')->assertOk()->getContent();

        $this->assertStringContainsString('data-video-id="'.$busy->id.'"', $html);
        $this->assertStringContainsString('data-video-id="'.$pending->id.'"', $html);
        $this->assertSame(2, substr_count($html, 'data-video-percent>'));
        $this->assertMatchesRegularExpression('/data-video-percent>60%</', $html);
        $this->assertMatchesRegularExpression('/data-video-percent>0%</', $html);
        $this->assertMatchesRegularExpression('/aria-valuenow="30"[^>]*data-live-ring>/', $html);
        $this->assertStringContainsString('stroke-dashoffset="70"', $html);
    }

    public function test_live_panel_renders_label_ring_and_summary(): void
    {
        $this->seedInProgress('pending', null, 'wait-video');
        $busy = Video::create([
            'title' => 'busy-video',
            'original_filename' => 'f.mp4',
            'status' => 'processing',
            'disk_prefix' => 'p/',
        ]);
        $busy->forceFill(['stage' => 'transcoding', 'progress' => 60])->save();

        $html = $this->get('/logs')->assertOk()
            ->assertSee('role="group" aria-label="Videos in progress"', false)
            ->assertSee('data-live-ring', false)
            ->assertSee('Live')
            ->assertSee('Processing 2 videos')
            ->assertSee('aria-live="polite"', false)
            ->getContent();

        $this->assertStringNotContainsString('data-live-segment', $html);
        $this->assertStringContainsString('data-live-summary>1 queued · 1 transcoding<', $html);
        $this->assertMatchesRegularExpression('/data-overall-total>2</', $html);
        $this->assertMatchesRegularExpression('/data-video-percent>60%</', $html);
        $this->assertMatchesRegularExpression('/data-video-percent>0%</', $html);
    }

    public function test_rows_are_limited_but_total_count_is_kept(): void
    {
        $this->seedVideos('processing', 30, 'busy');

        $response = $this->get('/logs')->assertOk()->assertViewHas('processingCount', 30);
        $html = $response->getContent();

        $this->assertStringContainsString('+5 more', $html);
        $this->assertSame(25, substr_count($html, 'data-video-percent>'));
        $this->assertStringContainsString('Processing 30 videos', $html);
    }

    public function test_page_is_titled_logs_and_lists_have_no_inner_scroll(): void
    {
        $this->seedVideos('ready', 2, 'ok');
        $this->seedVideos('failed', 2, 'bad');

        $response = $this->get('/logs')->assertOk()
            ->assertSee('Logs - HLS R2 Studio')
            ->assertSee('Home / Logs')
            ->assertDontSee('Upload Logs');
        $html = $response->getContent();

        $this->assertStringNotContainsString('max-h-[480px]', $html);
        $this->assertDoesNotMatchRegularExpression('/class="[^"]*overflow-y-auto[^"]*" data-log-list/', $html);
    }

    public function test_in_progress_card_is_rendered_hidden_when_nothing_is_in_progress(): void
    {
        $this->seedVideos('ready', 2, 'ok');

        $html = $this->get('/logs')->assertOk()
            ->assertSee('aria-label="Videos in progress"', false)
            ->assertDontSee('data-video-percent>', false)
            ->getContent();

        $this->assertMatchesRegularExpression('/<div [^>]*data-in-progress-card[^>]*\shidden[\s>]/s', $html);
    }

    public function test_in_progress_card_is_not_hidden_when_a_video_is_in_progress(): void
    {
        $this->seedInProgress('pending', null, 'wait-video');

        $html = $this->get('/logs')->assertOk()->getContent();

        preg_match('/<div [^>]*data-in-progress-card[^>]*>/s', $html, $m);
        $this->assertDoesNotMatchRegularExpression('/\shidden[\s>]/', $m[0]);
    }

    public function test_totals_add_up_across_all_statuses(): void
    {
        $this->seedVideos('ready', 4, 'ok');
        $this->seedVideos('failed', 2, 'bad');
        $this->seedInProgress('pending', null, 'p1');
        $this->seedInProgress('processing', 'transcoding', 'p2');

        $this->get('/logs')->assertOk()
            ->assertViewHas('totalCount', 8)
            ->assertViewHas('successCount', 4)
            ->assertViewHas('errorCount', 2)
            ->assertViewHas('processingCount', 2);
    }

    private function seedFailedVideo(array $attributes = []): Video
    {
        $video = Video::create(array_merge([
            'title' => 'broken-video',
            'original_filename' => 'f.mp4',
            'status' => 'failed',
            'error_message' => 'Generic failure text.',
        ], $attributes));
        $video->forceFill(['created_at' => '2026-01-02 03:04:00'])->save();

        return $video;
    }

    private function errorCard(string $html): string
    {
        preg_match('/data-log-list="error">(.*?)data-log-list="success"/s', $html, $m);

        return $m[1] ?? '';
    }

    public function test_error_card_shows_the_failed_time_instead_of_the_created_time(): void
    {
        $video = $this->seedFailedVideo(['failed_at' => '2026-03-04 05:06:00']);
        $video->refresh();

        $card = $this->errorCard($this->get('/logs')->assertOk()->getContent());

        $this->assertStringContainsString('title="Failed at"', $card);
        $this->assertStringContainsString($video->failed_at->toDisplay('j M Y, H:i'), $card);
        $this->assertStringNotContainsString($video->created_at->toDisplay('j M Y, H:i'), $card);
    }

    public function test_error_list_is_ordered_by_most_recently_failed_not_created(): void
    {
        // Created order is the reverse of failed order: bad-001 is the oldest upload but failed last.
        for ($i = 1; $i <= 27; $i++) {
            $video = Video::create([
                'title' => sprintf('bad-%03d', $i),
                'original_filename' => 'f.mp4',
                'status' => 'failed',
                'disk_prefix' => 'p/',
            ]);
            $video->forceFill([
                'created_at' => now()->subDays(100 - $i),
                'failed_at' => now()->subMinutes($i),
            ])->save();
        }

        $html = $this->get('/logs')->assertOk()->getContent();
        $card = $this->errorCard($html);

        $this->assertSame(10, $this->logTitles($card, 'bad'));
        $this->assertLessThan(strpos($card, 'bad-002'), strpos($card, 'bad-001'));
        $this->assertStringContainsString('bad-010', $card);
        $this->assertStringNotContainsString('bad-011', $card);
        $this->assertStringNotContainsString('bad-027', $card);
    }

    public function test_error_card_shows_technical_details_escaped(): void
    {
        $video = $this->seedFailedVideo(['error_detail' => 'RuntimeException: <script>alert(1)</script>']);

        $card = $this->errorCard($this->get('/logs')->assertOk()->getContent());

        $this->assertStringContainsString('Generic failure text.', $card);
        $this->assertStringContainsString('data-log-detail="'.$video->id.'"', $card);
        $this->assertStringContainsString('Technical details', $card);
        $this->assertStringContainsString('RuntimeException: &lt;script&gt;alert(1)&lt;/script&gt;', $card);
        $this->assertStringNotContainsString('<script>alert(1)</script>', $card);
    }

    public function test_success_and_error_entries_render_data_log_id(): void
    {
        $failed = $this->seedFailedVideo();
        $ready = Video::create([
            'title' => 'ok-video',
            'original_filename' => 'f.mp4',
            'status' => 'ready',
            'disk_prefix' => 'p/',
        ]);

        $html = $this->get('/logs')->assertOk()->getContent();

        $this->assertStringContainsString('data-log-id="'.$failed->id.'"', $this->errorCard($html));
        preg_match('/data-log-list="success">(.*)$/s', $html, $m);
        $this->assertStringContainsString('data-log-id="'.$ready->id.'"', $m[1] ?? '');
    }

    public function test_error_card_has_no_details_block_without_error_detail(): void
    {
        $this->seedFailedVideo(['error_detail' => null]);

        $response = $this->get('/logs')->assertOk();

        $this->assertStringNotContainsString('<details', $this->errorCard($response->getContent()));
        $response->assertSee('Generic failure text.');
    }
}
