<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class VideoCustomImageTest extends TestCase
{
    use RefreshDatabase;

    private const PREFIX = '2026/09/09/my-video-12/';

    private $disk;

    protected function setUp(): void
    {
        parent::setUp();

        // Setting::r2Disk() builds its disk with Storage::build(), which
        // Storage::fake() cannot intercept, so hand back a fake disk instead.
        $this->disk = Storage::fake('r2-fake');
        Storage::partialMock()->shouldReceive('build')->andReturn($this->disk);

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function makeVideo(?string $prefix = self::PREFIX, ?string $customPath = null): Video
    {
        return Video::create([
            'title' => 'My video',
            'original_filename' => 'my-video.mp4',
            'status' => 'ready',
            'disk_prefix' => $prefix,
            'custom_image_path' => $customPath,
        ]);
    }

    public function test_it_stores_the_image_under_the_video_prefix_and_sets_the_column(): void
    {
        $video = $this->makeVideo();

        $response = $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('cover.jpeg', 100, 100),
        ]);

        $path = $video->fresh()->custom_image_path;

        $response->assertOk()->assertJson(['label' => 'Custom image', 'url' => $this->disk->url($path).'?v='.$video->fresh()->updated_at->timestamp]);
        $this->assertSame(self::PREFIX.'custom-my-video-12.jpg', $path);
        $this->disk->assertExists($path);
    }

    public function test_replacing_with_the_same_extension_overwrites_the_same_key(): void
    {
        $path = self::PREFIX.'custom-my-video-12.png';
        $this->disk->put($path, 'old');
        $video = $this->makeVideo(self::PREFIX, $path);

        $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('new.png', 100, 100),
        ])->assertOk();

        $this->assertSame($path, $video->fresh()->custom_image_path);
        $this->disk->assertExists($path);
        $this->assertNotSame('old', $this->disk->get($path));
        $this->assertSame([$path], $this->disk->allFiles());
    }

    public function test_replacing_with_the_same_extension_changes_the_cache_busting_version(): void
    {
        $path = self::PREFIX.'custom-my-video-12.png';
        $this->disk->put($path, 'old');
        $video = $this->makeVideo(self::PREFIX, $path);

        $this->travelTo(now()->addMinute());
        $first = $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('a.png', 100, 100),
        ])->assertOk()->json('url');

        $this->travelTo(now()->addMinutes(5));
        $second = $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('b.png', 100, 100),
        ])->assertOk()->json('url');

        $this->assertSame($this->disk->url($path).'?v='.now()->subMinutes(5)->timestamp, $first);
        $this->assertSame($this->disk->url($path).'?v='.now()->timestamp, $second);
        $this->assertNotSame($first, $second);
        $this->assertSame($path, $video->fresh()->custom_image_path);
        $this->assertStringNotContainsString('?', $video->fresh()->custom_image_path);
    }

    public function test_replacing_with_a_different_extension_deletes_the_old_object(): void
    {
        $oldPath = self::PREFIX.'custom-my-video-12.png';
        $this->disk->put($oldPath, 'old');
        $video = $this->makeVideo(self::PREFIX, $oldPath);

        $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('new.webp', 100, 100),
        ])->assertOk();

        $newPath = $video->fresh()->custom_image_path;

        $this->assertSame(self::PREFIX.'custom-my-video-12.webp', $newPath);
        $this->disk->assertExists($newPath);
        $this->disk->assertMissing($oldPath);
    }

    public function test_a_failed_column_update_removes_the_new_object_and_keeps_the_old_one(): void
    {
        $oldPath = self::PREFIX.'custom-my-video-12.png';
        $this->disk->put($oldPath, 'old');
        $video = $this->makeVideo(self::PREFIX, $oldPath);

        Video::updating(function () {
            throw new \RuntimeException('Simulated DB failure.');
        });

        $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('new.webp', 100, 100),
        ])->assertStatus(500)->assertJsonStructure(['message']);

        $this->assertSame($oldPath, $video->fresh()->custom_image_path);
        $this->disk->assertExists($oldPath);
        $this->assertSame([$oldPath], $this->disk->allFiles());
    }

    public function test_it_rejects_non_image_files(): void
    {
        $video = $this->makeVideo();

        $svg = UploadedFile::fake()->createWithContent('x.svg', '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
        $pdf = UploadedFile::fake()->createWithContent('x.pdf', "%PDF-1.4\n%%EOF");

        foreach ([$svg, $pdf] as $file) {
            $this->postJson(route('videos.image.store', $video), ['image' => $file])
                ->assertStatus(422)
                ->assertJsonValidationErrors('image');
        }

        $this->assertNull($video->fresh()->custom_image_path);
    }

    public function test_it_rejects_a_file_with_an_image_extension_but_non_image_content(): void
    {
        $video = $this->makeVideo();

        // A real file on disk, so the MIME is detected from content (the
        // fake() helper would guess it from the extension instead).
        $tmp = tempnam(sys_get_temp_dir(), 'img');
        file_put_contents($tmp, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

        $this->postJson(route('videos.image.store', $video), [
            'image' => new UploadedFile($tmp, 'fake.png', null, null, true),
        ])->assertStatus(422)->assertJsonValidationErrors('image');

        @unlink($tmp);
    }

    public function test_it_rejects_files_larger_than_5mb(): void
    {
        $video = $this->makeVideo();

        $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('big.jpg')->size(5121),
        ])->assertStatus(422)->assertJsonValidationErrors('image');

        $this->assertNull($video->fresh()->custom_image_path);
    }

    public function test_it_rejects_a_video_without_a_disk_prefix(): void
    {
        $video = $this->makeVideo(null);

        $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('cover.jpg', 100, 100),
        ])->assertStatus(422)->assertJsonStructure(['message']);

        $this->assertNull($video->fresh()->custom_image_path);
    }

    public function test_destroy_clears_the_column_and_deletes_the_object(): void
    {
        $path = self::PREFIX.'custom-ABCDEFGH.webp';
        $this->disk->put($path, 'img');
        $video = $this->makeVideo(self::PREFIX, $path);

        $this->deleteJson(route('videos.image.destroy', $video))
            ->assertOk()
            ->assertJson(['ok' => true]);

        $this->assertNull($video->fresh()->custom_image_path);
        $this->disk->assertMissing($path);
    }

    public function test_destroy_returns_404_when_there_is_no_custom_image(): void
    {
        $video = $this->makeVideo();

        $this->deleteJson(route('videos.image.destroy', $video))->assertNotFound();
    }

    public function test_guests_cannot_upload_or_delete(): void
    {
        $video = $this->makeVideo();
        $this->app['auth']->forgetGuards();

        $this->postJson(route('videos.image.store', $video), [
            'image' => UploadedFile::fake()->image('cover.jpg', 100, 100),
        ])->assertUnauthorized();

        $this->deleteJson(route('videos.image.destroy', $video))->assertUnauthorized();
    }
}
