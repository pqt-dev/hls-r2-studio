<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (Schema::hasTable('report_submissions')) {
            return;
        }

        Schema::create('report_submissions', function (Blueprint $table) {
            $table->id();
            $table->foreignId('report_id')->constrained()->cascadeOnDelete();
            $table->string('ip', 45);
            $table->string('isp', 100)->default('Unknown');
            $table->string('reason')->nullable();
            $table->timestamps();

            $table->index(['report_id', 'isp']);
        });

        DB::statement("ALTER TABLE report_submissions ADD CONSTRAINT chk_report_submissions_reason CHECK (reason IS NULL OR reason IN ('not_loading', 'not_playing', 'lag', 'wrong_video', 'other'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('report_submissions');
    }
};
