<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('videos', function (Blueprint $table) {
            $table->string('public_id', 32)->nullable()->after('id');
        });

        // Existing videos keep their numeric id as the public id so old embed URLs stay valid.
        DB::table('videos')->whereNull('public_id')->orderBy('id')->chunkById(500, function ($videos) {
            foreach ($videos as $video) {
                DB::table('videos')->where('id', $video->id)->update(['public_id' => (string) $video->id]);
            }
        });

        Schema::table('videos', function (Blueprint $table) {
            $table->string('public_id', 32)->nullable(false)->change();
            $table->unique('public_id');
        });
    }

    public function down(): void
    {
        Schema::table('videos', function (Blueprint $table) {
            $table->dropUnique(['public_id']);
            $table->dropColumn('public_id');
        });
    }
};
