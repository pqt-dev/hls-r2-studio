<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class EnsureAdminLoginKey
{
    /**
     * Only let the request through when the `{key}` URL segment equals the
     * configured admin login key. Otherwise respond with a plain 404 so the
     * existence of the login page is never revealed. An empty configured key
     * disables the login page entirely.
     */
    public function handle(Request $request, Closure $next): Response
    {
        $configuredKey = trim((string) config('auth.admin_login_key'));
        $givenKey = (string) $request->route('key');

        if ($configuredKey === '' || ! hash_equals($configuredKey, $givenKey)) {
            abort(404);
        }

        return $next($request);
    }
}
