<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('settings', function (Blueprint $table) {
            $table->boolean('delete_from_r2_on_destroy')->default(true);
            $table->string('transcode_resolution')->default('720');
            $table->unsignedTinyInteger('transcode_segment_seconds')->default(6);
            $table->unsignedTinyInteger('transcode_fps')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('settings', function (Blueprint $table) {
            $table->dropColumn([
                'delete_from_r2_on_destroy',
                'transcode_resolution',
                'transcode_segment_seconds',
                'transcode_fps',
            ]);
        });
    }
};
