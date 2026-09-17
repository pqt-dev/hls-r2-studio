<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SettingsR2ValidationTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    public function test_r2_secret_is_not_flashed_to_session_when_validation_fails(): void
    {
        $response = $this->from('/settings')->put('/settings/r2', [
            'r2_access_key_id' => 'some-key',
            'r2_secret_access_key' => 'super-secret-value',
            'r2_bucket' => 'my-bucket',
            'r2_endpoint' => 'not-a-valid-url',
            'r2_url' => 'not-a-valid-url',
        ]);

        $response->assertSessionHasErrors(['r2_endpoint', 'r2_url']);
        $this->assertNull(session('_old_input.r2_secret_access_key'));
        $this->assertSame('some-key', session('_old_input.r2_access_key_id'));
    }
}
