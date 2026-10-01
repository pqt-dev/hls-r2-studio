<?php

namespace App\Events;

use Illuminate\Broadcasting\Channel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Foundation\Events\Dispatchable;

class VideoStatusUpdated implements ShouldBroadcastNow
{
    use Dispatchable;

    public function __construct(
        public int $videoId,
        public string $status,
        public ?string $stage,
        public int $progress,
    ) {}

    public function broadcastOn(): Channel
    {
        return new Channel('videos');
    }

    public function broadcastAs(): string
    {
        return 'video.status-updated';
    }

    public function broadcastWith(): array
    {
        return [
            'videoId' => $this->videoId,
            'status' => $this->status,
            'stage' => $this->stage,
            'progress' => $this->progress,
        ];
    }
}
