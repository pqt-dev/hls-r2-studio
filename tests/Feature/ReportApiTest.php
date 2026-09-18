<?php

namespace Tests\Feature;

use App\Models\Report;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
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
}
