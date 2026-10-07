<?php

namespace Tests\Feature;

use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CleanupOrphanedUploadsTest extends TestCase
{
    use RefreshDatabase;

    private function touchFile(string $relativePath, int $timestamp): void
    {
        touch(Storage::disk('local')->path($relativePath), $timestamp);
    }

    public function test_it_deletes_upload_files_older_than_ttl(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_upload_ttl_hours' => 72]);
        Storage::disk('local')->put('uploads/old.mp4', 'content');
        $this->touchFile('uploads/old.mp4', now()->subHours(100)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-uploads');

        Storage::disk('local')->assertMissing('uploads/old.mp4');
    }

    public function test_it_leaves_upload_files_newer_than_ttl_untouched(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_upload_ttl_hours' => 72]);
        Storage::disk('local')->put('uploads/new.mp4', 'content');
        $this->touchFile('uploads/new.mp4', now()->subHours(1)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-uploads');

        Storage::disk('local')->assertExists('uploads/new.mp4');
    }

    public function test_it_keeps_an_old_file_while_an_older_pending_video_exists(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_upload_ttl_hours' => 72]);

        $video = Video::create([
            'title' => 'Waiting video',
            'original_filename' => 'test.mp4',
            'status' => 'pending',
        ]);
        $video->forceFill(['created_at' => now()->subHours(200)])->save();

        Storage::disk('local')->put('uploads/waiting.mp4', 'content');
        $this->touchFile('uploads/waiting.mp4', now()->subHours(100)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-uploads');

        Storage::disk('local')->assertExists('uploads/waiting.mp4');
    }

    public function test_it_deletes_an_old_file_when_there_are_no_active_videos(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_upload_ttl_hours' => 72]);

        $video = Video::create([
            'title' => 'Finished video',
            'original_filename' => 'test.mp4',
            'status' => 'ready',
        ]);
        $video->forceFill(['created_at' => now()->subHours(200)])->save();

        Storage::disk('local')->put('uploads/old.mp4', 'content');
        $this->touchFile('uploads/old.mp4', now()->subHours(100)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-uploads');

        Storage::disk('local')->assertMissing('uploads/old.mp4');
    }

    public function test_it_skips_cleanup_when_keep_original_upload_is_enabled(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_upload_ttl_hours' => 72, 'videos.keep_original_upload' => true]);
        Storage::disk('local')->put('uploads/old.mp4', 'content');
        $this->touchFile('uploads/old.mp4', now()->subHours(100)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-uploads')
            ->expectsOutput('keep_original_upload is enabled; skipping.')
            ->assertSuccessful();

        Storage::disk('local')->assertExists('uploads/old.mp4');
    }

    public function test_it_deletes_old_uploads_when_keep_original_upload_is_disabled(): void
    {
        Storage::fake('local');
        config(['videos.orphaned_upload_ttl_hours' => 72, 'videos.keep_original_upload' => false]);
        Storage::disk('local')->put('uploads/old.mp4', 'content');
        $this->touchFile('uploads/old.mp4', now()->subHours(100)->getTimestamp());

        $this->artisan('videos:cleanup-orphaned-uploads')->assertSuccessful();

        Storage::disk('local')->assertMissing('uploads/old.mp4');
    }
}
