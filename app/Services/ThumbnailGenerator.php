<?php

namespace App\Services;

use Illuminate\Support\Facades\File;
use Illuminate\Support\Facades\Log;
use Symfony\Component\Process\Process;

class ThumbnailGenerator
{
    private const MIN_THUMBNAIL_SATURATION = 5.0;

    private const MIN_THUMBNAIL_DETAIL = 3.0;

    private const DETAIL_SCORE_WEIGHT = 5.0;

    private const INITIAL_SAMPLE_FRACTIONS = [0.25, 0.5, 0.75];

    private const EXTRA_SAMPLE_FRACTIONS = [0.1, 0.9];

    private const SMART_CROP_WINDOW_COUNT = 3;

    /**
     * The video being worked on, used purely as log context.
     */
    private ?int $videoId = null;

    public function generate(string $inputPath, string $tmpDir, ?float $duration, ?int $sourceWidth, ?int $sourceHeight, int $videoId): void
    {
        $this->videoId = $videoId;

        $finalPath = "{$tmpDir}/thumbnail.jpg";
        $effectiveDuration = $duration ?? 0.0;

        if ($effectiveDuration < 3) {
            try {
                $this->extractThumbnailCandidate($inputPath, $effectiveDuration / 2, $finalPath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to extract thumbnail for short video; proceeding without a thumbnail.', [
                    'video_id' => $this->videoId,
                    'error' => $e->getMessage(),
                ]);
            }

            return;
        }

        $maxTimestamp = max(0, $effectiveDuration - 0.5);

        $rank = fn (array $c) => ($c['saturationScore'] ?? 0)
            + self::DETAIL_SCORE_WEIGHT * ($c['detailScore'] ?? 0);

        $isRemoved = fn (array $c) => $c['saturationScore'] === null
            || $c['saturationScore'] < self::MIN_THUMBNAIL_SATURATION
            || ($c['detailScore'] !== null && $c['detailScore'] < self::MIN_THUMBNAIL_DETAIL);

        $candidates = [];
        $candidateCounter = 0;

        $extractCandidate = function (float $fraction) use ($inputPath, $tmpDir, $effectiveDuration, $maxTimestamp, &$candidateCounter, &$candidates): void {
            $timestamp = min(max($effectiveDuration * $fraction, 0), $maxTimestamp);
            $candidatePath = "{$tmpDir}/thumb_candidate_{$candidateCounter}.jpg";
            $candidateCounter++;

            try {
                $this->extractThumbnailCandidate($inputPath, $timestamp, $candidatePath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to extract thumbnail candidate frame, skipping', [
                    'timestamp' => $timestamp,
                    'error' => $e->getMessage(),
                ]);

                if (File::exists($candidatePath)) {
                    File::delete($candidatePath);
                }

                return;
            }

            try {
                $saturationScore = $this->measureSaturation($candidatePath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to measure thumbnail candidate saturation, treating as unscored', [
                    'timestamp' => $timestamp,
                    'error' => $e->getMessage(),
                ]);

