<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /**
     * Run the migrations.
     */
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->string('username')->nullable()->after('name');
        });

        DB::table('users')->get()->each(fn ($u) => DB::table('users')->where('id', $u->id)->update(['username' => $u->email]));

        Schema::table('users', function (Blueprint $table) {
            $table->string('username')->nullable(false)->unique()->change();
            $table->string('email')->nullable()->change();
        });

        DB::table('users')->update(['email' => null]);
    }

    /**
     * Reverse the migrations.
     */
    public function down(): void
    {
        // The original email values were overwritten in up() and are not
        // recoverable. Before re-applying the NOT NULL constraint, fill any
        // NULL email with a placeholder derived from the row's id so the
        // unique, non-null constraint below does not fail.
        DB::table('users')->whereNull('email')->get()->each(
            fn ($u) => DB::table('users')->where('id', $u->id)->update(['email' => "user-{$u->id}@placeholder.invalid"])
        );

        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['username']);
            $table->dropColumn('username');
            $table->string('email')->nullable(false)->change();
        });
    }
};
