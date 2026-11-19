<?php

namespace App\Exceptions;

class R2NotConfiguredException extends StorageConfigurationException
{
    public function __construct(string $message = 'R2 storage is not configured. Enter the R2 values in Settings.')
    {
        parent::__construct($message);
    }
}
