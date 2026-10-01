<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('reports', function (Blueprint $table) {
            $table->foreignId('video_id')->nullable()->after('page_url')->index();
            $table->foreignId('resolved_by')->nullable()->after('resolved_at')->index();
        });
    }

    public function down(): void
    {
        Schema::table('reports', function (Blueprint $table) {
            $table->dropColumn(['video_id', 'resolved_by']);
        });
    }
};
