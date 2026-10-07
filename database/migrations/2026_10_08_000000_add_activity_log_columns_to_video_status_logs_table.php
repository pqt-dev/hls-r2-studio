<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        $isMysql = DB::getDriverName() !== 'sqlite';

        // MySQL: the FK must be dropped while the column definition changes.
        // SQLite has no FK on this table (see the earlier FK migration).
        if ($isMysql) {
            Schema::table('video_status_logs', function (Blueprint $table) {
                $table->dropForeign(['video_id']);
            });
        }

        Schema::table('video_status_logs', function (Blueprint $table) {
            // Client-origin lines have no status/progress; upload-only lines have no video yet.
            $table->unsignedBigInteger('video_id')->nullable()->change();
            $table->string('status')->nullable()->change();
            $table->unsignedTinyInteger('progress')->nullable()->change();
        });

        Schema::table('video_status_logs', function (Blueprint $table) {
            $table->string('upload_id', 36)->nullable()->index();
            $table->string('level', 10)->default('info');
            $table->string('message', 500)->nullable();
            $table->index('created_at');
        });

        if ($isMysql) {
            Schema::table('video_status_logs', function (Blueprint $table) {
                $table->foreign('video_id')->references('id')->on('videos')->cascadeOnDelete();
            });
        }
    }

    public function down(): void
    {
        $isMysql = DB::getDriverName() !== 'sqlite';

        // Rows that cannot satisfy the old NOT NULL columns are removed.
        DB::table('video_status_logs')
            ->where(fn ($query) => $query->whereNull('video_id')->orWhereNull('status')->orWhereNull('progress'))
            ->delete();

        if ($isMysql) {
            Schema::table('video_status_logs', function (Blueprint $table) {
                $table->dropForeign(['video_id']);
            });
        }

        Schema::table('video_status_logs', function (Blueprint $table) {
            $table->dropIndex(['created_at']);
            $table->dropIndex(['upload_id']);
        });

        Schema::table('video_status_logs', function (Blueprint $table) {
            $table->dropColumn(['upload_id', 'level', 'message']);
        });

        Schema::table('video_status_logs', function (Blueprint $table) {
            $table->unsignedBigInteger('video_id')->nullable(false)->change();
            $table->string('status')->nullable(false)->change();
            $table->unsignedTinyInteger('progress')->nullable(false)->change();
        });

        if ($isMysql) {
            Schema::table('video_status_logs', function (Blueprint $table) {
                $table->foreign('video_id')->references('id')->on('videos')->cascadeOnDelete();
            });
        }
    }
};
