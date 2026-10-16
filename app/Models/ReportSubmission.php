<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

class ReportSubmission extends Model
{
    protected $fillable = [
        'report_id',
        'ip',
        'isp',
        'reason',
    ];

    public function report(): BelongsTo
    {
        return $this->belongsTo(Report::class);
    }
}
