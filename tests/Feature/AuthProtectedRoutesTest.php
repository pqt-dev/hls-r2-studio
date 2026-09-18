<?php

namespace Tests\Feature;

use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;

class AuthProtectedRoutesTest extends TestCase
{
    use RefreshDatabase;

    /**
     * Every route registered under the `auth` middleware group in
     * routes/web.php. Each entry is [method, uri, data] where `uri` may
     * contain placeholders that are safe/valid so the request reaches the
     * `auth` middleware instead of being rejected earlier (e.g. by a route
     * `where()` constraint).
     */
    public static function authRoutesProvider(): array
    {
        return [
            'logout' => ['post', '/logout', []],
            'dashboard.overview' => ['get', '/', []],
            'videos.index' => ['get', '/videos', []],
            'videos.create' => ['get', '/upload', []],
            'videos.bulk-destroy' => ['delete', '/videos/bulk-destroy', ['ids' => [1]]],
            'videos.destroy' => ['delete', '/videos/1', []],
            'logs.index' => ['get', '/logs', []],
            'uploads.init' => ['post', '/uploads/init', ['filename' => 'test.mp4', 'total_size' => 1024]],
            'uploads.chunk' => ['post', '/uploads/11111111-1111-1111-1111-111111111111/chunk', []],
            'uploads.complete' => ['post', '/uploads/11111111-1111-1111-1111-111111111111/complete', []],
            'settings.edit' => ['get', '/settings', []],
            'settings.r2' => ['put', '/settings/r2', []],
            'settings.transcode' => ['put', '/settings/transcode', []],
            'settings.display' => ['put', '/settings/display', []],
            'settings.password' => ['put', '/settings/password', []],
            'reports.index' => ['get', '/reports', []],
            'reports.resolve' => ['put', '/reports/1/resolve', []],
        ];
    }

    #[DataProvider('authRoutesProvider')]
    public function test_guest_is_redirected_to_login(string $method, string $uri, array $data): void
    {
        $response = $this->{$method}($uri, $data);

        $response->assertRedirect(route('login'));
    }

    public function test_authenticated_user_can_access_videos_index(): void
    {
        $this->actingAs(User::factory()->create(['username' => 'tester']));

        $response = $this->get('/videos');

        $response->assertOk();
    }
}