                $saturationScore = null;
            }

            try {
                $detailScore = $this->measureDetail($candidatePath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to measure thumbnail candidate detail, treating as unscored', [
                    'timestamp' => $timestamp,
                    'error' => $e->getMessage(),
                ]);

                $detailScore = null;
            }

            $candidates[] = [
                'timestamp' => $timestamp,
                'path' => $candidatePath,
                'saturationScore' => $saturationScore,
                'detailScore' => $detailScore,
            ];
        };

        foreach (self::INITIAL_SAMPLE_FRACTIONS as $fraction) {
            $extractCandidate($fraction);
        }

        $countKept = fn () => count(array_filter($candidates, fn (array $c) => ! $isRemoved($c)));

        foreach (self::EXTRA_SAMPLE_FRACTIONS as $fraction) {
            if ($countKept() >= 3) {
                break;
            }

            $extractCandidate($fraction);
        }

        if (count($candidates) === 0) {
            Log::warning('Unable to extract any thumbnail candidate frames from the video; proceeding without a thumbnail.', [
                'video_id' => $this->videoId,
            ]);

            return;
        }

        $kept = array_values(array_filter(
            $candidates,
            fn (array $c) => ! $isRemoved($c)
        ));
        $removed = array_values(array_filter(
            $candidates,
            fn (array $c) => $isRemoved($c)
        ));

        $isLandscape = $sourceWidth !== null && $sourceHeight !== null && $sourceWidth > $sourceHeight;

        $minNeeded = $isLandscape ? 1 : 3;

        if (count($kept) < $minNeeded) {
            usort($removed, fn (array $a, array $b) => $rank($b) <=> $rank($a));
            $kept = array_merge($kept, array_slice($removed, 0, $minNeeded - count($kept)));
        }

        usort($kept, fn (array $a, array $b) => $rank($b) <=> $rank($a));

        if (! $isLandscape && count($kept) < 3) {
            Log::warning('Not enough valid thumbnail candidates for grid, falling back to single-frame thumbnail', [
                'video_id' => $this->videoId,
                'kept_count' => count($kept),
            ]);

            $isLandscape = true;
        }

        $thumbnailCreated = false;

        if (! $isLandscape) {
            $thumbnailCreated = $this->tryComposeGridThumbnail($kept, $finalPath);
        }

        if (! $thumbnailCreated) {
            $thumbnailCreated = $this->tryComposeSingleFrameThumbnail($kept, $finalPath);
        }

        if (! $thumbnailCreated) {
            Log::warning('Unable to generate a thumbnail for this video after trying all available candidates; proceeding without a thumbnail.', [
                'video_id' => $this->videoId,
            ]);
        }

        foreach ($candidates as $candidate) {
            if (File::exists($candidate['path'])) {
                File::delete($candidate['path']);
            }
        }
    }

    private function composeSingleFrameThumbnail(string $framePath, string $outputPath): void
    {
        $this->smartCropToCanvas($framePath, $outputPath, 1080, 1080);
    }

    /**
     * Try to crop up to 3 candidates (in rank order) into grid columns and
     * hstack them into a grid thumbnail. Returns false without throwing if
     * fewer than 3 candidates can be cropped successfully, or if the final
     * hstack composition fails, so the caller can fall back to a
     * single-frame thumbnail instead.
     */
    private function tryComposeGridThumbnail(array $kept, string $finalPath): bool
    {
        $workDir = dirname($finalPath);
        $uid = uniqid('grid_', true);
        $columnResults = [];

        foreach ($kept as $candidate) {
            if (count($columnResults) >= 3) {
                break;
            }

            $columnPath = "{$workDir}/{$uid}_col_".count($columnResults).'.jpg';

            try {
                $this->smartCropToCanvas($candidate['path'], $columnPath, 360, 1080);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to crop thumbnail candidate for grid, trying next candidate', [
                    'video_id' => $this->videoId,
                    'timestamp' => $candidate['timestamp'],
                    'error' => $e->getMessage(),
                ]);

                if (File::exists($columnPath)) {
                    File::delete($columnPath);
                }

                continue;
            }

            $columnResults[] = [
                'timestamp' => $candidate['timestamp'],
                'path' => $columnPath,
            ];
        }

        if (count($columnResults) < 3) {
            foreach ($columnResults as $result) {
                if (File::exists($result['path'])) {
                    File::delete($result['path']);
                }
            }

            return false;
        }

        usort($columnResults, fn (array $a, array $b) => $a['timestamp'] <=> $b['timestamp']);

        try {
            $this->composeGridThumbnail(array_column($columnResults, 'path'), $finalPath);
        } catch (\RuntimeException $e) {
            Log::warning('Failed to compose grid thumbnail from cropped candidates, falling back to single-frame thumbnail', [
                'video_id' => $this->videoId,
                'error' => $e->getMessage(),
            ]);

            return false;
        }

        return true;
    }

    /**
     * Try each candidate (in rank order) as a single-frame thumbnail until
     * one succeeds. Returns false without throwing if every candidate
     * fails, so the caller can proceed without a thumbnail.
     */
    private function tryComposeSingleFrameThumbnail(array $kept, string $finalPath): bool
    {
        foreach ($kept as $candidate) {
            try {
                $this->composeSingleFrameThumbnail($candidate['path'], $finalPath);
            } catch (\RuntimeException $e) {
                Log::warning('Failed to compose single-frame thumbnail from candidate, trying next candidate', [
                    'video_id' => $this->videoId,
                    'timestamp' => $candidate['timestamp'],
                    'error' => $e->getMessage(),
                ]);

                continue;
            }

            return true;
        }

        return false;
    }

    private function composeGridThumbnail(array $columnPaths, string $outputPath): void
    {
        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $columnPaths[0],
            '-i', $columnPaths[1],
            '-i', $columnPaths[2],
            '-filter_complex', '[0:v][1:v][2:v]hstack=inputs=3[v]',
            '-map', '[v]',
            '-frames:v', '1',
            $outputPath,
        ]);

        $process->setTimeout(60);
        $process->run();

        foreach ($columnPaths as $columnPath) {
            if (File::exists($columnPath)) {
                File::delete($columnPath);
            }
        }

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffmpeg grid thumbnail failed: '.$process->getErrorOutput());
        }
    }

    private function smartCropToCanvas(string $framePath, string $outputPath, int $canvasWidth, int $canvasHeight): void
    {
        $workDir = dirname($outputPath);
        $uid = uniqid('smartcrop_', true);
        $scaledPath = "{$workDir}/{$uid}_scaled.jpg";
        $trialPaths = [];

        $scaleProcess = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-i', $framePath,
            '-vf', "scale={$canvasWidth}:{$canvasHeight}:force_original_aspect_ratio=increase",
            '-frames:v', '1',
            $scaledPath,
        ]);
        $scaleProcess->setTimeout(60);
        $scaleProcess->run();

        try {
            if (! $scaleProcess->isSuccessful()) {
                throw new \RuntimeException('ffmpeg smart-crop scale failed: '.$scaleProcess->getErrorOutput());
            }

            $dimensions = getimagesize($scaledPath);

            if ($dimensions === false) {
                throw new \RuntimeException("Unable to read scaled image dimensions: {$scaledPath}");
            }

            [$scaledWidth, $scaledHeight] = $dimensions;

            $excessX = $scaledWidth - $canvasWidth;
            $excessY = $scaledHeight - $canvasHeight;

            if ($excessX > 0) {
                $axis = 'x';
                $maxOffset = $excessX;
            } elseif ($excessY > 0) {
                $axis = 'y';
                $maxOffset = $excessY;
            } else {
                $axis = null;
                $maxOffset = 0;
            }

            if ($maxOffset > 0) {
                $windowCount = self::SMART_CROP_WINDOW_COUNT;
                $offsets = [];

                for ($i = 0; $i < $windowCount; $i++) {
                    $offsets[] = (int) round($maxOffset * $i / ($windowCount - 1));
                }

                $offsets = array_values(array_unique($offsets));
            } else {
                $offsets = [0];
            }

            $bestOffset = null;
            $bestScore = null;

            foreach ($offsets as $index => $offset) {
                $x = $axis === 'x' ? $offset : 0;
                $y = $axis === 'y' ? $offset : 0;
                $trialPath = "{$workDir}/{$uid}_trial_{$index}.jpg";
                $trialPaths[] = $trialPath;

                $cropProcess = new Process([
                    config('services.ffmpeg.binary'),
                    '-y',
                    '-i', $scaledPath,
                    '-vf', "crop={$canvasWidth}:{$canvasHeight}:{$x}:{$y}",
                    '-frames:v', '1',
                    $trialPath,
                ]);
                $cropProcess->setTimeout(60);
                $cropProcess->run();

                if (! $cropProcess->isSuccessful()) {
                    continue;
                }

                try {
                    $score = $this->measureDetail($trialPath);
                } catch (\RuntimeException $e) {
                    Log::warning('Failed to measure detail for smart-crop trial offset, trying next offset', [
                        'video_id' => $this->videoId,
                        'offset' => $offset,
                        'error' => $e->getMessage(),
                    ]);

                    continue;
                }

                if ($score !== null && ($bestScore === null || $score > $bestScore)) {
                    $bestScore = $score;
                    $bestOffset = $offset;
                }
            }

            if ($bestOffset === null) {
                $bestOffset = (int) round($maxOffset / 2);
            }

            $finalX = $axis === 'x' ? $bestOffset : 0;
            $finalY = $axis === 'y' ? $bestOffset : 0;

            $finalCropProcess = new Process([
                config('services.ffmpeg.binary'),
                '-y',
                '-i', $scaledPath,
                '-vf', "crop={$canvasWidth}:{$canvasHeight}:{$finalX}:{$finalY}",
                '-frames:v', '1',
                $outputPath,
            ]);
            $finalCropProcess->setTimeout(60);
            $finalCropProcess->run();

            if (! $finalCropProcess->isSuccessful()) {
                throw new \RuntimeException('ffmpeg smart-crop final crop failed: '.$finalCropProcess->getErrorOutput());
            }
        } finally {
            if (File::exists($scaledPath)) {
                File::delete($scaledPath);
            }

            foreach ($trialPaths as $trialPath) {
                if (File::exists($trialPath)) {
                    File::delete($trialPath);
                }
            }
        }
    }

    private function extractThumbnailCandidate(string $inputPath, float $timestamp, string $outputPath): void
    {
        $process = new Process([
            config('services.ffmpeg.binary'),
            '-y',
            '-ss', (string) $timestamp,
            '-i', $inputPath,
            '-vf', 'thumbnail=24',
            '-frames:v', '1',
            $outputPath,
        ]);

        $process->setTimeout(60);
        $process->run();

        if (! $process->isSuccessful()) {
            throw new \RuntimeException('ffmpeg thumbnail failed: '.$process->getErrorOutput());
        }
    }

    private function measureSaturation(string $imagePath): ?float
    {
        $process = StoryboardGenerator::buildSaturationMeasurementProcess($imagePath);
        $process->run();

        return StoryboardGenerator::readMeasurementProcessOutput($process);
    }

    private function measureDetail(string $imagePath): ?float
    {
        $process = StoryboardGenerator::buildDetailMeasurementProcess($imagePath);
        $process->run();

        return StoryboardGenerator::readMeasurementProcessOutput($process);
    }
}
