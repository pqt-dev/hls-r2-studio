<?php

namespace Tests\Feature;

use App\Models\Setting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Tests\TestCase;

class ImportR2EnvCommandTest extends TestCase
{
    use RefreshDatabase;

    private function setEnvConfig(array $overrides = []): void
    {
        config(['filesystems.disks.r2' => $overrides + [
            'driver' => 's3',
            'key' => 'env-key-id',
            'secret' => 'env-secret-value',
            'bucket' => 'env-bucket',
            'endpoint' => 'https://env.example.com',
            'url' => 'https://cdn-env.example.com',
        ]]);
    }

    public function test_imports_all_fields_into_an_empty_database_without_printing_values(): void
    {
        $this->setEnvConfig();

        $this->artisan('r2:import-env')->assertSuccessful();

        $settings = Setting::find(1);
        $this->assertSame('env-key-id', $settings->r2_access_key_id);
        $this->assertSame('env-secret-value', $settings->r2_secret_access_key);
        $this->assertSame('env-bucket', $settings->r2_bucket);
        $this->assertSame('https://env.example.com', $settings->r2_endpoint);
        $this->assertSame('https://cdn-env.example.com', $settings->r2_url);

        $output = $this->runAndCapture();
        foreach (['env-key-id', 'env-secret-value', 'env-bucket', 'env.example.com'] as $secret) {
            $this->assertStringNotContainsString($secret, $output);
        }
    }

    public function test_output_lists_imported_field_names_only(): void
    {
        $this->setEnvConfig();

        Artisan::call('r2:import-env');
        $output = Artisan::output();

        $this->assertStringContainsString('r2_access_key_id', $output);
        $this->assertStringContainsString('r2_secret_access_key', $output);
        $this->assertStringNotContainsString('env-secret-value', $output);
        $this->assertStringNotContainsString('env-key-id', $output);
    }

    public function test_never_overwrites_existing_db_values_and_is_idempotent(): void
    {
        $this->setEnvConfig();
        Setting::current()->update(['r2_bucket' => 'db-bucket', 'r2_secret_access_key' => 'db-secret']);

        $this->artisan('r2:import-env')->assertSuccessful();

        $settings = Setting::find(1);
        $this->assertSame('db-bucket', $settings->r2_bucket);
        $this->assertSame('db-secret', $settings->r2_secret_access_key);
        $this->assertSame('env-key-id', $settings->r2_access_key_id);
        $this->assertSame('https://env.example.com', $settings->r2_endpoint);

        $this->setEnvConfig(['key' => 'changed-key']);
        $this->artisan('r2:import-env')->expectsOutputToContain('Nothing to import')->assertSuccessful();

        $this->assertSame('env-key-id', Setting::find(1)->r2_access_key_id);
    }

    public function test_reports_incomplete_env_and_imports_nothing(): void
    {
        $this->setEnvConfig(['secret' => null, 'url' => '']);

        $this->artisan('r2:import-env')->expectsOutputToContain('incomplete')->assertSuccessful();

        $settings = Setting::find(1);
        $this->assertNull($settings->r2_access_key_id);
        $this->assertNull($settings->r2_bucket);
    }

    private function runAndCapture(): string
    {
        Setting::query()->update(['r2_access_key_id' => null, 'r2_secret_access_key' => null, 'r2_bucket' => null, 'r2_endpoint' => null, 'r2_url' => null]);
        Artisan::call('r2:import-env');

        return Artisan::output();
    }
}
