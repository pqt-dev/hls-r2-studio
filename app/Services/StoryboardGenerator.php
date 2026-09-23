<?php

namespace App\Services;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

class StoryboardGenerator
{
    private const MIN_THUMBNAIL_SATURATION = 5.0;

    private const MIN_THUMBNAIL_DETAIL = 3.0;

    private const DETAIL_SCORE_WEIGHT = 5.0;

    /**
     * Storyboard grid sizes produced for every video (each is N columns by N
     * rows, so N*N tiles). All of them are always generated, regardless of
     * the video's duration. See generate().
     */
    private const STORYBOARD_GRID_SIZES = [3, 4, 5];

    /**
     * How many candidate frames are extracted per tile slot of the densest
     * storyboard grid. The single decode pass extracts
     * CANDIDATES_PER_SLOT * max(STORYBOARD_GRID_SIZES)^2 frames in total, and
     * each grid then picks the best-scoring candidate for each of its slots.
     */
    private const CANDIDATES_PER_SLOT = 3;

    /**
     * How many storyboard candidates are scored concurrently. Each candidate
     * needs two ffprobe subprocess spawns (saturation + detail), so this
     * many candidates in flight means up to
     * STORYBOARD_SCORING_CONCURRENCY * 2 processes running at once. This is
     * CPU-bound work, so it's sized against the production VPS's 4 vCPUs:
     * 4 candidates in flight keeps one candidate's pair of processes per
     * core on average.
     */
    private const STORYBOARD_SCORING_CONCURRENCY = 4;

    /**
     * The video being worked on, used purely as log context.
     */
    private ?int $videoId = null;

    /**
     * Generate one storyboard grid image per size in STORYBOARD_GRID_SIZES,
     * each accompanied by a JSON file describing every tile's time range and
     * position in the grid. Together with the thumbnail these are the
     * candidate images a user can pick from as a feature image, so the tiles
     * are chosen by picture quality rather than purely by even spacing.
     *
     * The source video is decoded exactly once: a single ffmpeg pass extracts
     * a dense pool of evenly spaced candidate frames, each of which is then
     * scored, and every grid picks the best-scoring candidate for each of its
     * time slots. Composing the grids afterwards only reads those small
     * already-extracted JPEGs.
     */
    public function generate(string $inputPath, string $tmpDir, ?float $duration, int $videoId): void
    {
        $this->videoId = $videoId;

        if ($duration === null || $duration <= 0) {
            Log::warning('Skipping storyboard generation: video duration is unknown.', [
                'video_id' => $this->videoId,
            ]);

            return;
        }

        $tileSize = config('videos.storyboard_tile_size');
        $largestGrid = max(self::STORYBOARD_GRID_SIZES);
        $totalCandidates = self::CANDIDATES_PER_SLOT * $largestGrid * $largestGrid;

        $candidatePaths = $this->extractStoryboardCandidates($inputPath, $tmpDir, $duration, $totalCandidates, $tileSize);

        try {
            $candidates = $this->scoreStoryboardCandidates($candidatePaths, $duration, $totalCandidates);

            foreach (self::STORYBOARD_GRID_SIZES as $size) {
                try {
                    $this->composeStoryboardGrid($candidates, $tmpDir, $duration, $size, $tileSize);
                } catch (\RuntimeException $e) {
                    // One grid failing must not cost the user the other two.
                    Log::warning('Failed to generate a storyboard grid; proceeding with the remaining grids.', [
                        'video_id' => $this->videoId,
                        'grid' => "{$size}x{$size}",
                        'error' => $e->getMessage(),
                    ]);
                }
            }
        } finally {
            foreach ($candidatePaths as $candidatePath) {
                if (File::exists($candidatePath)) {
                    File::delete($candidatePath);
                }
            }
        }
    }

    /**
     * The storyboards column value: the R2 paths of every storyboard grid
     * that was actually produced, keyed by grid size, or null when none was.
     */
    public static function paths(string $tmpDir, string $prefix): ?array
    {
        $storyboards = [];

        foreach (self::STORYBOARD_GRID_SIZES as $size) {
            $key = "{$size}x{$size}";
            $image = "storyboard_{$key}.jpg";
            $meta = "storyboard_{$key}.json";

            if (File::exists("{$tmpDir}/{$image}") && File::exists("{$tmpDir}/{$meta}")) {
                $storyboards[$key] = [
                    'path' => $prefix.$image,
                    'meta_path' => $prefix.$meta,
                ];
            }
        }

        return $storyboards === [] ? null : $storyboards;
    }

