<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        if (! Schema::hasColumn('reports', 'reporter_ip')) {
            return;
        }

        Schema::table('reports', function (Blueprint $table) {
            $table->dropColumn('reporter_ip');
        });
    }

    public function down(): void
    {
        if (Schema::hasColumn('reports', 'reporter_ip')) {
            return;
        }

        Schema::table('reports', function (Blueprint $table) {
            $table->string('reporter_ip', 45)->nullable()->after('note');
        });
    }
};
