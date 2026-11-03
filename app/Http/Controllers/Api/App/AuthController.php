<?php

namespace App\Http\Controllers\Api\App;

use App\Http\Controllers\Controller;
use App\Models\User;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Auth;
use Illuminate\Support\Facades\Hash;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

class AuthController extends Controller
{
    /**
     * Exchange the site credentials for a revocable API token (no session is created).
     */
    public function login(Request $request): JsonResponse
    {
        $validated = $request->validate([
            'username' => ['required', 'string'],
            'password' => ['required', 'string'],
            'device_name' => ['required', 'string', 'max:100'],
        ]);

        $provider = Auth::guard('web')->getProvider();
        $user = $provider->retrieveByCredentials(['username' => $validated['username']]);

        if ($user instanceof User) {
            $valid = $provider->validateCredentials($user, ['password' => $validated['password']]);
        } else {
            // Unknown username: do equivalent hashing work so the response time does not reveal it.
            Hash::make($validated['password']);
            $valid = false;
        }

        if (! $valid) {
            Log::warning('Failed app login attempt', [
                'ip' => $request->ip(),
            ]);

            // One generic message for both cases, so usernames cannot be enumerated.
            throw ValidationException::withMessages([
                'username' => 'Incorrect username or password.',
            ]);
        }

        $token = $user->createToken(
            $validated['device_name'],
            ['*'],
            now()->addMinutes((int) config('sanctum.expiration')),
        );

        return response()->json([
            'token' => $token->plainTextToken,
            'user' => ['username' => $user->username],
        ]);
    }

    /**
     * Revoke only the token used for this request.
     */
    public function logout(Request $request): JsonResponse
    {
        $request->user()->currentAccessToken()->delete();

        return response()->json(null, 204);
    }
}
