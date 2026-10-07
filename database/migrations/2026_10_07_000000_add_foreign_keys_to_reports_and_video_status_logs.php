<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        // SQLite cannot add a foreign key to an existing table; this is a safe
        // no-op there (only the test database uses SQLite).
        if (DB::getDriverName() === 'sqlite') {
            return;
        }

        // Clean orphans first, otherwise adding the constraints would fail.
        DB::table('reports')
            ->whereNotNull('video_id')
            ->whereNotIn('video_id', DB::table('videos')->select('id'))
            ->update(['video_id' => null]);

        DB::table('reports')
            ->whereNotNull('resolved_by')
            ->whereNotIn('resolved_by', DB::table('users')->select('id'))
            ->update(['resolved_by' => null]);

        DB::table('video_status_logs')
            ->whereNotIn('video_id', DB::table('videos')->select('id'))
            ->delete();

        Schema::table('reports', function (Blueprint $table) {
            $table->foreign('video_id')->references('id')->on('videos')->nullOnDelete();
            $table->foreign('resolved_by')->references('id')->on('users')->nullOnDelete();
        });

        Schema::table('video_status_logs', function (Blueprint $table) {
            $table->foreign('video_id')->references('id')->on('videos')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'sqlite') {
            return;
        }

        Schema::table('video_status_logs', function (Blueprint $table) {
            $table->dropForeign(['video_id']);
        });

        Schema::table('reports', function (Blueprint $table) {
            $table->dropForeign(['video_id']);
            $table->dropForeign(['resolved_by']);
        });
    }
};
