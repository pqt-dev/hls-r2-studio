<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Model;

class VideoStatusLog extends Model
{
    const UPDATED_AT = null;

    protected $fillable = [
        'video_id',
        'upload_id',
        'level',
        'message',
        'status',
        'stage',
        'progress',
    ];

    protected function casts(): array
    {
        return [
            'video_id' => 'integer',
            'progress' => 'integer',
            'created_at' => 'datetime',
        ];
    }
}
