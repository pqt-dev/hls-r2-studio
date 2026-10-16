<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

return new class extends Migration
{
    private function isMySql(): bool
    {
        return in_array(DB::connection()->getDriverName(), ['mysql', 'mariadb'], true);
    }

    private function constraintExists(): bool
    {
        if (! $this->isMySql()) {
            return str_contains((string) DB::table('sqlite_master')->where('name', 'reports')->value('sql'), 'chk_reports_reason');
        }

        return DB::table('information_schema.TABLE_CONSTRAINTS')
            ->where('CONSTRAINT_SCHEMA', DB::getDatabaseName())
            ->where('TABLE_NAME', 'reports')
            ->where('CONSTRAINT_NAME', 'chk_reports_reason')
            ->exists();
    }

    private function dropConstraint(): void
    {
        if (! $this->constraintExists()) {
            return;
        }

        // MySQL/MariaDB use DROP CHECK; SQLite (3.53+, used by the test database) uses DROP CONSTRAINT.
        DB::statement($this->isMySql()
            ? 'ALTER TABLE reports DROP CHECK chk_reports_reason'
            : 'ALTER TABLE reports DROP CONSTRAINT chk_reports_reason');
    }

    public function up(): void
    {
        // 'no_audio' was removed from the reason set; fold existing rows into 'other'.
        DB::table('reports')->where('reason', 'no_audio')->update(['reason' => 'other']);

        $this->dropConstraint();

        DB::statement("ALTER TABLE reports ADD CONSTRAINT chk_reports_reason CHECK (reason IS NULL OR reason IN ('not_loading', 'not_playing', 'lag', 'wrong_video', 'other'))");
    }

    public function down(): void
    {
        $this->dropConstraint();

        DB::statement("ALTER TABLE reports ADD CONSTRAINT chk_reports_reason CHECK (reason IS NULL OR reason IN ('not_playing', 'lag', 'no_audio', 'wrong_video', 'other'))");
    }
};
