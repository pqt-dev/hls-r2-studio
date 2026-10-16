<?php

namespace Tests\Feature;

use App\Models\Report;
use App\Models\ReportSubmission;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class ReportApiTest extends TestCase
{
    use RefreshDatabase;

    public function test_valid_report_is_created(): void
    {
        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'note' => 'Video does not play at all.',
        ]);

        $response->assertStatus(201);
        $response->assertJson(['success' => true]);

        $this->assertDatabaseHas('reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'status' => 'new',
        ]);
    }

    public function test_missing_page_url_returns_422(): void
    {
        $response = $this->postJson('/api/reports', []);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('page_url');
    }

    public function test_valid_reason_is_persisted(): void
    {
        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'lag',
        ]);

        $response->assertStatus(201);

        $this->assertDatabaseHas('reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'lag',
        ]);
    }

    public function test_invalid_reason_returns_422(): void
    {
        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'bogus_value',
        ]);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('reason');
    }

    /**
     * @dataProvider validReasonProvider
     */
    #[\PHPUnit\Framework\Attributes\DataProvider('validReasonProvider')]
    public function test_each_current_reason_key_is_accepted(string $reason): void
    {
        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => $reason,
        ])->assertStatus(201);

        $this->assertDatabaseHas('reports', ['page_url' => 'https://toicovl.com/some-post', 'reason' => $reason]);
        $this->assertDatabaseHas('report_submissions', ['reason' => $reason]);
    }

    public static function validReasonProvider(): array
    {
        return [
            'not_loading' => ['not_loading'],
            'not_playing' => ['not_playing'],
            'lag' => ['lag'],
            'wrong_video' => ['wrong_video'],
            'other' => ['other'],
        ];
    }

    public function test_removed_no_audio_reason_returns_422(): void
    {
        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'no_audio',
        ]);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('reason');
        $this->assertDatabaseCount('reports', 0);
    }

    public function test_missing_reason_still_succeeds(): void
    {
        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ]);

        $response->assertStatus(201);

        $this->assertDatabaseHas('reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => null,
        ]);
    }

    public function test_each_request_creates_its_own_submission_row(): void
    {
        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'lag',
            'isp' => 'Viettel',
        ])->assertStatus(201);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'not_playing',
            'isp' => 'VNPT',
        ])->assertStatus(201);

        $report = Report::first();

        $this->assertDatabaseCount('reports', 1);
        $this->assertDatabaseCount('report_submissions', 2);
        $this->assertDatabaseHas('report_submissions', ['report_id' => $report->id, 'isp' => 'Viettel', 'reason' => 'lag']);
        $this->assertDatabaseHas('report_submissions', ['report_id' => $report->id, 'isp' => 'VNPT', 'reason' => 'not_playing']);
    }

    public function test_submission_stores_the_request_ip(): void
    {
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.7'])
            ->postJson('/api/reports', ['page_url' => 'https://toicovl.com/some-post'])
            ->assertStatus(201);

        $this->assertDatabaseHas('report_submissions', ['ip' => '203.0.113.7']);
    }

    public function test_client_sent_ip_is_ignored(): void
    {
        $this->withServerVariables(['REMOTE_ADDR' => '203.0.113.7'])
            ->postJson('/api/reports', [
                'page_url' => 'https://toicovl.com/some-post',
                'ip' => '198.51.100.99',
            ])
            ->assertStatus(201);

        $this->assertDatabaseHas('report_submissions', ['ip' => '203.0.113.7']);
        $this->assertDatabaseMissing('report_submissions', ['ip' => '198.51.100.99']);
    }

    public function test_missing_or_blank_isp_is_stored_as_unknown(): void
    {
        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'isp' => '   ',
        ])->assertStatus(201);

        $this->assertDatabaseCount('report_submissions', 2);
        $this->assertSame(2, ReportSubmission::where('isp', 'Unknown')->count());
    }

    public function test_isp_longer_than_100_characters_returns_422(): void
    {
        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'isp' => str_repeat('a', 101),
        ]);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('isp');
        $this->assertDatabaseCount('reports', 0);
        $this->assertDatabaseCount('report_submissions', 0);
    }

    public function test_sixth_report_within_ten_minutes_is_throttled(): void
    {
        for ($i = 0; $i < 5; $i++) {
            $response = $this->postJson('/api/reports', [
                'page_url' => 'https://toicovl.com/some-post',
            ]);

            $response->assertStatus(201);
        }

        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ]);

        $response->assertStatus(429);
    }

    public function test_duplicate_reports_for_same_new_page_url_are_merged(): void
    {
        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        $this->assertDatabaseCount('reports', 1);
        $this->assertDatabaseHas('reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'status' => 'new',
            'report_count' => 2,
        ]);
    }

    public function test_last_reported_at_is_set_on_create_and_updated_on_merge(): void
    {
        $firstMoment = Carbon::parse('2026-09-18 10:00:00');
        Carbon::setTestNow($firstMoment);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        $report = Report::first();
        $this->assertNotNull($report->last_reported_at);
        $this->assertTrue($report->last_reported_at->equalTo($firstMoment));
        $this->assertTrue($report->last_reported_at->equalTo($report->created_at));

        $secondMoment = $firstMoment->copy()->addMinutes(5);
        Carbon::setTestNow($secondMoment);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        $report->refresh();
        $this->assertEquals(2, $report->report_count);
        $this->assertTrue($report->last_reported_at->equalTo($secondMoment));
        $this->assertFalse($report->last_reported_at->equalTo($firstMoment));

        Carbon::setTestNow();
    }

    public function test_duplicate_report_overwrites_reason_with_latest_value(): void
    {
        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'not_playing',
        ])->assertStatus(201);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'lag',
        ])->assertStatus(201);

        $this->assertDatabaseCount('reports', 1);
        $this->assertDatabaseHas('reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'report_count' => 2,
            'reason' => 'lag',
        ]);
    }

    public function test_report_for_resolved_page_url_creates_new_record(): void
    {
        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        Report::first()->update(['status' => 'resolved']);

        $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ])->assertStatus(201);

        $this->assertDatabaseCount('reports', 2);
        $this->assertDatabaseHas('reports', [
            'page_url' => 'https://toicovl.com/some-post',
            'status' => 'new',
            'report_count' => 1,
        ]);
    }

    public function test_page_url_host_outside_allowed_hosts_returns_422(): void
    {
        config(['videos.report_allowed_hosts' => ['toicovl.com']]);

        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://evil.example.com/some-post',
        ]);

        $response->assertStatus(422);
        $response->assertJsonValidationErrors('page_url');
        $this->assertDatabaseCount('reports', 0);
    }

    public function test_page_url_host_inside_allowed_hosts_is_accepted(): void
    {
        if (! in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true)) {
            $this->markTestSkipped('The reports migration uses MySQL-only SHA2(); requires a mysql/mariadb connection.');
        }

        config(['videos.report_allowed_hosts' => ['toicovl.com']]);

        $response = $this->postJson('/api/reports', [
            'page_url' => 'https://toicovl.com/some-post',
        ]);

        $response->assertStatus(201);
    }
}
