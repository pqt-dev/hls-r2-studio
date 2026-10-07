<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Upload Max Size (MB)
    |--------------------------------------------------------------------------
    |
    | Maximum allowed size, in megabytes, for an uploaded original video file.
    |
    */

    'max_upload_size_mb' => (int) env('UPLOAD_MAX_SIZE_MB', 2048),

    /*
    |--------------------------------------------------------------------------
    | Keep Original Upload
    |--------------------------------------------------------------------------
    |
    | Whether to keep the original uploaded file on local disk after the
    | transcode job has finished uploading the HLS output to R2. When enabled,
    | the videos:cleanup-orphaned-uploads command does nothing, so kept
    | originals are never deleted by the scheduled cleanup.
    |
    */

    'keep_original_upload' => (bool) env('KEEP_ORIGINAL_UPLOAD', false),

    /*
    |--------------------------------------------------------------------------
    | Chunk Upload Size (MB)
    |--------------------------------------------------------------------------
    |
    | Size, in megabytes, of each chunk sent by the client during chunked
    | video upload.
    |
    */

    'chunk_size_mb' => (int) env('UPLOAD_CHUNK_SIZE_MB', 8),

    /*
    |--------------------------------------------------------------------------
    | Upload Merge Queue
    |--------------------------------------------------------------------------
    |
    | Queue name the chunk-merge job (MergeUploadChunksJob) is pushed to. The
    | default 'default' keeps merging on the same queue as transcoding. Set it
    | to e.g. 'uploads' so a new upload's merge does not wait behind long
    | transcodes. WARNING: a queue that no running worker reads (queue:work
    | --queue=uploads,default) stalls every upload at the merge step.
    |
    */

    'merge_queue' => env('UPLOAD_MERGE_QUEUE') ?: 'default',

    /*
    |--------------------------------------------------------------------------
    | Abandoned Upload TTL (Hours)
    |--------------------------------------------------------------------------
    |
    | Number of hours a chunked upload directory may remain untouched before
    | it is considered abandoned and eligible for cleanup.
    |
    */

    'abandoned_upload_ttl_hours' => (int) env('UPLOAD_ABANDONED_TTL_HOURS', 24),

    /*
    |--------------------------------------------------------------------------
    | Orphaned Transcode Temp TTL (Hours)
    |--------------------------------------------------------------------------
    |
    | Number of hours a transcode temp directory may remain in the
    | 'processing' state before it is considered orphaned (job crashed
    | before it could clean up) and eligible for cleanup. Must exceed the
    | transcode job timeout (48 hours), hence the 60 hour default.
    |
    */

    'orphaned_transcode_ttl_hours' => (int) env('TRANSCODE_ORPHANED_TTL_HOURS', 60),

    /*
    |--------------------------------------------------------------------------
    | Orphaned Upload TTL (Hours)
    |--------------------------------------------------------------------------
    |
    | Number of hours an original uploaded file may remain in the uploads
    | directory before it is considered orphaned (the transcode job that was
    | supposed to consume it never ran to completion) and eligible for
    | cleanup.
    |
    */

    'orphaned_upload_ttl_hours' => (int) env('UPLOAD_ORPHANED_TTL_HOURS', 72),

    /*
    |--------------------------------------------------------------------------
    | Transcode Timeout Multiplier
    |--------------------------------------------------------------------------
    |
    | Multiplier applied to the video's duration (in seconds) to derive the
    | ffmpeg process timeout. See TranscodeVideoJob::calculateProcessTimeout().
    |
    */

    'transcode_timeout_multiplier' => (int) env('TRANSCODE_TIMEOUT_MULTIPLIER', 8),

    /*
    |--------------------------------------------------------------------------
    | Storyboard Tile Size (px)
    |--------------------------------------------------------------------------
    |
    | Width and height, in pixels, of each individual tile in the generated
    | storyboard grid image. See StoryboardGenerator::generate().
    |
    */

    'storyboard_tile_size' => (int) env('STORYBOARD_TILE_SIZE', 160),

    /*
    |--------------------------------------------------------------------------
    | Storyboard Timeout Multiplier
    |--------------------------------------------------------------------------
    |
    | Multiplier applied to the video's duration (in seconds) to derive the
    | ffmpeg process timeout for storyboard generation. See
    | StoryboardGenerator::generate().
    |
    */

    'storyboard_timeout_multiplier' => (int) env('STORYBOARD_TIMEOUT_MULTIPLIER', 2),

    /*
    |--------------------------------------------------------------------------
    | Overall Progress Model
    |--------------------------------------------------------------------------
    |
    | A video reports ONE overall percentage from the moment the user clicks
    | Upload until the HLS output is on R2. Each stage gets a share of that
    | percentage proportional to its estimated cost in seconds:
    | fixed + per_mb * (original size in MB). See App\Support\VideoProgress.
    |
    | Defaults were calibrated on 2026-10-07 from 5 videos (32-316 MB) on a
    | developer machine and are meant to be tuned per deployment (a slower CPU
    | or network shifts the shares). Stages without real data yet use rough
    | estimates: upload, merging and uploading_r2 (the local R2 test upload was
    | too fast to show a size trend, so the network-bound estimate is kept).
    |
    */

    'progress' => [
        'stages' => [
            'upload' => ['fixed' => 1.0, 'per_mb' => 0.04],
            'merging' => ['fixed' => 0.5, 'per_mb' => 0.004],
            'transcoding' => ['fixed' => 6.0, 'per_mb' => 0.05],
            'generating_thumbnail' => ['fixed' => 1.0, 'per_mb' => 0.03],
            'generating_storyboard' => ['fixed' => 2.0, 'per_mb' => 0.045],
            'uploading_r2' => ['fixed' => 2.0, 'per_mb' => 0.08],
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Upload Activity Log
    |--------------------------------------------------------------------------
    |
    | The Activity Log on the Upload page is stored in `video_status_logs`.
    | A "group" is one video, or one upload attempt that never became a video.
    | retain_groups: how many of the newest groups are kept in the database.
    | display_groups: how many of the newest groups the page shows.
    | message_max: maximum length of a client-origin log message.
    | See App\Support\ActivityLog.
    |
    */

    'activity_log' => [
        'retain_groups' => 100,
        'display_groups' => 10,
        'message_max' => 500,
    ],

    /*
    |--------------------------------------------------------------------------
    | Report Allowed Hosts
    |--------------------------------------------------------------------------
    |
    | Comma-separated list of hosts accepted in the `page_url` of a playback
    | report. When empty, any host is accepted.
    |
    */

    'report_allowed_hosts' => array_values(array_filter(array_map('trim', explode(',', (string) env('REPORT_ALLOWED_HOSTS', ''))))),

];
