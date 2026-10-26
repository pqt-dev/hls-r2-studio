<?php

namespace Tests\Unit;

use App\Support\FfmpegCommand;
use Symfony\Component\Process\ExecutableFinder;
use Tests\TestCase;

class FfmpegCommandTest extends TestCase
{
    protected function setUp(): void
    {
        parent::setUp();

        FfmpegCommand::resetCache();
    }

    protected function tearDown(): void
    {
        FfmpegCommand::resetCache();

        parent::tearDown();
    }

    public function test_wrap_returns_the_args_unchanged_when_nice_is_disabled(): void
    {
        config(['services.ffmpeg.nice' => 0]);

        $this->assertSame(['ffmpeg', '-y', '-i', 'in.mp4'], FfmpegCommand::wrap(['ffmpeg', '-y', '-i', 'in.mp4']));
    }

    public function test_wrap_returns_the_args_unchanged_when_nice_is_negative(): void
    {
        config(['services.ffmpeg.nice' => -5]);

        $this->assertSame(['ffmpeg', '-y'], FfmpegCommand::wrap(['ffmpeg', '-y']));
    }

    public function test_wrap_prefixes_the_command_with_nice_when_enabled(): void
    {
        $nice = (new ExecutableFinder)->find('nice');

        if ($nice === null) {
            $this->markTestSkipped('The nice executable is not available on this machine.');
        }

        config(['services.ffmpeg.nice' => 10]);

        $this->assertSame(
            [$nice, '-n', '10', 'ffmpeg', '-y', '-i', 'in.mp4'],
            FfmpegCommand::wrap(['ffmpeg', '-y', '-i', 'in.mp4'])
        );
    }

    public function test_thread_args_are_empty_by_default(): void
    {
        config(['services.ffmpeg.threads' => null]);

        $this->assertSame([], FfmpegCommand::threadArgs());
    }

    public function test_thread_args_contain_the_configured_thread_count(): void
    {
        config(['services.ffmpeg.threads' => 2]);

        $this->assertSame(['-threads', '2'], FfmpegCommand::threadArgs());
    }
}
