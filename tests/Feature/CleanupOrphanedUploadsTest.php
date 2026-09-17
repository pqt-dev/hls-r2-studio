<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CleanupOrphanedUploadsTest extends TestCase
{
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
}
