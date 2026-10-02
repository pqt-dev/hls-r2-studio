<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('reports', function (Blueprint $table) {
            $table->string('reason')->nullable()->after('page_url');
        });

        DB::statement("ALTER TABLE reports ADD CONSTRAINT chk_reports_reason CHECK (reason IS NULL OR reason IN ('not_playing', 'lag', 'no_audio', 'wrong_video', 'other'))");
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE reports DROP CHECK chk_reports_reason');

        Schema::table('reports', function (Blueprint $table) {
            $table->dropColumn('reason');
        });
    }
};
