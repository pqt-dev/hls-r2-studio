<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class VideoStatusLog extends Model
{
    const UPDATED_AT = null;

    protected $fillable = [
        'video_id',
        'status',
        'stage',
        'progress',
    ];
}
