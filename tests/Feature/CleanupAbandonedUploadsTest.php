<?php

namespace Tests\Feature;

use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CleanupAbandonedUploadsTest extends TestCase
{
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
}
