<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Resend, Postmark, AWS, and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'ffmpeg' => [
        'binary' => env('FFMPEG_BINARY', 'ffmpeg'),
        'ffprobe_binary' => env('FFPROBE_BINARY', 'ffprobe'),
        // CPU priority (nice level) for ffmpeg processes; 0 or negative disables. Max useful value is 19.
        'nice' => (int) env('FFMPEG_NICE', 10),
        // Encoder threads per ffmpeg job; null lets ffmpeg decide.
        'threads' => (int) env('FFMPEG_THREADS', 0) > 0 ? (int) env('FFMPEG_THREADS') : null,
    ],

];
