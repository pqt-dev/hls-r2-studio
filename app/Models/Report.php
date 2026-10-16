<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;

class Report extends Model
{
    public const REASONS = [
        'not_loading' => 'Video not loading',
        'not_playing' => 'Cannot start playback (endless spinner)',
        'lag' => 'Lag / buffering',
        'wrong_video' => 'Wrong content',
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

    public function submissions(): HasMany
    {
        return $this->hasMany(ReportSubmission::class);
    }

    public function resolvedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'resolved_by');
    }
}
