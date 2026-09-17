<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class CreateAdminUserCommandTest extends TestCase
{
    use RefreshDatabase;

    public function test_rerunning_without_email_option_keeps_existing_email(): void
    {
        $this->artisan('admin:create', [
            'username' => 'admin',
            'password' => 'first-password',
            '--email' => 'admin@example.com',
        ])->assertSuccessful();

        $this->artisan('admin:create', [
            'username' => 'admin',
            'password' => 'second-password',
        ])->assertSuccessful();

        $user = User::where('username', 'admin')->firstOrFail();

        $this->assertSame('admin@example.com', $user->email);
    }

    public function test_password_shorter_than_minimum_fails_without_creating_user(): void
    {
        $this->artisan('admin:create', [
            'username' => 'shortpass',
            'password' => 'short',
            '--email' => 'shortpass@example.com',
        ])->assertFailed();

        $this->assertDatabaseMissing('users', ['username' => 'shortpass']);
    }
}
