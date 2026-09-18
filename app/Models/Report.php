<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class Report extends Model
{
    protected $fillable = [
        'page_url',
        'note',
        'reporter_ip',
        'status',
        'report_count',
        'resolved_at',
        'last_reported_at',
    ];

    protected $casts = [
        'resolved_at' => 'datetime',
        'last_reported_at' => 'datetime',
    ];
}
