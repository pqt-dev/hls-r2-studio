<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Event;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppApiLoginTest extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return $overrides + ['username' => 'admin', 'password' => 'correct-horse', 'device_name' => 'Office PC'];
    }

    public function test_login_returns_token_and_creates_no_session(): void
    {
        $user = $this->makeUser();

        $response = $this->postJson('/api/app/login', $this->payload());

        $this->assertNoStore($response);
        $response->assertOk()
            ->assertJsonStructure(['token', 'user' => ['username']])
            ->assertJsonPath('user.username', 'admin');
        $this->assertGuest('web');

        $token = PersonalAccessToken::findToken($response->json('token'));
        $this->assertNotNull($token);
        $this->assertSame($user->id, $token->tokenable_id);
        $this->assertSame('Office PC', $token->name);
        $this->assertTrue($token->expires_at->between(now()->addDays(89), now()->addDays(91)));
    }

    public function test_wrong_password_and_unknown_user_get_the_same_422(): void
    {
        $this->makeUser();

        $wrongPassword = $this->postJson('/api/app/login', $this->payload(['password' => 'nope-nope']));
        $unknownUser = $this->postJson('/api/app/login', $this->payload(['username' => 'ghost']));

        $wrongPassword->assertStatus(422)->assertJsonPath('errors.username.0', 'Incorrect username or password.');
        $unknownUser->assertStatus(422);
        $this->assertSame($wrongPassword->json(), $unknownUser->json());
        $this->assertSame(0, PersonalAccessToken::count());
    }

    public function test_failed_login_is_logged_with_ip_but_never_with_the_password(): void
    {
        $this->makeUser();
        $logs = [];
        Event::listen(MessageLogged::class, function (MessageLogged $event) use (&$logs) {
            $logs[] = [$event->level, $event->message, $event->context];
        });

        $this->postJson('/api/app/login', $this->payload(['password' => 'secret-attempt-123']))->assertStatus(422);

        $warnings = array_filter($logs, fn ($log) => $log[0] === 'warning' && $log[1] === 'Failed app login attempt');
        $this->assertCount(1, $warnings);
        $this->assertSame('127.0.0.1', array_values($warnings)[0][2]['ip']);
        $this->assertStringNotContainsString('secret-attempt-123', json_encode($logs));
    }

    public function test_successful_login_never_logs_the_token_or_password(): void
    {
        $this->makeUser();
        $logs = [];
        Event::listen(MessageLogged::class, function (MessageLogged $event) use (&$logs) {
            $logs[] = [$event->level, $event->message, $event->context];
        });

        $token = $this->postJson('/api/app/login', $this->payload())->assertOk()->json('token');

        $this->assertStringNotContainsString($token, json_encode($logs));
        $this->assertStringNotContainsString(explode('|', $token)[1], json_encode($logs));
        $this->assertStringNotContainsString('correct-horse', json_encode($logs));
    }

    public function test_login_is_throttled_after_five_attempts_per_ip_and_username(): void
    {
        $this->makeUser();

        for ($i = 0; $i < 5; $i++) {
            $this->postJson('/api/app/login', $this->payload(['password' => 'bad-password']))->assertStatus(422);
        }

        // Even the right password is refused once the limit is hit, and the username case does not matter.
        $this->postJson('/api/app/login', $this->payload())->assertStatus(429);
        $this->postJson('/api/app/login', $this->payload(['username' => 'ADMIN']))->assertStatus(429);
        // A different username has its own budget.
        $this->postJson('/api/app/login', $this->payload(['username' => 'other']))->assertStatus(422);
    }

    public function test_login_validates_the_body(): void
    {
        $this->makeUser();

        $this->postJson('/api/app/login', $this->payload(['device_name' => '']))->assertStatus(422)->assertJsonValidationErrors('device_name');
        $this->postJson('/api/app/login', $this->payload(['device_name' => str_repeat('a', 101)]))->assertStatus(422)->assertJsonValidationErrors('device_name');
        $this->postJson('/api/app/login', ['username' => 'admin', 'password' => 'correct-horse'])->assertStatus(422)->assertJsonValidationErrors('device_name');
        $this->postJson('/api/app/login', ['device_name' => 'x'])->assertStatus(422)->assertJsonValidationErrors(['username', 'password']);
        $this->postJson('/api/app/login', $this->payload(['username' => ['a']]))->assertStatus(422);
        $this->assertSame(0, PersonalAccessToken::count());

        $this->postJson('/api/app/login', $this->payload(['device_name' => str_repeat('a', 100)]))->assertOk();
    }

    public function test_logout_revokes_only_the_current_token(): void
    {
        $this->configureR2();
        $user = $this->makeUser();
        $current = $this->tokenFor($user, 'A');
        $other = $this->tokenFor($user, 'B');

        $this->apiAs($current, 'POST', '/api/app/logout')->assertNoContent();

        $this->assertSame(1, PersonalAccessToken::count());
        $this->assertSame('B', PersonalAccessToken::first()->name);
        $this->apiAs($current, 'GET', '/api/app/config')->assertUnauthorized();
        $this->apiAs($other, 'GET', '/api/app/config')->assertOk();
    }

    public function test_logout_without_token_is_a_json_401(): void
    {
        $this->apiAs(null, 'POST', '/api/app/logout')
            ->assertUnauthorized()
            ->assertJsonPath('message', 'Unauthenticated.');
    }

    public function test_invalid_token_is_a_json_401(): void
    {
        $this->apiAs('1|not-a-real-token', 'GET', '/api/app/config')->assertUnauthorized();
    }

    public function test_expired_token_is_rejected_after_ninety_days(): void
    {
        $this->configureR2();
        $user = $this->makeUser();
        $token = $this->postJson('/api/app/login', $this->payload())->json('token');

        $this->apiAs($token, 'GET', '/api/app/config')->assertOk();

        Carbon::setTestNow(now()->addDays(89));
        $this->apiAs($token, 'GET', '/api/app/config')->assertOk();

        Carbon::setTestNow(now()->addDays(2));
        $this->apiAs($token, 'GET', '/api/app/config')->assertUnauthorized();

        Carbon::setTestNow();
    }

    public function test_a_token_issued_without_expires_at_still_expires_by_config(): void
    {
        $user = $this->makeUser();
        $token = $this->tokenFor($user);

        Carbon::setTestNow(now()->addDays(91));
        $this->apiAs($token, 'GET', '/api/app/config')->assertUnauthorized();
        Carbon::setTestNow();
    }

    public function test_bearer_token_does_not_authenticate_web_admin_routes(): void
    {
        $user = $this->makeUser();
        $token = $this->tokenFor($user);

        foreach (['/', '/videos', '/settings', '/reports', '/logs'] as $uri) {
            $this->app['auth']->forgetGuards();
            $this->withToken($token)->get($uri)->assertNotFound();
        }

        $this->app['auth']->forgetGuards();
        $this->withToken($token)->putJson('/settings/password', [])->assertUnauthorized();
        $this->assertSame(1, PersonalAccessToken::count());
    }

    public function test_web_session_does_not_authenticate_the_app_api(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'web']));

        $this->getJson('/api/app/config')->assertUnauthorized();
    }

    public function test_cors_allowlist_middleware_does_not_break_app_routes(): void
    {
        $this->makeUser();
        Setting::current()->update(['embed_allowed_domains' => 'example.com']);

        $this->postJson('/api/app/login', $this->payload(), ['Origin' => 'https://example.com'])->assertOk();
        $this->postJson('/api/app/login', $this->payload(), ['Origin' => 'https://evil.test'])->assertOk();
    }
}
