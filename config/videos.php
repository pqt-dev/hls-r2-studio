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

];
