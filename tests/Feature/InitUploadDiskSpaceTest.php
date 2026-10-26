<?php

namespace Tests\Feature;

use App\Http\Controllers\VideoController;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class InitUploadDiskSpaceTest extends TestCase
{
    use RefreshDatabase;

    private const MARGIN = 256 * 1024 * 1024;

    protected function setUp(): void
    {
        parent::setUp();

        Storage::fake('local');

        $this->actingAs(User::factory()->create(['username' => 'tester']));
    }

    private function fakeFreeSpace(float|false $free): void
    {
        $this->app->bind(VideoController::class, fn () => new class($free) extends VideoController
        {
            public function __construct(private float|false $free) {}

            protected function freeDiskSpace(string $path): float|false
            {
                return $this->free;
            }
        });
    }

    private function init(int $totalSize)
    {
        return $this->postJson('/uploads/init', [
            'filename' => 'movie.mp4',
            'total_size' => $totalSize,
        ]);
    }

    public function test_it_refuses_the_upload_when_free_space_is_below_twice_the_size_plus_margin(): void
    {
        $this->fakeFreeSpace((float) (2 * 1000 + self::MARGIN - 1));

        $this->init(1000)
            ->assertStatus(507)
            ->assertJson(['message' => 'The server does not have enough free disk space to process this upload.']);

        $this->assertSame([], Storage::disk('local')->directories('chunked_uploads'));
    }

    public function test_it_accepts_the_upload_when_there_is_enough_free_space(): void
    {
        $this->fakeFreeSpace((float) (2 * 1000 + self::MARGIN));

        $response = $this->init(1000)->assertOk();

        $this->assertTrue(Storage::disk('local')->exists("chunked_uploads/{$response->json('upload_id')}/meta.json"));
    }

    public function test_it_accepts_the_upload_when_the_free_space_is_unknown(): void
    {
        $this->fakeFreeSpace(false);

        $this->init(1000)->assertOk()->assertJsonStructure(['upload_id']);
    }
}
