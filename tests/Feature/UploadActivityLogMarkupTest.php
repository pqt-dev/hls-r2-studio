<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class UploadActivityLogMarkupTest extends TestCase
{
    use RefreshDatabase;

    public function test_upload_page_embeds_activity_log_endpoints_and_storage_keys(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/upload')
            ->assertOk()
            ->assertSee('id="upload-log"', false)
            ->assertSee('id="copy-log-btn"', false)
            ->assertSee('title="Copy the visible log lines to the clipboard"', false)
            ->assertSee('Copy log', false)
            ->assertSee('hls_activity_outbox', false)
            ->assertSee('hls_activity_cleared_at', false)
            ->assertSee('hls_upload_active', false)
            ->assertSee('Upload interrupted: the page was reloaded or closed while uploading', false)
            ->assertSee('/activity-log', false)
            ->assertDontSee('aria-disabled:cursor-not-allowed', false)
            ->assertSee('stored_cids', false)
            ->assertSee(', smallest first.', false)
            ->assertDontSee('hls_upload_log_dismissed', false);
    }

    public function test_clear_log_explains_it_only_hides_lines_in_this_browser(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $note = 'Clear log only hides these lines in this browser. Stored logs are not deleted.';

        $html = $this->get('/upload')
            ->assertOk()
            ->assertSee($note, false)
            ->assertSee('title="Hides these lines in this browser only. Stored logs are not deleted."', false)
            ->getContent();

        $logStart = strpos($html, 'id="upload-log"');
        $logEnd = strpos($html, '</div>', $logStart);
        $notePos = strpos($html, $note);

        $this->assertGreaterThan($logEnd, $notePos, 'Footer note must come after and outside #upload-log.');
    }

    public function test_upload_page_appends_files_to_a_shared_queue_without_locking_the_form(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->get('/upload')
            ->assertOk()
            ->assertSee('window.__uploadQueue', false)
            ->assertSee('window.__uploadRunner', false)
            ->assertSee('Added ', false)
            ->assertSee('to the upload queue', false)
            ->assertDontSee('Upload in progress…', false)
            ->assertDontSee('An upload is already running', false)
            ->assertDontSee('upload:finished', false)
            ->assertDontSee('setUploadLocked', false);
    }
}
