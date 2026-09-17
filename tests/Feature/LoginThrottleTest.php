<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class LoginThrottleTest extends TestCase
{
    use RefreshDatabase;

    public function test_sixth_failed_login_attempt_within_a_minute_is_throttled(): void
    {
        User::factory()->create(['username' => 'tester', 'password' => 'correct-password']);

        for ($i = 0; $i < 5; $i++) {
            $response = $this->post('/login', [
                'username' => 'tester',
                'password' => 'wrong-password',
            ]);

            $response->assertSessionHasErrors('username');
        }

        $response = $this->post('/login', [
            'username' => 'tester',
            'password' => 'wrong-password',
        ]);

        $response->assertStatus(429);
    }
}
