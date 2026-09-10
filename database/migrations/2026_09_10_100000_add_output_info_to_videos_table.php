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
        Schema::table('videos', function (Blueprint $table) {
            $table->unsignedSmallInteger('output_width')->nullable();
            $table->unsignedSmallInteger('output_height')->nullable();
            $table->decimal('output_fps', 5, 2)->nullable();
            $table->unsignedInteger('output_bitrate_kbps')->nullable();
            $table->string('output_codec', 20)->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('videos', function (Blueprint $table) {
            $table->dropColumn([
                'output_width',
                'output_height',
                'output_fps',
                'output_bitrate_kbps',
                'output_codec',
            ]);
        });
    }
};
