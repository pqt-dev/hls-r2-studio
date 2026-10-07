<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class PagesRenderTest extends TestCase
{
    use RefreshDatabase;

    public function test_guest_is_redirected_from_pages_not_covered_elsewhere(): void
    {
        $this->get('/upload')->assertRedirect(route('login'));
        $this->get('/logs')->assertRedirect(route('login'));
        $this->get('/settings')->assertRedirect(route('login'));
    }

    public function test_authenticated_user_can_render_upload_logs_and_settings_pages(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/upload')->assertOk();
        $this->get('/logs')->assertOk();
        $this->get('/settings')->assertOk();
    }

    public function test_upload_logs_page_is_realtime_without_a_refresh_button(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $response = $this->get('/logs');
        $response->assertOk()
            ->assertSee('id="logs-content"', false)
            ->assertSee('.video.status-updated', false)
            ->assertDontSee('window.location.reload', false)
            ->assertSee('data-log-list="error"', false)
            ->assertSee('data-log-list="success"', false);
        $this->assertDoesNotMatchRegularExpression('/>\s*Refresh\s*</', $response->getContent());
    }
}
