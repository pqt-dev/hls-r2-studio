<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class Report extends Model
{
    protected $fillable = [
        'page_url',
        'video_id',
        'note',
        'reporter_ip',
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
