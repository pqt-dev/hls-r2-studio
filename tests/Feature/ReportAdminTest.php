<?php

namespace Tests\Feature;

use App\Models\Report;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class ReportAdminTest extends TestCase
{
    use RefreshDatabase;

    public function test_guest_is_redirected_to_login_for_reports_index(): void
    {
        $response = $this->get('/reports');

        $response->assertRedirect(route('login'));
    }

    public function test_authenticated_user_can_view_reports_index(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $response = $this->get('/reports');

        $response->assertOk();
    }

    public function test_resolve_updates_report_status(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $report = Report::create([
            'page_url' => 'https://toicovl.com/some-post',
            'reason' => 'playback_error',
            'status' => 'new',
        ]);

        $response = $this->put("/reports/{$report->id}/resolve");

        $response->assertRedirect();
        $this->assertDatabaseHas('reports', [
            'id' => $report->id,
            'status' => 'resolved',
        ]);
        $this->assertNotNull($report->fresh()->resolved_at);
    }

    public function test_index_sorts_by_priority_by_default(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedHighCount = Report::create([
            'page_url' => 'https://toicovl.com/resolved-high',
            'reason' => 'playback_error',
            'status' => 'resolved',
            'report_count' => 10,
        ]);
        $resolvedHighCount->forceFill(['created_at' => now()->subDays(1)])->save();
        $newLowCount = Report::create([
            'page_url' => 'https://toicovl.com/new-low',
            'reason' => 'playback_error',
            'status' => 'new',
            'report_count' => 1,
        ]);
        $newLowCount->forceFill(['created_at' => now()->subDays(2)])->save();
        $newHighCount = Report::create([
            'page_url' => 'https://toicovl.com/new-high',
            'reason' => 'playback_error',
            'status' => 'new',
            'report_count' => 5,
        ]);
        $newHighCount->forceFill(['created_at' => now()->subDays(3)])->save();

        $response = $this->get('/reports');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([
            $newHighCount->id,
            $newLowCount->id,
            $resolvedHighCount->id,
        ], $ids);
    }

    public function test_index_sorts_by_newest(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $older = Report::create([
            'page_url' => 'https://toicovl.com/older',
            'reason' => 'playback_error',
            'status' => 'new',
        ]);
        $older->forceFill(['created_at' => now()->subDays(2)])->save();
        $newer = Report::create([
            'page_url' => 'https://toicovl.com/newer',
            'reason' => 'playback_error',
            'status' => 'new',
        ]);
        $newer->forceFill(['created_at' => now()->subDays(1)])->save();

        $response = $this->get('/reports?sort=newest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$newer->id, $older->id], $ids);
    }

    public function test_index_sorts_by_oldest(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $older = Report::create([
            'page_url' => 'https://toicovl.com/older2',
            'reason' => 'playback_error',
            'status' => 'new',
        ]);
        $older->forceFill(['created_at' => now()->subDays(2)])->save();
        $newer = Report::create([
            'page_url' => 'https://toicovl.com/newer2',
            'reason' => 'playback_error',
            'status' => 'new',
        ]);
        $newer->forceFill(['created_at' => now()->subDays(1)])->save();

        $response = $this->get('/reports?sort=oldest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$older->id, $newer->id], $ids);
    }

    public function test_index_sorts_by_most_reported(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $lowCount = Report::create([
            'page_url' => 'https://toicovl.com/low-count',
            'reason' => 'playback_error',
            'status' => 'new',
            'report_count' => 1,
        ]);
        $highCount = Report::create([
            'page_url' => 'https://toicovl.com/high-count',
            'reason' => 'playback_error',
            'status' => 'resolved',
            'report_count' => 8,
        ]);

        $response = $this->get('/reports?sort=most_reported');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$highCount->id, $lowCount->id], $ids);
    }
}
