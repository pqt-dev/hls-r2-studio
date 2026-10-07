<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    private function isMySql(): bool
    {
        return in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);
    }

    public function up(): void
    {
        if (! $this->isMySql()) {
            return;
        }

        DB::statement('CREATE INDEX reports_page_url_prefix_index ON reports (page_url(191))');
    }

    public function down(): void
    {
        if (! $this->isMySql()) {
            return;
        }

        DB::statement('DROP INDEX reports_page_url_prefix_index ON reports');
    }
};
