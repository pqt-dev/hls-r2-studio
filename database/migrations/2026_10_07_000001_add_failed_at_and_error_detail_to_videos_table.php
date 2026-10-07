<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('videos', function (Blueprint $table) {
            $table->timestamp('failed_at')->nullable();
            $table->text('error_detail')->nullable();
        });

        // Existing failures have no recorded failure time; the last update is
        // the closest available approximation.
        DB::table('videos')
            ->where('status', 'failed')
            ->whereNull('failed_at')
            ->update(['failed_at' => DB::raw('updated_at')]);
    }

    public function down(): void
    {
        Schema::table('videos', function (Blueprint $table) {
            $table->dropColumn(['failed_at', 'error_detail']);
        });
    }
};
