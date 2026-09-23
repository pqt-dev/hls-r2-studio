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
    | transcode job has finished uploading the HLS output to R2.
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
    | before it could clean up) and eligible for cleanup.
    |
    */

    'orphaned_transcode_ttl_hours' => (int) env('TRANSCODE_ORPHANED_TTL_HOURS', 48),

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
    | Media Bucket
    |--------------------------------------------------------------------------
    |
    | Name of the separate R2 bucket that holds the original source videos,
    | read by the one-off videos:backfill-storyboards command.
    |
    */

    'media_bucket' => env('MEDIA_R2_BUCKET'),

];
