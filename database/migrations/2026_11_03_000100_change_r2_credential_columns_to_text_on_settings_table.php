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
        // Encrypted values are much longer than 255 characters.
        Schema::table('settings', function (Blueprint $table) {
            $table->text('r2_access_key_id')->nullable()->change();
            $table->text('r2_secret_access_key')->nullable()->change();
        });
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        Schema::table('settings', function (Blueprint $table) {
            $table->string('r2_access_key_id')->nullable()->change();
            $table->text('r2_secret_access_key')->nullable()->change();
        });
    }
};
