<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;

class ChunkedUploadTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    /**
     * Build bytes that finfo recognises as an mp4 video, so the upload passes
     * the MIME check in completeUpload().
     */
    private function videoBytes(int $size): string
    {
        $header = "\x00\x00\x00\x20ftypisom\x00\x00\x02\x00isomiso2avc1mp41";

        return substr($header.str_repeat('v', $size), 0, $size);
    }

    private function initUpload(string $filename, int $totalSize): string
    {
        $response = $this->postJson('/uploads/init', [
            'filename' => $filename,
            'total_size' => $totalSize,
        ]);

        $response->assertOk();

        return $response->json('upload_id');
    }

    private function sendChunk(string $uploadId, int $index, string $body): TestResponse
    {
        return $this->call(
            'POST',
            "/uploads/{$uploadId}/chunk",
            [],
            [],
            [],
            [
                'HTTP_X_CHUNK_INDEX' => (string) $index,
                'HTTP_ACCEPT' => 'application/json',
                'CONTENT_TYPE' => 'application/octet-stream',
            ],
            $body
        );
    }

    private function completeUpload(string $uploadId, string $filename, int $totalSize): TestResponse
    {
        return $this->postJson("/uploads/{$uploadId}/complete", [
            'filename' => $filename,
            'total_size' => $totalSize,
        ]);
    }

    /**
     * @return list<string>
     */
    private function uploadedFiles(): array
    {
        return Storage::disk('local')->files('uploads');
    }

    public function test_it_assembles_chunks_sent_in_order_into_the_original_file(): void
    {
        Queue::fake();

        $content = $this->videoBytes(3000);
        $chunks = str_split($content, 1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));

        foreach ($chunks as $index => $chunk) {
            $this->sendChunk($uploadId, $index, $chunk)
                ->assertOk()
                ->assertJson(['received_index' => $index, 'ok' => true]);
        }

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))
            ->assertOk()
            ->assertJsonStructure(['redirect']);

        $files = $this->uploadedFiles();
        $this->assertCount(1, $files);
        $this->assertSame($content, Storage::disk('local')->get($files[0]));

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');

        $video = Video::sole();
        $this->assertSame('pending', $video->status);
        $this->assertSame(strlen($content), $video->original_size_bytes);

        Queue::assertPushed(TranscodeVideoJob::class);
    }

    public function test_resending_the_same_chunk_does_not_duplicate_data(): void
    {
        Queue::fake();

        $content = $this->videoBytes(3000);
        $chunks = str_split($content, 1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));

        foreach ($chunks as $index => $chunk) {
            $this->sendChunk($uploadId, $index, $chunk)->assertOk();
        }

        // The client considers chunk 1 failed and retries it.
        $this->sendChunk($uploadId, 1, $chunks[1])->assertOk();

        $this->assertCount(3, Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))->assertOk();

        $files = $this->uploadedFiles();
        $this->assertCount(1, $files);
        $this->assertSame($content, Storage::disk('local')->get($files[0]));
    }

    public function test_it_rejects_completion_when_a_chunk_is_missing(): void
    {
        Queue::fake();

        $content = $this->videoBytes(3000);
        $chunks = str_split($content, 1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));

        // Chunk 1 never arrives.
        $this->sendChunk($uploadId, 0, $chunks[0])->assertOk();
        $this->sendChunk($uploadId, 2, $chunks[2])->assertOk();

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))
            ->assertStatus(422)
            ->assertJson(['message' => 'Upload is incomplete: missing part 1. Please try uploading again.']);

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
        $this->assertSame([], $this->uploadedFiles());
        $this->assertSame(0, Video::count());
        Queue::assertNothingPushed();
    }

    public function test_it_rejects_a_chunk_when_the_upload_metadata_is_unusable(): void
    {
        $uploadId = $this->initUpload('movie.mp4', 1000);

        Storage::disk('local')->delete("chunked_uploads/{$uploadId}/meta.json");

        $this->sendChunk($uploadId, 0, str_repeat('a', 600))
            ->assertStatus(422)
            ->assertJson(['message' => 'Upload session is invalid or expired. Please start a new upload.']);

        $this->assertSame([], Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));
    }

    public function test_it_rejects_a_chunk_when_the_upload_metadata_is_corrupted(): void
    {
        $uploadId = $this->initUpload('movie.mp4', 1000);

        Storage::disk('local')->put("chunked_uploads/{$uploadId}/meta.json", 'not json at all');

        $this->sendChunk($uploadId, 0, str_repeat('a', 600))
            ->assertStatus(422)
            ->assertJson(['message' => 'Upload session is invalid or expired. Please start a new upload.']);

        $this->assertSame([], Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));
    }

    public function test_it_rejects_a_chunk_that_exceeds_the_declared_total_size(): void
    {
        $uploadId = $this->initUpload('movie.mp4', 1000);

        $this->sendChunk($uploadId, 0, str_repeat('a', 600))->assertOk();

        $this->sendChunk($uploadId, 1, str_repeat('b', 600))
            ->assertStatus(413)
            ->assertJson(['message' => 'Upload exceeds the declared file size.']);

        $storedChunks = Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks");
        $this->assertCount(1, $storedChunks);
        $this->assertStringEndsWith('0.chunk', $storedChunks[0]);
    }

    public function test_resending_a_chunk_is_not_counted_twice_against_the_declared_size(): void
    {
        $uploadId = $this->initUpload('movie.mp4', 1000);

        $this->sendChunk($uploadId, 0, str_repeat('a', 600))->assertOk();
        $this->sendChunk($uploadId, 0, str_repeat('a', 600))->assertOk();

        $this->assertCount(1, Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));
    }

    public function test_it_reports_a_user_friendly_message_and_cleans_up_on_size_mismatch(): void
    {
        Queue::fake();

        $uploadId = $this->initUpload('movie.mp4', 1000);
        $this->sendChunk($uploadId, 0, $this->videoBytes(900))->assertOk();

        $this->completeUpload($uploadId, 'movie.mp4', 1000)
            ->assertStatus(422)
            ->assertJson(['message' => 'The uploaded file appears incomplete or corrupted. Please try uploading again.']);

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
        $this->assertSame([], $this->uploadedFiles());
        $this->assertSame(0, Video::count());
    }

    public function test_it_cleans_up_the_file_and_record_when_the_transcode_job_cannot_be_queued(): void
    {
        Bus::shouldReceive('dispatch')->andThrow(new \RuntimeException('Queue write failed.'));

        $content = $this->videoBytes(1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        $this->sendChunk($uploadId, 0, $content)->assertOk();

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))
            ->assertStatus(500)
            ->assertJson(['message' => 'Unable to queue this video for processing. Please try again.']);

        $this->assertSame([], $this->uploadedFiles());
        $this->assertSame(0, Video::count());
    }

    public function test_it_rejects_an_upload_id_that_is_not_a_uuid(): void
    {
        $this->sendChunk('not-a-valid-upload-id', 0, 'data')->assertNotFound();

        $this->postJson('/uploads/not-a-valid-upload-id/complete', [
            'filename' => 'movie.mp4',
            'total_size' => 1000,
        ])->assertNotFound();
    }
}
