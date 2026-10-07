<?php

namespace Tests\Feature;

use App\Models\User;
use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class VideoUpdateTest extends TestCase
{
    use RefreshDatabase;

    private function makeVideo(): Video
    {
        return Video::create([
            'title' => 'Old title',
            'original_filename' => 'video.mp4',
            'status' => 'ready',
        ]);
    }

    public function test_guest_is_redirected_to_login_and_title_is_unchanged(): void
    {
        $video = $this->makeVideo();

        $this->put("/videos/{$video->id}", ['title' => 'New title'])->assertRedirect(route('login'));

        $this->assertSame('Old title', $video->fresh()->title);
    }

    public function test_it_updates_the_title_and_redirects_with_flash(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
        $video = $this->makeVideo();

        $response = $this->put("/videos/{$video->id}", ['title' => 'New title']);

        $response->assertRedirect(route('videos.index'));
        $response->assertSessionHas('success', 'Video title has been updated.');
        $this->assertSame('New title', $video->fresh()->title);
    }

    public function test_title_is_required(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
        $video = $this->makeVideo();

        $this->put("/videos/{$video->id}", ['title' => ''])->assertSessionHasErrors('title');

        $this->assertSame('Old title', $video->fresh()->title);
    }

    public function test_title_may_not_exceed_255_characters(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));
        $video = $this->makeVideo();

        $this->put("/videos/{$video->id}", ['title' => str_repeat('a', 256)])->assertSessionHasErrors('title');
        $this->assertSame('Old title', $video->fresh()->title);

        $this->put("/videos/{$video->id}", ['title' => str_repeat('a', 255)])->assertSessionHasNoErrors();
        $this->assertSame(255, strlen($video->fresh()->title));
    }

    public function test_updating_a_missing_video_returns_404(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $this->put('/videos/999999', ['title' => 'x'])->assertNotFound();
    }
}
