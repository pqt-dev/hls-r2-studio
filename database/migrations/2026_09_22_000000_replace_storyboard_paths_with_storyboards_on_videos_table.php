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
            $table->dropColumn([
                'storyboard_path',
                'storyboard_meta_path',
            ]);
        });

        Schema::table('videos', function (Blueprint $table) {
            // Shape: {"3x3": {"path": "...", "meta_path": "..."}, "4x4": {...}, "5x5": {...}}
            $table->json('storyboards')->nullable();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('videos', function (Blueprint $table) {
            $table->dropColumn('storyboards');
        });

        Schema::table('videos', function (Blueprint $table) {
            $table->string('storyboard_path')->nullable();
            $table->string('storyboard_meta_path')->nullable();
        });
    }
};
