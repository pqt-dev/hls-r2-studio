<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Laravel\Sanctum\PersonalAccessToken;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppTokenSettingsTest extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    public function test_card_lists_only_the_current_users_tokens(): void
    {
        $user = $this->makeUser();
        $other = $this->makeUser('someone-else');
        $user->createToken('Office PC');
        $other->createToken('Foreign Laptop');

        $response = $this->actingAs($user)->get('/settings');

        $response->assertOk()
            ->assertSee('Desktop app access')
            ->assertSee('Office PC')
            ->assertDontSee('Foreign Laptop')
            ->assertSee('Revoke all');
    }

    public function test_card_shows_an_empty_state_without_tokens(): void
    {
        $this->actingAs($this->makeUser())->get('/settings')
            ->assertOk()
            ->assertSee('No desktop app is signed in.')
            ->assertDontSee('Revoke all');
    }

    public function test_card_never_renders_token_secrets(): void
    {
        $user = $this->makeUser();
        $plain = $user->createToken('Office PC')->plainTextToken;
        $hash = PersonalAccessToken::first()->token;

        $content = $this->actingAs($user)->get('/settings')->getContent();

        $this->assertStringNotContainsString(explode('|', $plain)[1], $content);
        $this->assertStringNotContainsString($hash, $content);
    }

    public function test_revoke_deletes_own_token(): void
    {
        $user = $this->makeUser();
        $keep = $user->createToken('Keep')->accessToken;
        $drop = $user->createToken('Drop')->accessToken;

        $this->actingAs($user)->delete('/settings/app-tokens/'.$drop->id)
            ->assertRedirect()
            ->assertSessionHas('success', 'Token revoked.');

        $this->assertModelMissing($drop);
        $this->assertModelExists($keep);
    }

    public function test_cannot_revoke_another_users_token(): void
    {
        $user = $this->makeUser();
        $victim = $this->makeUser('victim');
        $foreign = $victim->createToken('Victim PC')->accessToken;

        $this->actingAs($user)->delete('/settings/app-tokens/'.$foreign->id)->assertNotFound();

        $this->assertModelExists($foreign);
    }

    public function test_revoking_an_unknown_token_is_404(): void
    {
        $this->actingAs($this->makeUser())->delete('/settings/app-tokens/9999')->assertNotFound();
    }

    public function test_revoke_all_deletes_only_own_tokens(): void
    {
        $user = $this->makeUser();
        $other = $this->makeUser('other');
        $user->createToken('A');
        $user->createToken('B');
        $theirs = $other->createToken('C')->accessToken;

        $this->actingAs($user)->delete('/settings/app-tokens')
            ->assertRedirect()
            ->assertSessionHas('success', 'All desktop app tokens revoked.');

        $this->assertSame(0, $user->tokens()->count());
        $this->assertModelExists($theirs);
    }

    public function test_guests_cannot_manage_tokens(): void
    {
        $user = $this->makeUser();
        $token = $user->createToken('A')->accessToken;

        $this->delete('/settings/app-tokens/'.$token->id)->assertNotFound();
        $this->delete('/settings/app-tokens')->assertNotFound();

        $this->assertModelExists($token);
    }

    public function test_revoked_token_stops_working(): void
    {
        $this->configureR2();
        $user = $this->makeUser();
        $plain = $this->tokenFor($user);
        $this->apiAs($plain, 'GET', '/api/app/config')->assertOk();

        $this->actingAs($user)->delete('/settings/app-tokens')->assertRedirect();

        $this->apiAs($plain, 'GET', '/api/app/config')->assertUnauthorized();
    }

    public function test_password_change_revokes_all_tokens_of_the_user(): void
    {
        $user = $this->makeUser();
        $other = $this->makeUser('other');
        $plain = $this->tokenFor($user);
        $this->tokenFor($user, 'Second');
        $theirs = $other->createToken('Other')->accessToken;

        $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'correct-horse',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
        ])->assertSessionHas('success', 'Password changed.');

        $this->assertSame(0, $user->tokens()->count());
        $this->assertModelExists($theirs);
        $this->apiAs($plain, 'GET', '/api/app/config')->assertUnauthorized();
    }

    public function test_failed_password_change_keeps_tokens(): void
    {
        $user = $this->makeUser();
        $this->tokenFor($user);

        $this->actingAs($user)->put('/settings/password', [
            'current_password' => 'wrong',
            'password' => 'new-password-123',
            'password_confirmation' => 'new-password-123',
        ])->assertSessionHasErrors('current_password');

        $this->assertSame(1, $user->tokens()->count());
    }
}
