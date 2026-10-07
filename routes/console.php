<?php

use Illuminate\Support\Facades\Schedule;

Schedule::command('uploads:cleanup-abandoned')->daily()->withoutOverlapping();
Schedule::command('videos:cleanup-orphaned-tmp')->daily()->withoutOverlapping();
Schedule::command('videos:cleanup-orphaned-uploads')->daily()->withoutOverlapping();
