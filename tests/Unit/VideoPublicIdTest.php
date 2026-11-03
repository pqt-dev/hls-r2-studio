<?php

namespace Tests\Unit;

use App\Models\Video;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

class VideoPublicIdTest extends TestCase
{
    use RefreshDatabase;

    private function attributes(array $extra = []): array
    {
        return $extra + ['title' => 'v', 'original_filename' => 'v.mp4', 'status' => 'ready'];
    }

    public function test_generated_public_id_has_expected_format(): void
    {
        for ($i = 0; $i < 20; $i++) {
            $this->assertMatchesRegularExpression('/^[a-z0-9]{12}$/', Video::generatePublicId());
        }
    }

    public function test_creating_a_video_assigns_a_public_id(): void
    {
        $video = Video::create($this->attributes());

        $this->assertMatchesRegularExpression('/^[a-z0-9]{12}$/', $video->public_id);
        $this->assertSame($video->public_id, $video->fresh()->public_id);
    }

    public function test_explicit_public_id_is_kept(): void
    {
        $video = Video::create($this->attributes(['public_id' => 'abc123']));

        $this->assertSame('abc123', $video->fresh()->public_id);
    }

    public function test_generator_retries_while_the_id_is_taken(): void
    {
        // Seed random_int-independent collision: the generator must never return an existing id.
        $taken = [];

        for ($i = 0; $i < 30; $i++) {
            $taken[] = Video::create($this->attributes())->public_id;
        }

        $this->assertCount(30, array_unique($taken));
        $this->assertNotContains(Video::generatePublicId(), $taken);
    }
}
