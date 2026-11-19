<?php

namespace Tests\Concerns;

use App\Models\Setting;

trait ConfiguresR2
{
    /**
     * Store a complete R2 config in the database (R2 lives only there).
     */
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
