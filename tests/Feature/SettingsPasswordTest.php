<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

class SettingsPasswordTest extends TestCase
{
    use RefreshDatabase;

    private function makeUser(): User
    {
        return User::factory()->create(['username' => 'tester', 'password' => 'old-password']);
    }

    public function test_wrong_current_password_is_rejected(): void
    {
        $user = $this->makeUser();

        $response = $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'not-the-password',
            'password' => 'new-password-1',
            'password_confirmation' => 'new-password-1',
        ]);

        $response->assertSessionHasErrors('current_password');
        $this->assertTrue(Hash::check('old-password', $user->fresh()->password));
    }

    public function test_new_password_must_be_confirmed_and_at_least_8_characters(): void
    {
        $user = $this->makeUser();

        $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'old-password',
            'password' => 'short',
            'password_confirmation' => 'short',
        ])->assertSessionHasErrors('password');

        $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-1',
            'password_confirmation' => 'different',
        ])->assertSessionHasErrors('password');

        $this->assertTrue(Hash::check('old-password', $user->fresh()->password));
    }

    public function test_success_changes_hash_and_keeps_current_session_logged_in(): void
    {
        $user = $this->makeUser();

        $response = $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-1',
            'password_confirmation' => 'new-password-1',
        ]);

        $response->assertSessionHas('success', 'Password changed.');
        $this->assertTrue(Hash::check('new-password-1', $user->fresh()->password));
        $this->assertAuthenticatedAs($user);

        $this->get('/videos')->assertOk();
    }

    public function test_session_established_before_the_change_is_rejected_after_it(): void
    {
        $user = $this->makeUser();
        $oldHash = $user->getAuthPassword();

        $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'old-password',
            'password' => 'new-password-1',
            'password_confirmation' => 'new-password-1',
        ])->assertSessionHas('success');

        // Simulate a second device: a fresh session that still holds the old password hash.
        $this->flushSession();
        $this->app['auth']->forgetGuards();

        $this->withSession(['password_hash_web' => $oldHash])
            ->actingAs($user->fresh())
            ->get('/videos')
            ->assertRedirect(route('login'));

        $this->assertGuest();
    }
}
