<?php

namespace Tests\Feature;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class SettingsTranscodeTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    public function test_valid_update_persists_values(): void
    {
        $response = $this->put('/settings/transcode', [
            'transcode_resolution' => '720',
            'transcode_segment_seconds' => 6,
            'transcode_fps' => 30,
        ]);

        $response->assertSessionHas('success', 'Transcoding options saved.');

        $settings = Setting::current()->fresh();
        $this->assertSame(720, (int) $settings->transcode_resolution);
        $this->assertSame(6, (int) $settings->transcode_segment_seconds);
        $this->assertSame(30, (int) $settings->transcode_fps);
    }

    public function test_fps_is_optional(): void
    {
        $this->put('/settings/transcode', [
            'transcode_resolution' => '480',
            'transcode_segment_seconds' => 2,
        ])->assertSessionHasNoErrors();

        $this->assertNull(Setting::current()->fresh()->transcode_fps);
    }

    public function test_invalid_values_are_rejected_and_nothing_is_saved(): void
    {
        Setting::current()->update([
            'transcode_resolution' => '1080',
            'transcode_segment_seconds' => 4,
            'transcode_fps' => null,
        ]);

        $this->put('/settings/transcode', [
            'transcode_resolution' => '999',
            'transcode_segment_seconds' => 1,
            'transcode_fps' => 10,
        ])->assertSessionHasErrors(['transcode_resolution', 'transcode_segment_seconds', 'transcode_fps']);

        $this->put('/settings/transcode', [
            'transcode_resolution' => '720',
            'transcode_segment_seconds' => 16,
            'transcode_fps' => 61,
        ])->assertSessionHasErrors(['transcode_segment_seconds', 'transcode_fps']);

        $this->put('/settings/transcode', [])->assertSessionHasErrors(['transcode_resolution', 'transcode_segment_seconds']);

        $settings = Setting::current()->fresh();
        $this->assertSame(1080, (int) $settings->transcode_resolution);
        $this->assertSame(4, (int) $settings->transcode_segment_seconds);
    }
}
