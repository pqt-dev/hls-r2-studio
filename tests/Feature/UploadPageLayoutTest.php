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
}
