<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('video_status_logs', function (Blueprint $table) {
            $table->id();
            $table->foreignId('video_id')->index();
            $table->string('status');
            $table->string('stage')->nullable();
            $table->unsignedTinyInteger('progress');
            $table->timestamp('created_at')->useCurrent();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('video_status_logs');
    }
};
