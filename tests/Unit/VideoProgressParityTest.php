<?php

namespace Tests\Unit;

use App\Support\VideoProgress;
use Symfony\Component\Process\ExecutableFinder;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class VideoProgressParityTest extends TestCase
{
    public function test_js_upload_weight_matches_php_weights(): void
    {
        $node = (new ExecutableFinder)->find('node');

        if ($node === null) {
            $this->markTestSkipped('node is not available.');
        }

        $sizes = [1024, 5 * 1048576, 100 * 1048576, 1024 * 1048576, 2048 * 1048576];
        $stages = config('videos.progress.stages');

        $script = 'import(process.argv[1]).then(m => {'
            .'const sizes = JSON.parse(process.argv[2]); const stages = JSON.parse(process.argv[3]);'
            .'console.log(JSON.stringify(sizes.map(s => m.uploadWeight(s, stages))));});';

        $process = new Process(
            [$node, '--input-type=commonjs', '-e', $script, 'file://'.base_path('resources/js/video-progress.js'), json_encode($sizes), json_encode($stages)],
            base_path()
        );
        $process->mustRun();

        $actual = json_decode(trim($process->getOutput()), true);

        $this->assertCount(count($sizes), $actual);

        foreach ($sizes as $i => $size) {
            $this->assertEqualsWithDelta(VideoProgress::weights($size, true)['upload'], $actual[$i], 1e-9, "size {$size}");
        }
    }
}
