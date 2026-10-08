<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class UploadPageLayoutTest extends TestCase
{
    use RefreshDatabase;

    public function test_upload_page_shows_new_headings_and_submit_button(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/upload')
            ->assertOk()
            ->assertSee('Processing Queue')
            ->assertSee('Activity Log')
            ->assertSee('Start upload')
            ->assertSee('id="upload-submit"', false)
            ->assertDontSee('Upload Progress');
    }

    public function test_upload_page_script_has_stage_aware_status_text_and_rate_limit_wait(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/upload')
            ->assertOk()
            ->assertSee('function transcodeStatusText(status, stage, progress)', false)
            ->assertSee('function isMergingPending(status, stage)', false)
            ->assertSee('Server busy, retrying in ', false);
    }
}
