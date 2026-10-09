<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class DashboardOverviewTest extends TestCase
{
    use RefreshDatabase;

    public function test_authenticated_user_can_view_dashboard_overview(): void
    {
        $user = User::factory()->create(['username' => 'tester']);

        $this->actingAs($user)
            ->get(route('dashboard.overview'))
            ->assertOk()
            ->assertSee('Server disk');
    }
}
