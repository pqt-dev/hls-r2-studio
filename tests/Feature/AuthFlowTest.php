<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class AuthFlowTest extends TestCase
{
    use RefreshDatabase;

    private const KEY = 'test-login-key';

    protected function setUp(): void
    {
        parent::setUp();

        config(['auth.admin_login_key' => self::KEY]);
    }

    public function test_login_page_renders_at_the_secret_key_for_guests(): void
    {
        $this->get('/'.self::KEY)->assertOk()->assertSee('/'.self::KEY, false);
    }

    public function test_wrong_key_returns_404(): void
    {
        $this->get('/wrong-key')->assertNotFound();
        $this->post('/wrong-key', ['username' => 'tester', 'password' => 'x'])->assertNotFound();
    }

    public function test_old_login_url_returns_404(): void
    {
        $this->get('/login')->assertNotFound();
        $this->post('/login', ['username' => 'tester', 'password' => 'x'])->assertNotFound();
    }

    public function test_empty_key_disables_every_login_route(): void
    {
        config(['auth.admin_login_key' => '']);

        $this->get('/login')->assertNotFound();
        $this->get('/'.self::KEY)->assertNotFound();
        $this->post('/'.self::KEY, ['username' => 'tester', 'password' => 'x'])->assertNotFound();
        $this->get('/test-login-key')->assertNotFound();
        $this->assertGuest();
    }

    public function test_unauthenticated_requests_get_404_instead_of_a_redirect(): void
    {
        $this->get('/')->assertNotFound();
        $this->get('/settings')->assertNotFound();
    }

    public function test_unauthenticated_json_requests_still_get_401(): void
    {
        $this->getJson('/videos')->assertUnauthorized();
    }

    public function test_valid_credentials_authenticate_and_redirect_to_dashboard(): void
    {
        $user = User::factory()->create(['username' => 'tester', 'password' => 'correct-password']);

        $response = $this->post('/'.self::KEY, ['username' => 'tester', 'password' => 'correct-password']);

        $response->assertRedirect(route('dashboard.overview'));
        $this->assertAuthenticatedAs($user);
    }

    public function test_wrong_password_returns_error_and_stays_guest(): void
    {
        User::factory()->create(['username' => 'tester', 'password' => 'correct-password']);

        $response = $this->from('/'.self::KEY)->post('/'.self::KEY, ['username' => 'tester', 'password' => 'wrong-password']);

        $response->assertRedirect('/'.self::KEY);
        $response->assertSessionHasErrors(['username' => 'Incorrect username or password.']);
        $this->assertGuest();
    }

    public function test_missing_fields_fail_validation(): void
    {
        $this->post('/'.self::KEY, [])->assertSessionHasErrors(['username', 'password']);
        $this->assertGuest();
    }

    public function test_authenticated_user_visiting_login_is_redirected_to_dashboard(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/'.self::KEY)->assertRedirect('/');
    }

    public function test_logout_signs_the_user_out_and_redirects_to_the_secret_login_url(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->post('/logout')->assertRedirect(url('/'.self::KEY));

        $this->assertGuest();
    }

    public function test_login_key_does_not_shadow_other_routes_for_authenticated_users(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        foreach (['/videos', '/upload', '/settings', '/logs', '/reports', '/activity-log'] as $uri) {
            $this->get($uri)->assertOk();
        }
        $this->get('/')->assertOk();
    }

    public function test_login_key_matching_an_existing_route_name_does_not_shadow_it(): void
    {
        config(['auth.admin_login_key' => 'videos']);
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/videos')->assertOk()->assertSee('Videos');
    }
}
