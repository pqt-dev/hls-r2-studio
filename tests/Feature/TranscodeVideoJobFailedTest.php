<?php

namespace Tests\Feature;

use App\Jobs\TranscodeVideoJob;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class TranscodeVideoJobFailedTest extends TestCase
{
    use RefreshDatabase;

    private function makeVideo(string $status): Video
    {
        return Video::create([
            'title' => 'video',
            'original_filename' => 'video.mp4',
            'status' => $status,
            'stage' => $status,
            'progress' => 50,
        ]);
    }

    private function job(int $videoId): TranscodeVideoJob
    {
        return new TranscodeVideoJob($videoId, '/tmp/this-input-does-not-exist-'.uniqid().'.mp4');
    }

    public function test_failed_marks_a_still_processing_video_as_failed(): void
    {
        $video = $this->makeVideo('processing');

        $this->job($video->id)->failed(new \RuntimeException('Worker killed.'));

        $video->refresh();
        $this->assertSame('failed', $video->status);
        $this->assertSame('failed', $video->stage);
        $this->assertStringStartsWith('Unable to process this video.', $video->error_message);
    }

    public function test_failed_is_a_no_op_when_the_video_is_already_failed_or_ready(): void
    {
        foreach (['failed', 'ready'] as $status) {
            $video = $this->makeVideo($status);

            $this->job($video->id)->failed(new \RuntimeException('Late failure.'));

            $video->refresh();
            $this->assertSame($status, $video->status);
            $this->assertSame($status, $video->stage);
            $this->assertNull($video->error_message);
        }
    }

    public function test_failed_does_nothing_when_the_video_no_longer_exists(): void
    {
        $this->job(999999)->failed(new \RuntimeException('Gone.'));

        $this->assertSame(0, Video::count());
    }

    public function test_failed_stores_failed_at_and_a_technical_error_detail(): void
    {
        $video = $this->makeVideo('processing');

        $this->job($video->id)->failed(new \RuntimeException('ffmpeg transcode failed: moov atom not found'));

        $video->refresh();
        $this->assertNotNull($video->failed_at);
        $this->assertSame('RuntimeException: ffmpeg transcode failed: moov atom not found', $video->error_detail);
        $this->assertStringStartsWith('Unable to process this video.', $video->error_message);
    }

    public function test_error_detail_keeps_only_the_last_2000_characters_with_a_leading_ellipsis(): void
    {
        $video = $this->makeVideo('processing');

        $this->job($video->id)->failed(new \RuntimeException(str_repeat('a', 5000).'REAL-ERROR-AT-THE-END'));

        $video->refresh();
        $this->assertSame(2001, mb_strlen($video->error_detail));
        $this->assertStringStartsWith('…', $video->error_detail);
        $this->assertStringEndsWith('REAL-ERROR-AT-THE-END', $video->error_detail);
    }

    public function test_error_detail_strips_project_paths_and_control_characters(): void
    {
        $video = $this->makeVideo('processing');

        $this->job($video->id)->failed(new \RuntimeException(
            'Cannot open '.storage_path('app/private/hls_tmp/1/playlist.m3u8').' and '.base_path('app/Jobs/X.php')."\0\x07 done"
        ));

        $video->refresh();
        $this->assertStringNotContainsString(base_path(), $video->error_detail);
        $this->assertStringContainsString('[storage]/app/private/hls_tmp/1/playlist.m3u8', $video->error_detail);
        $this->assertStringContainsString('[app]/app/Jobs/X.php', $video->error_detail);
        $this->assertStringNotContainsString("\0", $video->error_detail);
        $this->assertStringNotContainsString("\x07", $video->error_detail);
        $this->assertStringEndsWith(' done', $video->error_detail);
    }
}