    /**
     * The single decode pass over the source video: extract $totalCandidates
     * evenly spaced frames, already cropped to a square and scaled down to
     * one tile, as individual JPEGs. Returns their paths in chronological
     * order.
     *
     * @return list<string>
     */
    private function extractStoryboardCandidates(
        string $inputPath,
        string $tmpDir,
        float $duration,
        int $totalCandidates,
        int $tileSize
    ): array {
        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $inputPath,
            '-vf', "fps={$totalCandidates}/{$duration},crop='min(iw\,ih)':'min(iw\,ih)',scale={$tileSize}:{$tileSize}",
            '-frames:v', (string) $totalCandidates,
            '-start_number', '0',
            "{$tmpDir}/candidate_%04d.jpg",
        ]);

        $process->setTimeout(self::calculateStoryboardTimeout($duration));
        $process->run();

        $paths = glob("{$tmpDir}/candidate_*.jpg") ?: [];
        sort($paths);

        if (! $process->isSuccessful() || $paths === []) {
            foreach ($paths as $path) {
                File::delete($path);
            }

            throw new \RuntimeException('ffmpeg storyboard candidate extraction failed: '.$process->getErrorOutput());
        }

        return array_values($paths);
    }

    /**
     * Score every extracted candidate frame with the same saturation and
     * detail measurements the thumbnail picker uses, and record the source
     * timestamp each frame was sampled at.
     *
     * Candidates are scored STORYBOARD_SCORING_CONCURRENCY at a time (each
     * needs two ffprobe subprocess spawns run concurrently via Symfony
     * Process's async start()/wait() instead of the blocking run()), which
     * cuts wall-clock time on multi-core hosts without reducing total CPU
     * work.
     *
     * @param  list<string>  $candidatePaths
     * @return list<array{timestamp: float, path: string, saturationScore: ?float, detailScore: ?float}>
     */
    private function scoreStoryboardCandidates(array $candidatePaths, float $duration, int $totalCandidates): array
    {
        $pending = [];

        foreach ($candidatePaths as $index => $path) {
            // The fps filter emits frame $index at output time
            // $index / ($totalCandidates / $duration).
            $pending[$index] = [
                'timestamp' => $index * $duration / $totalCandidates,
                'path' => $path,
            ];
        }

        $results = [];
        $inFlight = [];

        while ($pending !== [] || $inFlight !== []) {
            while (count($inFlight) < self::STORYBOARD_SCORING_CONCURRENCY && $pending !== []) {
                $index = array_key_first($pending);
                $task = $pending[$index];
                unset($pending[$index]);

                $inFlight[$index] = $this->startStoryboardCandidateScoring($task);
            }

            foreach ($inFlight as $index => $entry) {
                if (($entry['saturationProcess'] !== null && $entry['saturationProcess']->isRunning())
                    || ($entry['detailProcess'] !== null && $entry['detailProcess']->isRunning())) {
                    continue;
                }

                $results[$index] = [
                    'timestamp' => $entry['timestamp'],
                    'path' => $entry['path'],
                    'saturationScore' => $this->finishStoryboardCandidateMeasurement($entry['saturationProcess']),
                    'detailScore' => $this->finishStoryboardCandidateMeasurement($entry['detailProcess']),
                ];

                unset($inFlight[$index]);
            }

            if ($inFlight !== []) {
                usleep(10000);
            }
        }

        ksort($results);

        return array_values($results);
    }

    /**
     * Start both scoring subprocesses for one storyboard candidate without
     * blocking. A process that fails to even launch is logged the same way
     * a failed synchronous measurement was, and left null so the candidate
     * still gets a result with that particular score as null, matching the
     * previous per-measurement error handling.
     *
     * @param  array{timestamp: float, path: string}  $task
     * @return array{timestamp: float, path: string, saturationProcess: ?Process, detailProcess: ?Process}
     */
    private function startStoryboardCandidateScoring(array $task): array
    {
        $saturationProcess = self::buildSaturationMeasurementProcess($task['path']);

        try {
            $saturationProcess->start();
        } catch (\RuntimeException $e) {
            Log::warning('Failed to measure storyboard candidate saturation, treating as unscored', [
                'video_id' => $this->videoId,
                'timestamp' => $task['timestamp'],
                'error' => $e->getMessage(),
            ]);

            $saturationProcess = null;
        }

        $detailProcess = self::buildDetailMeasurementProcess($task['path']);

        try {
            $detailProcess->start();
        } catch (\RuntimeException $e) {
            Log::warning('Failed to measure storyboard candidate detail, treating as unscored', [
                'video_id' => $this->videoId,
                'timestamp' => $task['timestamp'],
                'error' => $e->getMessage(),
            ]);

            $detailProcess = null;
        }

        return [
            'timestamp' => $task['timestamp'],
            'path' => $task['path'],
            'saturationProcess' => $saturationProcess,
            'detailProcess' => $detailProcess,
        ];
    }

    /**
     * Wait for one already-started storyboard scoring process and read its
     * result, or return null if it never started.
     */
    private function finishStoryboardCandidateMeasurement(?Process $process): ?float
    {
        if ($process === null) {
            return null;
        }

        $process->wait();

        return self::readMeasurementProcessOutput($process);
    }

    /**
     * Pick one candidate frame per tile slot: the slot's highest-ranked
     * candidate that passes the quality threshold, or — when none in that
     * slot passes — its highest-ranked candidate regardless of the threshold.
     * A slot no candidate fell into reuses the nearest slot that has one.
     *
     * @param  list<array{timestamp: float, path: string, saturationScore: ?float, detailScore: ?float}>  $candidates
     * @return list<array{timestamp: float, path: string, saturationScore: ?float, detailScore: ?float}>
     */
    private function chooseStoryboardFrames(array $candidates, int $totalTiles, float $duration): array
    {
        $rank = fn (array $c) => ($c['saturationScore'] ?? 0)
            + self::DETAIL_SCORE_WEIGHT * ($c['detailScore'] ?? 0);

        $isRemoved = fn (array $c) => $c['saturationScore'] === null
            || $c['saturationScore'] < self::MIN_THUMBNAIL_SATURATION
            || ($c['detailScore'] !== null && $c['detailScore'] < self::MIN_THUMBNAIL_DETAIL);

        $slotDuration = $duration / $totalTiles;
        $slots = array_fill(0, $totalTiles, []);

        foreach ($candidates as $candidate) {
            $slotIndex = (int) floor($candidate['timestamp'] / $slotDuration);
            $slotIndex = max(0, min($totalTiles - 1, $slotIndex));
            $slots[$slotIndex][] = $candidate;
        }

        $chosen = [];

        foreach ($slots as $slotIndex => $slotCandidates) {
            if ($slotCandidates === []) {
                $chosen[$slotIndex] = null;

                continue;
            }

            $passing = array_values(array_filter($slotCandidates, fn (array $c) => ! $isRemoved($c)));
            $pool = $passing !== [] ? $passing : $slotCandidates;

            usort($pool, fn (array $a, array $b) => $rank($b) <=> $rank($a));

            $chosen[$slotIndex] = $pool[0];
        }

        // Snapshot before filling, so an empty slot always borrows from a slot
        // a candidate genuinely fell into rather than from an earlier fill.
        $genuine = $chosen;

        foreach ($chosen as $slotIndex => $candidate) {
            if ($candidate !== null) {
                continue;
            }

            $replacement = self::nearestChosenStoryboardFrame($genuine, $slotIndex);

            if ($replacement === null) {
                throw new \RuntimeException('No storyboard candidate frames are available for any tile slot.');
            }

            Log::warning('No storyboard candidate frame fell into this tile slot; reusing the nearest slot that has one.', [
                'video_id' => $this->videoId,
                'total_tiles' => $totalTiles,
                'slot' => $slotIndex,
            ]);

            $chosen[$slotIndex] = $replacement;
        }

        return array_values($chosen);
    }

    /**
     * The frame chosen for the slot closest to $slotIndex, searching outwards
     * in both directions, or null when no slot has a frame at all.
     */
    private static function nearestChosenStoryboardFrame(array $chosen, int $slotIndex): ?array
    {
        $totalTiles = count($chosen);

        for ($distance = 1; $distance < $totalTiles; $distance++) {
            foreach ([$slotIndex - $distance, $slotIndex + $distance] as $neighbour) {
                if (isset($chosen[$neighbour])) {
                    return $chosen[$neighbour];
                }
            }
        }

        return null;
    }

    /**
     * Compose one $size x $size storyboard grid from the chosen candidate
     * frames and write its JSON tile metadata alongside it.
     *
     * The chosen frames are a scattered subset of the candidate pool, so they
     * are first copied into a contiguously numbered sequence that ffmpeg's
     * image2 demuxer can read in slot order, then tiled in a single cheap
     * pass over those small JPEGs.
     *
     * @param  list<array{timestamp: float, path: string, saturationScore: ?float, detailScore: ?float}>  $candidates
     */
    private function composeStoryboardGrid(array $candidates, string $tmpDir, float $duration, int $size, int $tileSize): void
    {
        $totalTiles = $size * $size;
        $chosen = $this->chooseStoryboardFrames($candidates, $totalTiles, $duration);

        $sequencePattern = "{$tmpDir}/tile_{$size}x{$size}_%04d.jpg";
        $sequencePaths = [];
        $finalPath = "{$tmpDir}/storyboard_{$size}x{$size}.jpg";

        try {
            foreach ($chosen as $slotIndex => $candidate) {
                $sequencePath = sprintf($sequencePattern, $slotIndex);
                File::copy($candidate['path'], $sequencePath);
                $sequencePaths[] = $sequencePath;
            }

            $process = new Process([
                config('services.ffmpeg.binary'),
                '-y',
                '-start_number', '0',
                '-i', $sequencePattern,
                '-vf', "tile={$size}x{$size}",
                '-frames:v', '1',
                $finalPath,
            ]);

            $process->setTimeout(60);
            $process->run();

            // The tile filter requires exactly size*size input frames. If
            // fewer are available it silently produces no output file instead
            // of failing the process, so file existence must be checked in
            // addition to the exit code.
            if (! $process->isSuccessful() || ! File::exists($finalPath)) {
                throw new \RuntimeException("ffmpeg storyboard {$size}x{$size} composition failed: ".$process->getErrorOutput());
            }
        } finally {
            foreach ($sequencePaths as $sequencePath) {
                if (File::exists($sequencePath)) {
                    File::delete($sequencePath);
                }
            }
        }

        $tileDuration = $duration / $totalTiles;
        $tiles = [];

        for ($i = 0; $i < $totalTiles; $i++) {
            $col = $i % $size;
            $row = intdiv($i, $size);

            $tiles[] = [
                'start' => round($i * $tileDuration, 2),
                'end' => round(($i + 1) * $tileDuration, 2),
                'x' => $col * $tileSize,
                'y' => $row * $tileSize,
            ];
        }

        File::put("{$tmpDir}/storyboard_{$size}x{$size}.json", json_encode($tiles));
    }

    public static function buildSaturationMeasurementProcess(string $imagePath): Process
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-f', 'lavfi',
            '-i', "movie={$imagePath},signalstats",
            '-show_entries', 'frame_tags=lavfi.signalstats.SATAVG',
            '-of', 'default=noprint_wrappers=1:nokey=1',
        ]);

        $process->setTimeout(60);

        return $process;
    }

    public static function buildDetailMeasurementProcess(string $imagePath): Process
    {
        $process = new Process([
            config('services.ffmpeg.ffprobe_binary'),
            '-v', 'error',
            '-f', 'lavfi',
            '-i', "movie={$imagePath},edgedetect,signalstats",
            '-show_entries', 'frame_tags=lavfi.signalstats.YAVG',
            '-of', 'default=noprint_wrappers=1:nokey=1',
        ]);

        $process->setTimeout(60);

        return $process;
    }

    public static function readMeasurementProcessOutput(Process $process): ?float
    {
        if (! $process->isSuccessful()) {
            return null;
        }

        $output = trim($process->getOutput());

        if ($output === '' || ! is_numeric($output)) {
            return null;
        }

        return (float) $output;
    }

    /**
     * Calculate the ffmpeg process timeout (in seconds) for storyboard
     * generation, proportional to the video duration. Storyboard generation
     * is a single decode-only pass (no re-encode), so it needs a much
     * smaller multiplier than the main transcode timeout.
     */
    private static function calculateStoryboardTimeout(float $duration): int
    {
        return max(60, (int) ceil($duration * config('videos.storyboard_timeout_multiplier')));
    }
}
