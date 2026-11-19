<?php

namespace App\Http\Controllers\Api\App;

use App\Http\Controllers\Controller;
use App\Models\Setting;
use App\Services\R2SettingsService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;

class R2Controller extends Controller
{
    private const FIELD_MAP = [
        'endpoint' => 'r2_endpoint',
        'bucket' => 'r2_bucket',
        'url' => 'r2_url',
        'access_key_id' => 'r2_access_key_id',
        'secret_access_key' => 'r2_secret_access_key',
    ];

    public function show(): JsonResponse
    {
        return $this->state(Setting::current());
    }

    public function update(Request $request, R2SettingsService $r2): JsonResponse
    {
        $input = [];
        foreach (self::FIELD_MAP as $field => $column) {
            if ($request->has($field)) {
                $input[$column] = $request->input($field);
            }
        }

        try {
            $settings = $r2->update($input);
        } catch (ValidationException $e) {
            // Report errors under the app field names instead of the column names.
            $flip = array_flip(self::FIELD_MAP);
            $errors = [];
            foreach ($e->errors() as $key => $messages) {
                $field = $flip[$key] ?? $key;
                $errors[$field] = array_map(fn ($m) => str_replace(str_replace('_', ' ', $key), str_replace('_', ' ', $field), $m), $messages);
            }

            throw ValidationException::withMessages($errors);
        }

        return $this->state($settings);
    }

    public function test(R2SettingsService $r2): JsonResponse
    {
        if ($r2->testConnection()) {
            return response()->json(['ok' => true]);
        }

        return response()->json([
            'ok' => false,
            'error' => 'R2 connection test failed. Check the access key, secret, bucket and endpoint.',
        ]);
    }

    private function state(Setting $settings): JsonResponse
    {
        $configured = $settings->hasR2Config();
        $blank = fn ($v) => is_string($v) && trim($v) !== '' ? $v : null;

        return response()->json([
            'configured' => $configured,
            'source' => $configured ? 'database' : 'none',
            'endpoint' => $blank($settings->r2_endpoint),
            'bucket' => $blank($settings->r2_bucket),
            'url' => $blank($settings->r2_url),
            'access_key_last4' => $settings->r2AccessKeyLast4(),
            'has_secret' => $settings->hasR2Secret(),
        ]);
    }
}
