<?php

namespace Tests\Feature;

use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Tests\TestCase;

class VideoPublicIdMigrationTest extends TestCase
{
    use RefreshDatabase;

    private function migration(): object
    {
        return require database_path('migrations/2026_11_03_000000_add_public_id_to_videos_table.php');
    }

    private function insertVideo(string $title): int
    {
        return DB::table('videos')->insertGetId([
            'title' => $title,
            'original_filename' => $title.'.mp4',
            'status' => 'ready',
            'created_at' => now(),
            'updated_at' => now(),
        ]);
    }

    public function test_up_backfills_existing_rows_with_their_numeric_id(): void
    {
        $migration = $this->migration();
        $migration->down();
        $this->assertFalse(Schema::hasColumn('videos', 'public_id'));

        $first = $this->insertVideo('one');
        $second = $this->insertVideo('two');

        $migration->up();

        $this->assertSame((string) $first, DB::table('videos')->where('id', $first)->value('public_id'));
        $this->assertSame((string) $second, DB::table('videos')->where('id', $second)->value('public_id'));
    }

    public function test_public_id_is_required_and_unique_after_up(): void
    {
        $this->assertTrue(Schema::hasColumn('videos', 'public_id'));

        $base = ['title' => 't', 'original_filename' => 't.mp4', 'status' => 'ready', 'created_at' => now(), 'updated_at' => now()];
        DB::table('videos')->insert($base + ['public_id' => 'dupe']);

        try {
            DB::table('videos')->insert($base + ['public_id' => 'dupe']);
            $this->fail('Duplicate public_id was accepted.');
        } catch (QueryException) {
            $this->assertTrue(true);
        }

        try {
            DB::table('videos')->insert($base);
            $this->fail('Null public_id was accepted.');
        } catch (QueryException) {
            $this->assertTrue(true);
        }
    }
}
