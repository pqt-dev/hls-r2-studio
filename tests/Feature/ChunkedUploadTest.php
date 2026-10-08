<?php

namespace Tests\Feature;

use App\Events\VideoStatusUpdated;
use App\Http\Controllers\VideoController;
use App\Jobs\MergeUploadChunksJob;
use App\Jobs\TranscodeVideoJob;
use App\Models\User;
use App\Models\Video;
use App\Models\VideoStatusLog;
use App\Support\VideoProgress;
use Illuminate\Foundation\Http\Middleware\TrimStrings;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Event;
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

        // Roughly 1 KB chunks, so the small test payloads span several chunk indexes.
        config(['videos.chunk_size_mb' => 0.001]);

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

    public function test_complete_defers_the_merge_to_the_queued_job(): void
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

        // Nothing is merged in the request: the chunks stay for the job.
        $this->assertSame([], $this->uploadedFiles());
        $this->assertCount(3, Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));

        $video = Video::sole();
        $this->assertSame('pending', $video->status);
        $this->assertSame('queued', $video->stage);
        $this->assertSame(strlen($content), $video->original_size_bytes);
        $this->assertSame($uploadId, $video->upload_id);
        $this->assertSame(VideoProgress::overall('queued', 0, strlen($content), true), $video->progress);

        Queue::assertNotPushed(TranscodeVideoJob::class);
        Queue::assertPushed(MergeUploadChunksJob::class, fn (MergeUploadChunksJob $job) => $job->videoId === $video->id
            && $job->uploadId === $uploadId
            && str_starts_with($job->localUploadPath, Storage::disk('local')->path('uploads/'))
            && str_ends_with($job->localUploadPath, '.mp4'));
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

        // The retried chunk replaced the old one, so the stored total still matches.
        $this->assertCount(3, Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));
        $this->assertSame(1, Video::count());
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

    public function test_it_rejects_a_chunk_index_above_the_upper_bound(): void
    {
        config(['videos.chunk_size_mb' => 1]);
        $uploadId = $this->initUpload('movie.mp4', 1000);

        // 1000 bytes fit in 1 chunk (index 0); the tolerance allows index 1.
        $this->sendChunk($uploadId, 1, 'a')->assertOk();

        $this->sendChunk($uploadId, 2, 'a')
            ->assertStatus(422)
            ->assertJson(['message' => 'The chunk index of this upload is invalid. Please try uploading again.']);
    }

    public function test_it_rejects_filenames_that_are_too_long_or_end_with_a_newline(): void
    {
        // Laravel trims input by default, which would hide the trailing newline.
        $this->withoutMiddleware(TrimStrings::class);

        $this->postJson('/uploads/init', ['filename' => str_repeat('a', 252).'.mp4', 'total_size' => 1000])
            ->assertStatus(422);

        $this->postJson('/uploads/init', ['filename' => "x.mp4\n", 'total_size' => 1000])
            ->assertStatus(422);

        $uploadId = $this->initUpload('movie.mp4', 1000);

        $this->completeUpload($uploadId, str_repeat('a', 252).'.mp4', 1000)->assertStatus(422);
        $this->completeUpload($uploadId, "x.mp4\n", 1000)->assertStatus(422);
    }

    public function test_complete_uses_the_filename_and_size_stored_in_meta(): void
    {
        Queue::fake();

        $content = $this->videoBytes(1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        $this->sendChunk($uploadId, 0, $content)->assertOk();

        $this->completeUpload($uploadId, 'other.mov', 999999)->assertSuccessful();

        $video = Video::firstOrFail();
        $this->assertSame('movie.mp4', $video->original_filename);
        $this->assertSame(strlen($content), $video->original_size_bytes);
    }

    public function test_complete_returns_404_when_the_metadata_is_missing(): void
    {
        $uploadId = $this->initUpload('movie.mp4', 1000);
        $this->sendChunk($uploadId, 0, 'a')->assertOk();

        Storage::disk('local')->delete("chunked_uploads/{$uploadId}/meta.json");

        $this->completeUpload($uploadId, 'movie.mp4', 1000)->assertNotFound();
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

    public function test_it_rejects_a_chunk_body_larger_than_the_configured_chunk_size_and_deletes_it(): void
    {
        config(['videos.chunk_size_mb' => 0.001]);
        $uploadId = $this->initUpload('movie.mp4', 1000000);

        // 0.001 MB = 1049 bytes, plus a 1 KiB tolerance = 2073 bytes.
        $this->sendChunk($uploadId, 0, str_repeat('a', 2073))->assertOk();

        $this->sendChunk($uploadId, 1, str_repeat('a', 2074))
            ->assertStatus(413)
            ->assertJson(['message' => 'Chunk exceeds the maximum allowed chunk size.']);

        $this->assertCount(1, Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));
        $this->assertSame([], array_filter(
            Storage::disk('local')->files("chunked_uploads/{$uploadId}"),
            fn (string $file) => str_ends_with($file, '.tmp')
        ));
    }

    public function test_it_refuses_to_assemble_when_the_free_disk_space_is_too_low(): void
    {
        Queue::fake();
        $this->app->bind(VideoController::class, fn () => new class extends VideoController
        {
            protected function freeDiskSpace(string $path): float|false
            {
                return 1024.0;
            }
        });

        $content = $this->videoBytes(2500);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        foreach (str_split($content, 1000) as $index => $part) {
            $this->sendChunk($uploadId, $index, $part)->assertOk();
        }

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))
            ->assertStatus(507)
            ->assertJson(['message' => 'The server does not have enough free disk space to process this upload.']);

        $this->assertSame([], $this->uploadedFiles());
        $this->assertCount(3, Storage::disk('local')->files("chunked_uploads/{$uploadId}/chunks"));
        $this->assertSame(0, Video::count());
        Queue::assertNothingPushed();
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

    public function test_it_rejects_completion_when_the_first_chunk_is_not_a_video(): void
    {
        Queue::fake();

        $content = str_repeat('a', 2000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        foreach (str_split($content, 1000) as $index => $part) {
            $this->sendChunk($uploadId, $index, $part)->assertOk();
        }

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))
            ->assertStatus(422)
            ->assertJson(['message' => 'File content does not appear to be a valid video.']);

        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
        $this->assertSame(0, Video::count());
        Queue::assertNothingPushed();
    }

    public function test_it_cleans_up_the_record_and_chunks_when_the_merge_job_cannot_be_queued(): void
    {
        Bus::shouldReceive('dispatch')->andThrow(new \RuntimeException('Queue write failed.'));

        $content = $this->videoBytes(1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        $this->sendChunk($uploadId, 0, $content)->assertOk();

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))
            ->assertStatus(500)
            ->assertJson(['message' => 'Unable to queue this video for processing. Please try again.']);

        $this->assertSame([], $this->uploadedFiles());
        Storage::disk('local')->assertDirectoryEmpty('chunked_uploads');
        $this->assertSame(0, Video::count());
    }

    public function test_completing_an_upload_records_and_broadcasts_a_pending_status(): void
    {
        Queue::fake();
        Event::fake([VideoStatusUpdated::class]);

        $content = $this->videoBytes(1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        $this->sendChunk($uploadId, 0, $content)->assertOk();

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))->assertOk();

        $video = Video::sole();

        $this->assertDatabaseHas('video_status_logs', [
            'video_id' => $video->id,
            'status' => 'pending',
            'progress' => VideoProgress::overall('queued', 0, strlen($content), true),
        ]);
        $this->assertGreaterThan(0, $video->progress);
        $this->assertSame(1, VideoStatusLog::where('video_id', $video->id)->count());

        Event::assertDispatched(VideoStatusUpdated::class, fn ($event) => $event->videoId === $video->id && $event->status === 'pending');
    }

    public function test_completing_an_upload_links_the_lines_logged_before_the_video_existed(): void
    {
        Queue::fake();

        $content = $this->videoBytes(1000);
        $uploadId = $this->initUpload('movie.mp4', strlen($content));
        $this->sendChunk($uploadId, 0, $content)->assertOk();

        VideoStatusLog::create(['upload_id' => $uploadId, 'level' => 'info', 'message' => 'Uploading']);
        $unrelated = VideoStatusLog::create(['upload_id' => '11111111-1111-1111-1111-111111111111', 'level' => 'info', 'message' => 'Other']);

        $this->completeUpload($uploadId, 'movie.mp4', strlen($content))->assertOk();

        $video = Video::sole();

        $this->assertSame($video->id, VideoStatusLog::where('message', 'Uploading')->value('video_id'));
        $this->assertNull($unrelated->fresh()->video_id);
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
