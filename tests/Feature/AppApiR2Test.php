<?php

namespace Tests\Feature;

use App\Models\Setting;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Storage;
use Tests\Concerns\InteractsWithAppApi;
use Tests\TestCase;

class AppApiR2Test extends TestCase
{
    use InteractsWithAppApi;
    use RefreshDatabase;

    private function payload(array $overrides = []): array
    {
        return $overrides + [
            'endpoint' => 'https://acc.r2.cloudflarestorage.com',
            'bucket' => 'my-bucket',
            'url' => 'https://cdn.example.com/',
            'access_key_id' => 'AKIDEXAMPLE1234',
            'secret_access_key' => 'super-secret-value',
        ];
    }

    private function token(): string
    {
        return $this->tokenFor($this->makeUser());
    }

    public function test_requires_a_token(): void
    {
        $this->apiAs(null, 'GET', '/api/app/r2')->assertUnauthorized();
        $this->apiAs(null, 'PUT', '/api/app/r2', $this->payload())->assertUnauthorized();
        $this->apiAs(null, 'POST', '/api/app/r2/test')->assertUnauthorized();
        $this->assertNull(Setting::current()->r2_bucket);
    }

    public function test_get_when_nothing_configured(): void
    {

        $response = $this->apiAs($this->token(), 'GET', '/api/app/r2');

        $this->assertNoStore($response);
        $response->assertOk()->assertExactJson([
            'configured' => false, 'source' => 'none', 'endpoint' => null, 'bucket' => null,
            'url' => null, 'access_key_last4' => null, 'has_secret' => false,
        ]);
    }

    public function test_get_from_database_never_exposes_secrets(): void
    {
        $this->configureR2();

        $response = $this->apiAs($this->token(), 'GET', '/api/app/r2');

        $response->assertOk()->assertExactJson([
            'configured' => true, 'source' => 'database',
            'endpoint' => 'https://acc.r2.cloudflarestorage.com', 'bucket' => 'my-bucket',
            'url' => 'https://cdn.example.com', 'access_key_last4' => '1234', 'has_secret' => true,
        ]);
        $this->assertStringNotContainsString('super-secret-value', $response->getContent());
        $this->assertStringNotContainsString('AKIDEXAMPLE1234', $response->getContent());
    }

    public function test_get_reports_none_source_when_database_is_incomplete(): void
    {
        Setting::current()->update(['r2_bucket' => 'my-bucket']);

        $response = $this->apiAs($this->token(), 'GET', '/api/app/r2');

        $response->assertOk()->assertJsonPath('source', 'none')->assertJsonPath('configured', false)
            ->assertJsonPath('bucket', 'my-bucket')->assertJsonPath('has_secret', false);
    }

    public function test_put_saves_encrypted_and_normalizes(): void
    {
        $token = $this->token();

        $response = $this->apiAs($token, 'PUT', '/api/app/r2', $this->payload(['bucket' => '  my-bucket  ']));

        $this->assertNoStore($response);
        $response->assertOk()->assertExactJson([
            'configured' => true, 'source' => 'database',
            'endpoint' => 'https://acc.r2.cloudflarestorage.com', 'bucket' => 'my-bucket',
            'url' => 'https://cdn.example.com', 'access_key_last4' => '1234', 'has_secret' => true,
        ]);
        $this->assertStringNotContainsString('super-secret-value', $response->getContent());

        $raw = DB::table('settings')->first();
        $this->assertNotSame('super-secret-value', $raw->r2_secret_access_key);
        $this->assertNotSame('AKIDEXAMPLE1234', $raw->r2_access_key_id);
        $this->assertSame('super-secret-value', Setting::current()->r2_secret_access_key);
    }

    public function test_blank_or_omitted_credentials_keep_stored_values(): void
    {
        $this->configureR2();
        $token = $this->token();

        $this->apiAs($token, 'PUT', '/api/app/r2', $this->payload(['access_key_id' => '', 'secret_access_key' => '', 'bucket' => 'other']))->assertOk();
        $this->apiAs($token, 'PUT', '/api/app/r2', ['endpoint' => 'https://acc.r2.cloudflarestorage.com', 'bucket' => 'third', 'url' => 'https://cdn.example.com'])->assertOk();

        $settings = Setting::current();
        $this->assertSame('AKIDEXAMPLE1234', $settings->r2_access_key_id);
        $this->assertSame('super-secret-value', $settings->r2_secret_access_key);
        $this->assertSame('third', $settings->r2_bucket);
    }

    public function test_validation_errors_use_app_field_names(): void
    {
        $token = $this->token();

        $this->apiAs($token, 'PUT', '/api/app/r2', $this->payload(['endpoint' => 'http://acc.example.com', 'url' => 'ftp://x.com']))
            ->assertUnprocessable()->assertJsonValidationErrors(['endpoint', 'url']);

        $this->apiAs($token, 'PUT', '/api/app/r2', $this->payload(['access_key_id' => '', 'secret_access_key' => '', 'bucket' => '']))
            ->assertUnprocessable()->assertJsonValidationErrors(['access_key_id', 'secret_access_key', 'bucket']);

        $this->assertNull(Setting::current()->r2_bucket);
    }

    public function test_get_after_put_and_config_reflect_the_change(): void
    {
        $token = $this->token();

        $this->apiAs($token, 'PUT', '/api/app/r2', $this->payload(['bucket' => 'new-bucket']))->assertOk();

        $this->apiAs($token, 'GET', '/api/app/r2')->assertOk()->assertJsonPath('bucket', 'new-bucket');
        $this->apiAs($token, 'GET', '/api/app/config')->assertOk()
            ->assertJsonPath('r2.bucket', 'new-bucket')
            ->assertJsonPath('r2.secret_access_key', 'super-secret-value');
    }

    public function test_connection_test_success_and_failure(): void
    {
        $this->configureR2();
        $token = $this->token();

        $disk = \Mockery::mock(Filesystem::class);
        $disk->shouldReceive('put')->once()->andReturn(true);
        $disk->shouldReceive('delete')->once()->andReturn(true);
        Storage::shouldReceive('build')->once()->andReturn($disk);

        $response = $this->apiAs($token, 'POST', '/api/app/r2/test');
        $this->assertNoStore($response);
        $response->assertOk()->assertExactJson(['ok' => true]);

        $failing = \Mockery::mock(Filesystem::class);
        $failing->shouldReceive('put')->once()->andThrow(new \RuntimeException('boom https://acc.r2.cloudflarestorage.com super-secret-value'));
        Storage::shouldReceive('build')->once()->andReturn($failing);

        $response = $this->apiAs($token, 'POST', '/api/app/r2/test');
        $response->assertOk()->assertExactJson([
            'ok' => false,
            'error' => 'R2 connection test failed. Check the access key, secret, bucket and endpoint.',
        ]);
        $this->assertStringNotContainsString('super-secret-value', $response->getContent());
    }
}
