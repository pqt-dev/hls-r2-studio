<?php

namespace Tests\Concerns;

use App\Models\Setting;
use App\Models\User;
use Illuminate\Testing\TestResponse;

trait InteractsWithAppApi
{
    protected function makeUser(string $username = 'admin', string $password = 'correct-horse'): User
    {
        return User::factory()->create(['username' => $username, 'password' => $password]);
    }

    /**
     * Send a JSON request with a bearer token. A test keeps one application instance, so the guards are reset
     * before and after: otherwise the Sanctum guard would reuse the user of the previous request and the
     * default guard would stay on "sanctum" for later web requests.
     */
    protected function apiAs(?string $token, string $method, string $uri, array $data = []): TestResponse
    {
        $this->resetAuthGuards();

        $request = $token === null ? $this : $this->withToken($token);
        $response = $request->json($method, $uri, $data);

        $this->resetAuthGuards();
        $this->flushHeaders();

        return $response;
    }

    protected function resetAuthGuards(): void
    {
        $this->app['auth']->forgetGuards();
        $this->app['auth']->shouldUse('web');
    }

    protected function tokenFor(User $user, string $name = 'Test PC'): string
    {
        return $user->createToken($name)->plainTextToken;
    }

    protected function assertNoStore(TestResponse $response): void
    {
        $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
    }

    protected function configureR2(): void
    {
        Setting::current()->update([
            'r2_access_key_id' => 'AKIDEXAMPLE1234',
            'r2_secret_access_key' => 'super-secret-value',
            'r2_bucket' => 'my-bucket',
            'r2_endpoint' => 'https://acc.r2.cloudflarestorage.com',
            'r2_url' => 'https://cdn.example.com',
        ]);
    }
}
