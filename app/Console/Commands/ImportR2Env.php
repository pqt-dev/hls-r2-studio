<?php

namespace App\Console\Commands;

use App\Models\Setting;
use Illuminate\Console\Command;

class ImportR2Env extends Command
{
    /**
     * The name and signature of the console command.
     *
     * @var string
     */
    protected $signature = 'r2:import-env';

    /**
     * The console command description.
     *
     * @var string
     */
    protected $description = 'Copy the R2 config from .env into the database for fields that are still empty';

    /**
     * Setting column => key in config('filesystems.disks.r2').
     */
    private const FIELDS = [
        'r2_access_key_id' => 'key',
        'r2_secret_access_key' => 'secret',
        'r2_bucket' => 'bucket',
        'r2_endpoint' => 'endpoint',
        'r2_url' => 'url',
    ];

    /**
     * Execute the console command.
     */
    public function handle(): int
    {
        $env = config('filesystems.disks.r2');
        $settings = Setting::current();
        $updates = [];
        $missing = [];

        foreach (self::FIELDS as $column => $key) {
            try {
                $current = $settings->{$column};
            } catch (\Throwable) {
                $current = null; // Undecryptable value counts as empty.
            }

            if (is_string($current) && trim($current) !== '') {
                continue;
            }

            if (is_string($env[$key] ?? null) && trim($env[$key]) !== '') {
                $updates[$column] = trim($env[$key]);
            } else {
                $missing[] = $column;
            }
        }

        if ($updates === [] && $missing === []) {
            $this->info('The database already has all R2 fields. Nothing to import.');

            return self::SUCCESS;
        }

        if ($missing !== []) {
            $this->warn('The R2 config in .env is incomplete (missing: '.implode(', ', $missing).'). Nothing was imported.');

            return self::SUCCESS;
        }

        $settings->update($updates);

        $this->info('Imported R2 fields: '.implode(', ', array_keys($updates)));

        return self::SUCCESS;
    }
}
