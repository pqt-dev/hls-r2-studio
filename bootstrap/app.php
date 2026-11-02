<?php

use App\Http\Middleware\AddRobotsTag;
use App\Http\Middleware\MergeEmbedAllowlistIntoCors;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Symfony\Component\HttpKernel\Exception\NotFoundHttpException;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__.'/../routes/web.php',
        api: __DIR__.'/../routes/api.php',
        commands: __DIR__.'/../routes/console.php',
        health: '/up',
    )
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->trustProxies(headers: Request::HEADER_X_FORWARDED_FOR | Request::HEADER_X_FORWARDED_HOST | Request::HEADER_X_FORWARDED_PORT | Request::HEADER_X_FORWARDED_PROTO | Request::HEADER_X_FORWARDED_AWS_ELB);
        // Must run before the global HandleCors middleware reads config('cors').
        $middleware->prepend(MergeEmbedAllowlistIntoCors::class);
        // The login URL is secret, so guests are never redirected to it (see the AuthenticationException mapping below).
        $middleware->redirectGuestsTo(fn () => null);
        $middleware->authenticateSessions();
        $middleware->append(AddRobotsTag::class);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        // Unauthenticated web requests get a plain 404 instead of a redirect to the (secret) login page.
        // API and JSON requests keep the default 401 response.
        $exceptions->map(function (AuthenticationException $e) {
            $request = request();

            return $request->is('api/*') || $request->expectsJson() ? $e : new NotFoundHttpException;
        });
        $exceptions->shouldRenderJsonWhen(
            fn (Request $request) => $request->is('api/*') || $request->expectsJson(),
        );
    })->create();
