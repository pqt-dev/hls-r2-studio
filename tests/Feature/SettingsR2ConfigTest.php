<?php

namespace Tests\Feature;

use App\Models\Setting;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

class SettingsR2ConfigTest extends TestCase
{
    use RefreshDatabase;

    private function fillDb(array $overrides = []): Setting
    {
        $settings = Setting::current();
        $settings->update($overrides + [
            'r2_access_key_id' => 'db-key-id-1234',
            'r2_secret_access_key' => 'db-secret-value',
            'r2_bucket' => 'db-bucket',
            'r2_endpoint' => 'https://db.example.com',
            'r2_url' => 'https://cdn-db.example.com',
        ]);

        return $settings->fresh();
    }

    private function setEnvConfig(): void
    {
        config(['filesystems.disks.r2' => [
            'driver' => 's3',
            'key' => 'env-key',
            'secret' => 'env-secret',
            'bucket' => 'env-bucket',
            'endpoint' => 'https://env.example.com',
            'url' => 'https://cdn-env.example.com',
            'use_path_style_endpoint' => true,
        ]]);
    }

    public function test_secret_columns_are_encrypted_at_rest_and_decrypt_through_the_model(): void
    {
        $this->fillDb();

        $raw = DB::table('settings')->where('id', 1)->first();

        $this->assertNotSame('db-key-id-1234', $raw->r2_access_key_id);
        $this->assertNotSame('db-secret-value', $raw->r2_secret_access_key);
        $this->assertStringNotContainsString('db-secret-value', $raw->r2_secret_access_key);

        $settings = Setting::find(1);
        $this->assertSame('db-key-id-1234', $settings->r2_access_key_id);
        $this->assertSame('db-secret-value', $settings->r2_secret_access_key);
    }

    public function test_secret_columns_are_hidden_from_serialization(): void
    {
        $array = $this->fillDb()->toArray();

        $this->assertArrayNotHasKey('r2_access_key_id', $array);
        $this->assertArrayNotHasKey('r2_secret_access_key', $array);
        $this->assertSame('db-bucket', $array['r2_bucket']);
    }

    public function test_disk_uses_db_values_when_complete(): void
    {
        $this->setEnvConfig();
        $settings = $this->fillDb();

        $this->assertTrue($settings->hasR2Config());

        $config = $settings->r2Disk()->getConfig();
        $this->assertSame('db-key-id-1234', $config['key']);
        $this->assertSame('db-secret-value', $config['secret']);
        $this->assertSame('db-bucket', $config['bucket']);
        $this->assertSame('https://db.example.com', $config['endpoint']);
        $this->assertSame('https://cdn-db.example.com', $config['url']);
        $this->assertSame('auto', $config['region']);
        $this->assertSame('s3', $config['driver']);
        $this->assertTrue($config['use_path_style_endpoint']);
    }

    public function test_disk_falls_back_to_env_when_db_is_empty_or_incomplete(): void
    {
        $this->setEnvConfig();

        $settings = Setting::current();
        $this->assertFalse($settings->hasR2Config());
        $this->assertSame('env-bucket', $settings->r2Disk()->getConfig()['bucket']);

        $incomplete = $this->fillDb(['r2_url' => null]);
        $this->assertFalse($incomplete->hasR2Config());

        $config = $incomplete->r2Disk()->getConfig();
        $this->assertSame('env-key', $config['key']);
        $this->assertSame('env-secret', $config['secret']);
        $this->assertSame('env-bucket', $config['bucket']);
        $this->assertSame('https://env.example.com', $config['endpoint']);
        $this->assertSame('https://cdn-env.example.com', $config['url']);
    }

    public function test_disk_falls_back_to_env_when_a_stored_value_cannot_be_decrypted(): void
    {
        $this->setEnvConfig();
        $this->fillDb();
        DB::table('settings')->where('id', 1)->update(['r2_secret_access_key' => 'not-a-valid-payload']);

        $settings = Setting::find(1);

        $this->assertFalse($settings->hasR2Config());
        $this->assertFalse($settings->hasR2Secret());
        $this->assertSame('env-secret', $settings->r2Disk()->getConfig()['secret']);
    }
}
