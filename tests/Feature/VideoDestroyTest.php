<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class VideoDestroyTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function makeVideo(string $status, ?string $diskPrefix = null): Video
    {
        return Video::create([
            'title' => 'video',
            'original_filename' => 'video.mp4',
            'status' => $status,
            'disk_prefix' => $diskPrefix,
        ]);
    }

    public function test_it_blocks_deleting_pending_and_processing_videos(): void
    {
        foreach (['pending', 'processing'] as $status) {
            $video = $this->makeVideo($status);

            $response = $this->delete("/videos/{$video->id}");

            $response->assertRedirect(route('videos.index'));
            $response->assertSessionHas('error', 'This video is still being processed and cannot be deleted yet.');
            $this->assertNotNull(Video::find($video->id));
        }
    }

    public function test_it_deletes_ready_and_failed_videos(): void
    {
        foreach (['ready', 'failed'] as $status) {
            $video = $this->makeVideo($status);

            $this->delete("/videos/{$video->id}")->assertSessionHas('success');
            $this->assertNull(Video::find($video->id));
        }
    }

    public function test_it_keeps_the_record_when_r2_deletion_fails(): void
    {
        config()->set('filesystems.disks.r2', [
            'driver' => 's3',
            'key' => 'test-key',
            'secret' => 'test-secret',
            'region' => 'auto',
            'bucket' => 'test-bucket',
            'endpoint' => 'http://127.0.0.1:1',
            'url' => 'http://127.0.0.1:1',
            'use_path_style_endpoint' => true,
        ]);

        $video = $this->makeVideo('ready', '2026/09/17/video-1/');

        $response = $this->delete("/videos/{$video->id}");

        $response->assertRedirect(route('videos.index'));
        $response->assertSessionHas('error', 'Could not delete the files on R2; the video was kept so you can retry.');
        $this->assertSame('2026/09/17/video-1/', Video::find($video->id)->disk_prefix);
    }
}
