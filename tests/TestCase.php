<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\DB;

abstract class TestCase extends BaseTestCase
{
    /**
     * Register MySQL's SHA2() on SQLite so the generated column in the reports
     * migration works in tests. Runs before traits (RefreshDatabase) migrate.
     */
    protected function setUpTraits()
    {
        $connection = DB::connection();

        if ($connection->getDriverName() === 'sqlite') {
            $connection->getPdo()->sqliteCreateFunction(
                'SHA2',
                fn ($value, $bits) => $value === null ? null : hash('sha256', (string) $value),
                2,
                \PDO::SQLITE_DETERMINISTIC
            );
        }

        return parent::setUpTraits();
    }
}
