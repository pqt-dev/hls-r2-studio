<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SettingsStorageTest extends TestCase
{
    use RefreshDatabase;

    public function test_storage_option_can_be_saved_as_true_and_false(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->put('/settings/storage', [])->assertSessionHas('success');
        $this->assertFalse(Setting::current()->delete_from_r2_on_destroy);

        $this->put('/settings/storage', ['delete_from_r2_on_destroy' => '1'])->assertSessionHas('success');
        $this->assertTrue(Setting::current()->delete_from_r2_on_destroy);
    }

    public function test_guest_is_redirected_to_login(): void
    {
        $this->put('/settings/storage', [])->assertRedirect('/login');
    }
}
