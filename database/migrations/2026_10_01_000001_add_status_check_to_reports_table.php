<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    public function up(): void
    {
        DB::statement("ALTER TABLE reports ADD CONSTRAINT chk_reports_status CHECK (status IN ('new', 'resolved'))");
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE reports DROP CHECK chk_reports_status');
    }
};
