<?php

namespace App\Services;

use App\Models\Setting;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

class R2SettingsService
{
    /**
     * Validate, trim and persist the R2 settings (keys are the r2_* column names).
     * Blank or omitted credentials keep the stored values.
     *
     * @param  array<string, mixed>  $input
     *
     * @throws ValidationException
     */
    public function update(array $input): Setting
    {
        $settings = Setting::current();
        $hasKey = $settings->r2AccessKeyLast4() !== null;
        $hasSecret = $settings->hasR2Secret();

        $input = array_map(
            fn ($value) => is_string($value) ? trim($value) : $value,
            array_intersect_key($input, array_flip(['r2_access_key_id', 'r2_secret_access_key', 'r2_bucket', 'r2_endpoint', 'r2_url'])),
        );

        $validated = Validator::make($input, [
            'r2_access_key_id' => [$hasKey ? 'nullable' : 'required', 'string', 'max:255'],
            'r2_secret_access_key' => [$hasSecret ? 'nullable' : 'required', 'string', 'max:1000'],
            'r2_bucket' => ['required', 'string', 'max:255'],
            'r2_endpoint' => ['required', 'url:https', 'max:255'],
            'r2_url' => ['required', 'url:https', 'max:255'],
        ])->validate();

        $attributes = [
            'r2_bucket' => $validated['r2_bucket'],
            'r2_endpoint' => $validated['r2_endpoint'],
            'r2_url' => rtrim($validated['r2_url'], '/'),
        ];

        // Blank credential inputs keep the stored values.
        foreach (['r2_access_key_id', 'r2_secret_access_key'] as $column) {
            if (($validated[$column] ?? '') !== '') {
                $attributes[$column] = $validated[$column];
            }
        }

        $settings->update($attributes);

        return $settings;
    }

    /**
     * Write and delete a probe object on the stored R2 config. Details are never surfaced:
     * SDK errors can echo endpoint or credential data.
     */
    public function testConnection(): bool
    {
        $key = '_connection-test/'.Str::random(16).'.txt';

        try {
            $disk = Setting::current()->r2Disk();

            if ($disk->put($key, 'ok') === false) {
                throw new \RuntimeException('Write failed.');
            }

            $disk->delete($key);
        } catch (\Throwable) {
            return false;
        }

        return true;
    }
}
