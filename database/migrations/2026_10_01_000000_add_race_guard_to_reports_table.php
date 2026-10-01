<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('reports', function (Blueprint $table) {
            $table->string('page_url', 2048)->change();
        });

        // Merge any pre-existing duplicate "new" reports for the same page_url
        // before the unique index below makes that state impossible to create.
        DB::table('reports')
            ->where('status', 'new')
            ->select('page_url')
            ->groupBy('page_url')
            ->havingRaw('COUNT(*) > 1')
            ->pluck('page_url')
            ->each(function (string $pageUrl) {
                $duplicates = DB::table('reports')
                    ->where('page_url', $pageUrl)
                    ->where('status', 'new')
                    ->orderByDesc('last_reported_at')
                    ->orderByDesc('id')
                    ->get();

                $keeper = $duplicates->first();
                $totalReportCount = $duplicates->sum('report_count');

                DB::table('reports')->where('id', $keeper->id)->update([
                    'report_count' => $totalReportCount,
                ]);

                DB::table('reports')
                    ->where('page_url', $pageUrl)
                    ->where('status', 'new')
                    ->where('id', '!=', $keeper->id)
                    ->delete();
            });

        Schema::table('reports', function (Blueprint $table) {
            $table->string('active_report_key', 64)->nullable()
                ->storedAs("CASE WHEN status = 'new' THEN SHA2(page_url, 256) ELSE NULL END")
                ->after('page_url');
            $table->unique('active_report_key');
        });
    }

    public function down(): void
    {
        Schema::table('reports', function (Blueprint $table) {
            $table->dropUnique(['active_report_key']);
            $table->dropColumn('active_report_key');
        });

        Schema::table('reports', function (Blueprint $table) {
            $table->string('page_url', 255)->change();
        });
    }
};
