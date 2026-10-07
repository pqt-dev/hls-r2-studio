<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthFlowTest extends TestCase
{
    use RefreshDatabase;

    public function test_login_page_renders_for_guests(): void
    {
        $this->get('/login')->assertOk();
    }

    public function test_valid_credentials_authenticate_and_redirect_to_dashboard(): void
    {
        $user = User::factory()->create(['username' => 'tester', 'password' => 'correct-password']);

        $response = $this->post('/login', ['username' => 'tester', 'password' => 'correct-password']);

        $response->assertRedirect(route('dashboard.overview'));
        $this->assertAuthenticatedAs($user);
    }

    public function test_wrong_password_returns_error_and_stays_guest(): void
    {
        User::factory()->create(['username' => 'tester', 'password' => 'correct-password']);

        $response = $this->from('/login')->post('/login', ['username' => 'tester', 'password' => 'wrong-password']);

        $response->assertRedirect('/login');
        $response->assertSessionHasErrors(['username' => 'Incorrect username or password.']);
        $this->assertGuest();
    }

    public function test_missing_fields_fail_validation(): void
    {
        $this->post('/login', [])->assertSessionHasErrors(['username', 'password']);
        $this->assertGuest();
    }

    public function test_authenticated_user_visiting_login_is_redirected_away(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/login')->assertRedirect();
    }

    public function test_logout_signs_the_user_out_and_redirects_to_login(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->post('/logout')->assertRedirect(route('login'));

        $this->assertGuest();
    }
}
