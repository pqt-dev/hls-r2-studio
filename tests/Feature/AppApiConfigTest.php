<?php

namespace Tests\Feature;

use App\Models\Setting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppApiConfigTest extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    private function emptyEnvR2(): void
    {
        config(['filesystems.disks.r2' => ['key' => null, 'secret' => null, 'bucket' => null, 'endpoint' => null, 'url' => null]]);
    }

    public function test_config_requires_a_token(): void
    {
        $this->apiAs(null, 'GET', '/api/app/config')->assertUnauthorized()->assertJsonPath('message', 'Unauthenticated.');
    }

    public function test_config_returns_r2_and_transcode_options(): void
    {
        $this->configureR2();
        Setting::current()->update(['transcode_resolution' => '1080', 'transcode_segment_seconds' => 4, 'transcode_fps' => 30]);
        $token = $this->tokenFor($this->makeUser());

        $response = $this->apiAs($token, 'GET', '/api/app/config');

        $this->assertNoStore($response);
        $response->assertOk()
            ->assertExactJson([
                'r2' => [
                    'access_key_id' => 'AKIDEXAMPLE1234',
                    'secret_access_key' => 'super-secret-value',
                    'bucket' => 'my-bucket',
                    'endpoint' => 'https://acc.r2.cloudflarestorage.com',
                    'url' => 'https://cdn.example.com',
                ],
                'transcode' => ['resolution' => '1080', 'segment_seconds' => 4, 'fps' => 30],
            ]);
    }

    public function test_default_transcode_values_and_null_fps(): void
    {
        $this->configureR2();
        $token = $this->tokenFor($this->makeUser());

        $this->apiAs($token, 'GET', '/api/app/config')
            ->assertOk()
            ->assertJsonPath('transcode', ['resolution' => '720', 'segment_seconds' => 6, 'fps' => null]);
    }

    public function test_incomplete_r2_config_returns_409(): void
    {
        $this->emptyEnvR2();
        Setting::current()->update(['r2_bucket' => 'my-bucket']);
        $token = $this->tokenFor($this->makeUser());

        $response = $this->apiAs($token, 'GET', '/api/app/config');

        $this->assertNoStore($response);
        $response->assertStatus(409)->assertExactJson(['error' => 'r2_not_configured']);
    }

    public function test_falls_back_to_env_config_when_the_db_is_empty(): void
    {
        config(['filesystems.disks.r2' => [
            'key' => 'ENVKEY', 'secret' => 'env-secret', 'bucket' => 'env-bucket',
            'endpoint' => 'https://env.r2.cloudflarestorage.com', 'url' => 'https://env-cdn.example.com',
        ]]);
        $token = $this->tokenFor($this->makeUser());

        $this->apiAs($token, 'GET', '/api/app/config')
            ->assertOk()
            ->assertJsonPath('r2.access_key_id', 'ENVKEY')
            ->assertJsonPath('r2.bucket', 'env-bucket');
    }

    public function test_db_config_wins_over_env(): void
    {
        config(['filesystems.disks.r2' => [
            'key' => 'ENVKEY', 'secret' => 'env-secret', 'bucket' => 'env-bucket',
            'endpoint' => 'https://env.r2.cloudflarestorage.com', 'url' => 'https://env-cdn.example.com',
        ]]);
        $this->configureR2();
        $token = $this->tokenFor($this->makeUser());

        $this->apiAs($token, 'GET', '/api/app/config')
            ->assertOk()
            ->assertJsonPath('r2.access_key_id', 'AKIDEXAMPLE1234')
            ->assertJsonPath('r2.bucket', 'my-bucket');
    }
}
