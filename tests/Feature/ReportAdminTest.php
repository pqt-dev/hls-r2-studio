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
            'reason' => 'other',
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

    public function test_resolve_returns_json_when_ajax_request(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $report = Report::create([
            'page_url' => 'https://toicovl.com/some-post-ajax',
            'reason' => 'other',
            'status' => 'new',
        ]);

        $response = $this->putJson("/reports/{$report->id}/resolve");

        $response->assertOk();
        $response->assertJson(['success' => true]);
        $response->assertJsonStructure(['success', 'resolved_at']);
        $this->assertDatabaseHas('reports', [
            'id' => $report->id,
            'status' => 'resolved',
        ]);
    }

    public function test_resolve_redirects_when_not_ajax_request(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $report = Report::create([
            'page_url' => 'https://toicovl.com/some-post-form',
            'reason' => 'other',
            'status' => 'new',
        ]);

        $response = $this->put("/reports/{$report->id}/resolve");

        $response->assertRedirect();
        $response->assertSessionHas('success');
    }

    public function test_index_sorts_by_newest_by_default(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $older = Report::create([
            'page_url' => 'https://toicovl.com/default-older',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $older->forceFill(['created_at' => now()->subDays(2)])->save();
        $newer = Report::create([
            'page_url' => 'https://toicovl.com/default-newer',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $newer->forceFill(['created_at' => now()->subDays(1)])->save();

        $response = $this->get('/reports');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$newer->id, $older->id], $ids);
    }

    public function test_index_sorts_by_newest(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $older = Report::create([
            'page_url' => 'https://toicovl.com/older',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $older->forceFill(['created_at' => now()->subDays(2)])->save();
        $newer = Report::create([
            'page_url' => 'https://toicovl.com/newer',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $newer->forceFill(['created_at' => now()->subDays(1)])->save();

        $response = $this->get('/reports?sort=newest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$newer->id, $older->id], $ids);
    }

    public function test_index_sorts_by_newest_keeps_resolved_last(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedNewest = Report::create([
            'page_url' => 'https://toicovl.com/newest-sort-resolved',
            'reason' => 'other',
            'status' => 'resolved',
        ]);
        $resolvedNewest->forceFill(['created_at' => now()])->save();
        $newOlder = Report::create([
            'page_url' => 'https://toicovl.com/newest-sort-new',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $newOlder->forceFill(['created_at' => now()->subDays(5)])->save();

        $response = $this->get('/reports?sort=newest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$newOlder->id, $resolvedNewest->id], $ids);
    }

    public function test_index_sorts_by_oldest(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $older = Report::create([
            'page_url' => 'https://toicovl.com/older2',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $older->forceFill(['created_at' => now()->subDays(2)])->save();
        $newer = Report::create([
            'page_url' => 'https://toicovl.com/newer2',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $newer->forceFill(['created_at' => now()->subDays(1)])->save();

        $response = $this->get('/reports?sort=oldest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$older->id, $newer->id], $ids);
    }

    public function test_index_sorts_by_oldest_keeps_resolved_last(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedOldest = Report::create([
            'page_url' => 'https://toicovl.com/oldest-sort-resolved',
            'reason' => 'other',
            'status' => 'resolved',
        ]);
        $resolvedOldest->forceFill(['created_at' => now()->subDays(10)])->save();
        $newNewer = Report::create([
            'page_url' => 'https://toicovl.com/oldest-sort-new',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $newNewer->forceFill(['created_at' => now()])->save();

        $response = $this->get('/reports?sort=oldest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$newNewer->id, $resolvedOldest->id], $ids);
    }

    public function test_index_sorts_by_most_reported(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $lowCount = Report::create([
            'page_url' => 'https://toicovl.com/low-count',
            'reason' => 'other',
            'status' => 'new',
            'report_count' => 1,
        ]);
        $highCount = Report::create([
            'page_url' => 'https://toicovl.com/high-count',
            'reason' => 'other',
            'status' => 'new',
            'report_count' => 8,
        ]);

        $response = $this->get('/reports?sort=most_reported');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$highCount->id, $lowCount->id], $ids);
    }

    public function test_index_sorts_by_most_reported_keeps_resolved_last(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedHighCount = Report::create([
            'page_url' => 'https://toicovl.com/most-reported-resolved',
            'reason' => 'other',
            'status' => 'resolved',
            'report_count' => 20,
        ]);
        $newLowCount = Report::create([
            'page_url' => 'https://toicovl.com/most-reported-new',
            'reason' => 'other',
            'status' => 'new',
            'report_count' => 1,
        ]);

        $response = $this->get('/reports?sort=most_reported');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$newLowCount->id, $resolvedHighCount->id], $ids);
    }

    public function test_index_orders_resolved_group_by_report_count_for_most_reported_sort(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedLongAgoHighCount = Report::create([
            'page_url' => 'https://toicovl.com/resolved-long-ago-high-count',
            'reason' => 'other',
            'status' => 'resolved',
            'report_count' => 20,
        ]);
        $resolvedLongAgoHighCount->forceFill([
            'created_at' => now()->subDays(10),
            'resolved_at' => now()->subDays(9),
        ])->save();

        $resolvedRecentlyLowCount = Report::create([
            'page_url' => 'https://toicovl.com/resolved-recently-low-count',
            'reason' => 'other',
            'status' => 'resolved',
            'report_count' => 1,
        ]);
        $resolvedRecentlyLowCount->forceFill([
            'created_at' => now()->subDays(20),
            'resolved_at' => now()->subDay(),
        ])->save();

        $response = $this->get('/reports?sort=most_reported');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$resolvedLongAgoHighCount->id, $resolvedRecentlyLowCount->id], $ids);
    }

    public function test_index_orders_resolved_group_by_resolved_at_desc_for_newest_sort(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedLongAgoButCreatedRecently = Report::create([
            'page_url' => 'https://toicovl.com/resolved-created-recently',
            'reason' => 'other',
            'status' => 'resolved',
        ]);
        $resolvedLongAgoButCreatedRecently->forceFill([
            'created_at' => now()->subDay(),
            'resolved_at' => now()->subDays(9),
        ])->save();

        $resolvedRecentlyButCreatedLongAgo = Report::create([
            'page_url' => 'https://toicovl.com/resolved-created-long-ago',
            'reason' => 'other',
            'status' => 'resolved',
        ]);
        $resolvedRecentlyButCreatedLongAgo->forceFill([
            'created_at' => now()->subDays(20),
            'resolved_at' => now()->subDay(),
        ])->save();

        $response = $this->get('/reports?sort=newest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$resolvedRecentlyButCreatedLongAgo->id, $resolvedLongAgoButCreatedRecently->id], $ids);
    }

    public function test_index_sorts_by_newest_uses_last_reported_at_for_duplicate_submissions(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $reportA = Report::create([
            'page_url' => 'https://toicovl.com/duplicate-bumped-newest',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $reportA->forceFill(['created_at' => now()->subDays(5)])->save();
        $reportB = Report::create([
            'page_url' => 'https://toicovl.com/not-bumped-newest',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $reportB->forceFill(['created_at' => now()->subDays(1)])->save();

        // Simulate a duplicate submission bumping report A's last_reported_at
        // while leaving its created_at untouched.
        $reportA->forceFill(['last_reported_at' => now()])->save();

        $response = $this->get('/reports?sort=newest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$reportA->id, $reportB->id], $ids);
    }

    public function test_index_sorts_by_oldest_uses_last_reported_at_for_duplicate_submissions(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $reportC = Report::create([
            'page_url' => 'https://toicovl.com/duplicate-bumped-oldest',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $reportC->forceFill(['created_at' => now()->subDays(5)])->save();
        $reportD = Report::create([
            'page_url' => 'https://toicovl.com/not-bumped-oldest',
            'reason' => 'other',
            'status' => 'new',
        ]);
        $reportD->forceFill(['created_at' => now()->subDays(1)])->save();

        // Simulate a duplicate submission bumping report C's last_reported_at
        // while leaving its created_at untouched, so it no longer looks oldest.
        $reportC->forceFill(['last_reported_at' => now()])->save();

        $response = $this->get('/reports?sort=oldest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$reportD->id, $reportC->id], $ids);
    }

    public function test_index_orders_resolved_group_by_resolved_at_asc_for_oldest_sort(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $resolvedRecentlyButCreatedLongAgo = Report::create([
            'page_url' => 'https://toicovl.com/oldest-sort-resolved-recently',
            'reason' => 'other',
            'status' => 'resolved',
        ]);
        $resolvedRecentlyButCreatedLongAgo->forceFill([
            'created_at' => now()->subDays(20),
            'resolved_at' => now()->subDay(),
        ])->save();

        $resolvedLongAgoButCreatedRecently = Report::create([
            'page_url' => 'https://toicovl.com/oldest-sort-resolved-long-ago',
            'reason' => 'other',
            'status' => 'resolved',
        ]);
        $resolvedLongAgoButCreatedRecently->forceFill([
            'created_at' => now()->subDay(),
            'resolved_at' => now()->subDays(9),
        ])->save();

        $response = $this->get('/reports?sort=oldest');

        $response->assertOk();
        $ids = $response->viewData('reports')->pluck('id')->all();
        $this->assertSame([$resolvedLongAgoButCreatedRecently->id, $resolvedRecentlyButCreatedLongAgo->id], $ids);
    }

    public function test_index_paginates_by_per_page_query_and_falls_back_to_10_when_invalid(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        for ($i = 1; $i <= 25; $i++) {
            Report::create([
                'page_url' => "https://toicovl.com/per-page-{$i}",
                'reason' => 'other',
                'status' => 'new',
            ]);
        }

        $this->assertCount(10, $this->get('/reports')->viewData('reports')->items());
        $this->assertCount(20, $this->get('/reports?per_page=20')->viewData('reports')->items());
        $this->assertCount(10, $this->get('/reports?per_page=7')->viewData('reports')->items());
    }

    public function test_index_filter_and_sort_links_keep_per_page(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        Report::create([
            'page_url' => 'https://toicovl.com/keep-per-page',
            'reason' => 'other',
            'status' => 'new',
        ]);

        $response = $this->get('/reports?per_page=20');

        $response->assertSee('status=new&amp;sort=newest&amp;per_page=20', false);
        $response->assertSee('sort=oldest&amp;per_page=20', false);
    }
}
