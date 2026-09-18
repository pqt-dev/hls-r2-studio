<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Tests\TestCase;

class SettingsDisplayTimezoneTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    public function test_display_timezone_can_be_updated(): void
    {
        $response = $this->put('/settings/display', [
            'videos_per_page' => 24,
            'display_timezone' => 'Asia/Tokyo',
        ]);

        $response->assertRedirect();
        $response->assertSessionHasNoErrors();

        $this->assertSame('Asia/Tokyo', Setting::current()->display_timezone);
    }

    public function test_invalid_display_timezone_is_rejected(): void
    {
        $response = $this->from('/settings')->put('/settings/display', [
            'videos_per_page' => 24,
            'display_timezone' => 'Not/A_Real_Timezone',
        ]);

        $response->assertSessionHasErrors('display_timezone');
    }

    public function test_to_display_macro_converts_utc_to_configured_timezone(): void
    {
        Setting::current()->update(['display_timezone' => 'Asia/Ho_Chi_Minh']);

        $utcMoment = Carbon::parse('2026-09-18 03:00:00', 'UTC');

        $this->assertSame('18/09/2026 10:00', $utcMoment->toDisplay());
    }
}
