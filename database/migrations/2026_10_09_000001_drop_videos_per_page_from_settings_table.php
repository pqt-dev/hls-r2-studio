<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('settings', 'videos_per_page')) {
            return;
        }

        Schema::table('settings', function (Blueprint $table) {
            $table->dropColumn('videos_per_page');
        });
    }

    public function down(): void
    {
        if (Schema::hasColumn('settings', 'videos_per_page')) {
            return;
        }

        Schema::table('settings', function (Blueprint $table) {
            $table->unsignedSmallInteger('videos_per_page')->default(24);
        });
    }
};
