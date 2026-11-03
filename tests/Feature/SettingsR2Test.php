<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class SettingsR2Test extends TestCase
{
    use RefreshDatabase;

    private function validPayload(array $overrides = []): array
    {
        return $overrides + [
            'r2_access_key_id' => 'AKIDEXAMPLE1234',
            'r2_secret_access_key' => 'super-secret-value',
            'r2_bucket' => 'my-bucket',
            'r2_endpoint' => 'https://acc.r2.cloudflarestorage.com',
            'r2_url' => 'https://cdn.example.com/',
        ];
    }

    private function login(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    public function test_saves_r2_settings_and_normalizes_values(): void
    {
        $this->login();

        $this->put('/settings/r2', $this->validPayload(['r2_bucket' => '  my-bucket  ']))
            ->assertSessionHas('success', 'R2 settings saved.')
            ->assertSessionDoesntHaveErrors();

        $settings = Setting::find(1);
        $this->assertSame('AKIDEXAMPLE1234', $settings->r2_access_key_id);
        $this->assertSame('super-secret-value', $settings->r2_secret_access_key);
        $this->assertSame('my-bucket', $settings->r2_bucket);
        $this->assertSame('https://acc.r2.cloudflarestorage.com', $settings->r2_endpoint);
        $this->assertSame('https://cdn.example.com', $settings->r2_url);
        $this->assertTrue($settings->hasR2Config());
    }

    public function test_flash_never_contains_secret_values(): void
    {
        $this->login();

        $response = $this->put('/settings/r2', $this->validPayload());

        $this->assertStringNotContainsString('super-secret-value', json_encode(session()->all()));
        $this->assertStringNotContainsString('AKIDEXAMPLE1234', json_encode(session()->all()));
        $response->assertSessionHas('success');
    }

    public function test_blank_credentials_keep_the_stored_values(): void
    {
        $this->login();
        $this->put('/settings/r2', $this->validPayload());

        $this->put('/settings/r2', $this->validPayload([
            'r2_access_key_id' => '',
            'r2_secret_access_key' => '',
            'r2_bucket' => 'other-bucket',
        ]))->assertSessionHas('success')->assertSessionDoesntHaveErrors();

        $settings = Setting::find(1);
        $this->assertSame('AKIDEXAMPLE1234', $settings->r2_access_key_id);
        $this->assertSame('super-secret-value', $settings->r2_secret_access_key);
        $this->assertSame('other-bucket', $settings->r2_bucket);
    }

    public function test_new_credentials_replace_the_stored_values(): void
    {
        $this->login();
        $this->put('/settings/r2', $this->validPayload());

        $this->put('/settings/r2', $this->validPayload([
            'r2_access_key_id' => 'NEWKEY9999',
            'r2_secret_access_key' => 'new-secret',
        ]))->assertSessionHas('success');

        $settings = Setting::find(1);
        $this->assertSame('NEWKEY9999', $settings->r2_access_key_id);
        $this->assertSame('new-secret', $settings->r2_secret_access_key);
    }

    public function test_credentials_are_required_when_none_are_stored(): void
    {
        $this->login();

        $this->put('/settings/r2', $this->validPayload(['r2_access_key_id' => '', 'r2_secret_access_key' => '']))
            ->assertSessionHasErrors(['r2_access_key_id', 'r2_secret_access_key']);
    }

    public function test_bucket_endpoint_and_url_are_required(): void
    {
        $this->login();

        $this->put('/settings/r2', $this->validPayload(['r2_bucket' => '', 'r2_endpoint' => '', 'r2_url' => '']))
            ->assertSessionHasErrors(['r2_bucket', 'r2_endpoint', 'r2_url']);
    }

    public function test_endpoint_and_url_must_be_https(): void
    {
        $this->login();

        $this->put('/settings/r2', $this->validPayload(['r2_endpoint' => 'http://acc.example.com', 'r2_url' => 'http://cdn.example.com']))
            ->assertSessionHasErrors(['r2_endpoint', 'r2_url']);

        $this->put('/settings/r2', $this->validPayload(['r2_endpoint' => 'not a url', 'r2_url' => 'ftp://cdn.example.com']))
            ->assertSessionHasErrors(['r2_endpoint', 'r2_url']);

        $this->assertNull(Setting::current()->r2_bucket);
    }

    public function test_guests_cannot_save_or_test_r2_settings(): void
    {
        $this->put('/settings/r2', $this->validPayload())->assertNotFound();
        $this->post('/settings/r2/test')->assertNotFound();

        $this->assertNull(Setting::current()->r2_bucket);
    }

    public function test_settings_page_never_contains_secret_values(): void
    {
        $this->login();
        $this->put('/settings/r2', $this->validPayload());

        $html = $this->get('/settings')->assertOk()->getContent();

        $this->assertStringNotContainsString('super-secret-value', $html);
        $this->assertStringNotContainsString('AKIDEXAMPLE1234', $html);
        $this->assertStringContainsString('ends with 1234', $html);
        $this->assertStringContainsString('my-bucket', $html);
        $this->assertStringNotContainsString('still comes from .env', $html);
    }

    public function test_settings_page_hints_when_config_comes_from_env(): void
    {
        $this->login();

        $this->get('/settings')->assertOk()->assertSee('still comes from .env');
    }

    public function test_connection_test_writes_and_deletes_a_temp_object(): void
    {
        $this->login();
        $fake = Storage::fake('r2-test');
        Storage::partialMock()->shouldReceive('build')->once()->andReturn($fake);

        $this->post('/settings/r2/test')->assertSessionHas('success', 'R2 connection test succeeded.');

        $this->assertSame([], $fake->allFiles());
    }

    public function test_connection_test_reports_a_generic_error_without_details(): void
    {
        $this->login();
        $disk = \Mockery::mock(Filesystem::class);
        $disk->shouldReceive('put')->andThrow(new \RuntimeException('boom secret-leak'));
        Storage::partialMock()->shouldReceive('build')->once()->andReturn($disk);

        $response = $this->post('/settings/r2/test');

        $response->assertSessionHasErrors('r2_test');
        $this->assertStringNotContainsString('secret-leak', json_encode(session()->all()));
    }
}
