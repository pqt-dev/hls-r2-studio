<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class VideoBulkDestroyTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function makeVideo(string $title, ?string $diskPrefix = null): Video
    {
        return Video::create([
            'title' => $title,
            'original_filename' => "{$title}.mp4",
            'status' => 'ready',
            'disk_prefix' => $diskPrefix,
        ]);
    }

    /**
     * Point the R2 disk at a closed local port so any deleteDirectory attempt
     * fails fast with a connection error instead of reaching a real bucket.
     */
    private function pointR2AtUnreachableEndpoint(): void
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
    }

    public function test_it_deletes_every_record_even_when_r2_cleanup_fails(): void
    {
        $this->pointR2AtUnreachableEndpoint();

        $first = $this->makeVideo('first', '2026/09/17/first/');
        $second = $this->makeVideo('second', '2026/09/17/second/');

        $response = $this->delete('/videos/bulk-destroy', [
            'selected_ids' => [$first->id, $second->id],
        ]);

        $response->assertRedirect(route('videos.index'));
        $response->assertSessionHas('status', 'Deleted 2 videos.');

        $this->assertSame(0, Video::count());
    }

    public function test_it_keeps_deleting_the_remaining_videos_when_one_fails(): void
    {
        Video::deleting(function (Video $video) {
            if ($video->title === 'broken') {
                throw new \RuntimeException('Simulated delete failure.');
            }
        });

        $first = $this->makeVideo('first');
        $broken = $this->makeVideo('broken');
        $last = $this->makeVideo('last');

        $response = $this->delete('/videos/bulk-destroy', [
            'selected_ids' => [$first->id, $broken->id, $last->id],
        ]);

        $response->assertRedirect(route('videos.index'));
        $response->assertSessionHas('status', 'Deleted 2 videos (1 failed — check logs).');

        $this->assertSame([$broken->id], Video::pluck('id')->all());
    }
}
