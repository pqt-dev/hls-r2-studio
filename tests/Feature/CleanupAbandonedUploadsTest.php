<?php

namespace Tests\Feature;

use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CleanupAbandonedUploadsTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');
        config(['videos.abandoned_upload_ttl_hours' => 24]);
    }

    private function makeUploadDirectory(string $uploadId, int $directoryTimestamp): void
    {
        Storage::disk('local')->put("chunked_uploads/{$uploadId}/meta.json", '{"total_size":1000}');

        $absolutePath = Storage::disk('local')->path("chunked_uploads/{$uploadId}");
        touch($absolutePath.'/meta.json', $directoryTimestamp);
        touch($absolutePath, $directoryTimestamp);
    }

    private function storeChunk(string $uploadId, int $index, int $timestamp): void
    {
        Storage::disk('local')->put("chunked_uploads/{$uploadId}/chunks/{$index}.chunk", 'data');

        touch(Storage::disk('local')->path("chunked_uploads/{$uploadId}/chunks/{$index}.chunk"), $timestamp);
    }

    public function test_it_deletes_a_directory_with_no_chunks_older_than_the_ttl(): void
    {
        $this->makeUploadDirectory('old-session', now()->subHours(48)->getTimestamp());

        $this->artisan('uploads:cleanup-abandoned');

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
    }

    public function test_it_keeps_an_upload_whose_newest_chunk_is_recent(): void
    {
        // The directory itself is stale, but chunks are still arriving, which
        // is exactly what a long upload started before the TTL looks like.
        $this->makeUploadDirectory('active-session', now()->subHours(48)->getTimestamp());
        $this->storeChunk('active-session', 0, now()->subHours(48)->getTimestamp());
        $this->storeChunk('active-session', 1, now()->subMinutes(5)->getTimestamp());

        $this->artisan('uploads:cleanup-abandoned');

        Storage::disk('local')->assertExists('chunked_uploads/active-session/chunks/1.chunk');
    }

    public function test_it_deletes_an_upload_whose_newest_chunk_is_older_than_the_ttl(): void
    {
        $this->makeUploadDirectory('stalled-session', now()->subHours(48)->getTimestamp());
        $this->storeChunk('stalled-session', 0, now()->subHours(30)->getTimestamp());

        $this->artisan('uploads:cleanup-abandoned');

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
    }

    public function test_it_keeps_a_stale_directory_whose_video_is_still_waiting_for_its_merge(): void
    {
        foreach (['pending', 'processing'] as $status) {
            $uploadId = "queued-{$status}";
            $this->makeUploadDirectory($uploadId, now()->subHours(48)->getTimestamp());
            $this->storeChunk($uploadId, 0, now()->subHours(48)->getTimestamp());

            Video::create(['title' => 'v', 'original_filename' => 'v.mp4', 'status' => $status, 'upload_id' => $uploadId]);
        }

        $this->artisan('uploads:cleanup-abandoned');

        Storage::disk('local')->assertExists('chunked_uploads/queued-pending/chunks/0.chunk');
        Storage::disk('local')->assertExists('chunked_uploads/queued-processing/chunks/0.chunk');
    }

    public function test_it_deletes_a_stale_directory_whose_video_is_already_finished(): void
    {
        foreach (['ready', 'failed'] as $status) {
            $uploadId = "done-{$status}";
            $this->makeUploadDirectory($uploadId, now()->subHours(48)->getTimestamp());
            $this->storeChunk($uploadId, 0, now()->subHours(48)->getTimestamp());

            Video::create(['title' => 'v', 'original_filename' => 'v.mp4', 'status' => $status, 'upload_id' => $uploadId]);
        }

        $this->artisan('uploads:cleanup-abandoned');

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
    }
}
