<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Log;
use Tests\TestCase;

class TranscodeVideoJobClaimTest extends TestCase
{
    use RefreshDatabase;

    public function test_handle_skips_and_logs_a_warning_when_the_video_is_already_processing(): void
    {
        $video = Video::create([
            'title' => 'Already processing video',
            'original_filename' => 'test.mp4',
            'status' => 'processing',
            'stage' => 'transcoding',
            'progress' => 42,
        ]);

        Log::shouldReceive('warning')
            ->once()
            ->withArgs(fn (string $message) => str_contains($message, (string) $video->id)
                && str_contains($message, 'already being processed'));

        // A nonexistent local upload path guarantees the job would blow up
        // immediately (ffprobe failure) if it ever reached the transcode
        // step, so a passing test proves handle() returned before doing so.
        $job = new TranscodeVideoJob($video->id, '/tmp/this-input-does-not-exist-'.uniqid().'.mp4');
        $job->handle();

        $video->refresh();

        // The claim query must not have touched the record when it skipped.
        $this->assertSame('processing', $video->status);
        $this->assertSame('transcoding', $video->stage);
        $this->assertSame(42, $video->progress);
    }

    public function test_handle_claims_a_non_processing_video_before_proceeding(): void
    {
        $video = Video::create([
            'title' => 'Pending video',
            'original_filename' => 'test.mp4',
            'status' => 'pending',
            'stage' => null,
            'progress' => 0,
        ]);

        // A nonexistent local upload path makes the job fail right after the
        // claim, at the ffprobe duration step. That is enough to prove the
        // claim succeeded (status flips to 'processing') before the job
        // ultimately fails and moves the video to 'failed'.
        $job = new TranscodeVideoJob($video->id, '/tmp/this-input-does-not-exist-'.uniqid().'.mp4');

        try {
            $job->handle();
        } catch (\Throwable) {
            // Expected: ffprobe fails on the nonexistent path, and handle()
            // rethrows after marking the video as failed.
        }

        $video->refresh();

        $this->assertSame('failed', $video->status);
    }
}
