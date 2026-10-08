<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\Facades\Route;
use Tests\TestCase;

class UploadRateLimitTest extends TestCase
{
    use RefreshDatabase;

    private const FAKE_UPLOAD_ID = '11111111-1111-1111-1111-111111111111';

    private function limitFor(string $name, User $user): object
    {
        $request = Request::create('/');
        $request->setUserResolver(fn () => $user);

        return RateLimiter::limiter($name)($request);
    }

    public function test_routes_use_the_named_limiters(): void
    {
        $expected = [
            'uploads.init' => 'throttle:upload-init',
            'uploads.chunk' => 'throttle:upload-chunk',
            'activity-log.store' => 'throttle:activity-log',
        ];

        foreach ($expected as $routeName => $middleware) {
            $this->assertContains($middleware, Route::getRoutes()->getByName($routeName)->middleware(), $routeName);
        }

        $this->assertEmpty(preg_grep('/^throttle:/', Route::getRoutes()->getByName('uploads.complete')->middleware()));
        $this->assertEmpty(preg_grep('/^throttle:/', Route::getRoutes()->getByName('activity-log.index')->middleware()));
    }

    public function test_limiters_use_separate_keys_and_configured_limits(): void
    {
        $user = User::factory()->create(['username' => 'tester']);

        $init = $this->limitFor('upload-init', $user);
        $chunk = $this->limitFor('upload-chunk', $user);
        $activity = $this->limitFor('activity-log', $user);

        $this->assertSame(30, $init->maxAttempts);
        $this->assertSame(900, $chunk->maxAttempts);
        $this->assertSame(120, $activity->maxAttempts);
        $this->assertCount(3, array_unique([$init->key, $chunk->key, $activity->key]));
    }

    public function test_limits_follow_the_config(): void
    {
        config(['videos.upload_rate_limits.chunk' => 7]);

        $this->assertSame(7, $this->limitFor('upload-chunk', User::factory()->create(['username' => 'tester']))->maxAttempts);
    }

    public function test_chunk_requests_do_not_consume_the_init_budget(): void
    {
        config(['videos.upload_rate_limits.init' => 2, 'videos.upload_rate_limits.chunk' => 3]);
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        for ($i = 0; $i < 3; $i++) {
            $this->assertNotSame(429, $this->postJson('/uploads/'.self::FAKE_UPLOAD_ID.'/chunk')->status());
        }

        $this->postJson('/uploads/'.self::FAKE_UPLOAD_ID.'/chunk')->assertStatus(429)->assertHeader('Retry-After');

        $payload = ['filename' => 'a.mp4', 'total_size' => 1000];
        $this->postJson('/uploads/init', $payload)->assertOk();
        $this->postJson('/uploads/init', $payload)->assertOk();
        $this->postJson('/uploads/init', $payload)
            ->assertStatus(429)
            ->assertHeader('Retry-After');
    }
}
