<?php

namespace App\Support;

/**
 * Server resource figures (CPU load, RAM, disk) shown on the overview dashboard.
 */
final class SystemStats
{
    /**
     * @return array<string, int|float|null>
     */
    public static function snapshot(): array
    {
        $cpuPercent = null;
        $cpuCores = null;
        $loadAvg1min = null;
        if (file_exists('/proc/loadavg')) {
            $loadAvg1min = (float) explode(' ', trim(file_get_contents('/proc/loadavg')))[0];
            $coreCount = substr_count(file_get_contents('/proc/cpuinfo'), 'processor');
            if ($coreCount > 0) {
                $cpuCores = $coreCount;
                $cpuPercent = min(100, round($loadAvg1min / $coreCount * 100));
            }
        }

        $ramPercent = null;
        $ramUsedGb = null;
        $ramTotalGb = null;
        if (file_exists('/proc/meminfo')) {
            $memInfo = file_get_contents('/proc/meminfo');
            preg_match('/MemTotal:\s+(\d+)/', $memInfo, $memTotalMatch);
            preg_match('/MemAvailable:\s+(\d+)/', $memInfo, $memAvailableMatch);
            if (isset($memTotalMatch[1], $memAvailableMatch[1]) && (int) $memTotalMatch[1] > 0) {
                $memTotal = (int) $memTotalMatch[1];
                $memAvailable = (int) $memAvailableMatch[1];
                $ramPercent = round((($memTotal - $memAvailable) / $memTotal) * 100);
                $ramUsedGb = round(($memTotal - $memAvailable) / 1024 / 1024, 1);
                $ramTotalGb = round($memTotal / 1024 / 1024, 1);
            }
        }

        $diskTotal = disk_total_space(storage_path());
        $diskFree = disk_free_space(storage_path());
        $diskPercent = $diskTotal ? round((($diskTotal - $diskFree) / $diskTotal) * 100) : null;
        $diskUsedGb = round(($diskTotal - $diskFree) / 1024 / 1024 / 1024, 1);
        $diskTotalGb = round($diskTotal / 1024 / 1024 / 1024, 1);

        return [
            'cpuPercent' => $cpuPercent,
            'ramPercent' => $ramPercent,
            'diskPercent' => $diskPercent,
            'cpuCores' => $cpuCores,
            'loadAvg1min' => $loadAvg1min,
            'ramUsedGb' => $ramUsedGb,
            'ramTotalGb' => $ramTotalGb,
            'diskUsedGb' => $diskUsedGb,
            'diskTotalGb' => $diskTotalGb,
        ];
    }
}
