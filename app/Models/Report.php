<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Report extends Model
{
    public const REASONS = [
        'not_playing' => 'Not playing',
        'lag' => 'Lag / buffering',
        'no_audio' => 'No audio / audio out of sync',
        'wrong_video' => 'Wrong video',
        'other' => 'Other',
    ];

    protected $fillable = [
        'page_url',
        'reason',
        'video_id',
        'note',
        'status',
        'report_count',
        'resolved_at',
        'resolved_by',
        'last_reported_at',
    ];

    protected $casts = [
        'resolved_at' => 'datetime',
        'last_reported_at' => 'datetime',
    ];

    public function video(): BelongsTo
    {
        return $this->belongsTo(Video::class);
    }

    public function resolvedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'resolved_by');
    }
}
