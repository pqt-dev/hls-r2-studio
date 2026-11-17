<?php

namespace App\Services;

use RuntimeException;

/**
 * A video action that could not be carried out. The message is safe to show to the user; the code is a stable
 * machine-readable identifier used by the JSON API.
 */
class VideoActionException extends RuntimeException
{
    public function __construct(
        public readonly string $errorCode,
        string $message,
        public readonly int $httpStatus,
    ) {
        parent::__construct($message);
    }
}
