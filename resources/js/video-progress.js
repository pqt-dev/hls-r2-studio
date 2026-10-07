/**
 * Browser mirror of App\Support\VideoProgress::weights() for the 'upload' stage (with the merge stage present).
 * Keep both in sync; tests/Unit/VideoProgressParityTest.php compares them.
 */
const BYTES_PER_MB = 1048576;
const STAGES = ['upload', 'merging', 'transcoding', 'generating_thumbnail', 'generating_storyboard', 'uploading_r2'];

/**
 * Share (percent, 0..100) of the overall progress that the upload stage takes for a file of the given size.
 *
 * @param {number} sizeBytes
 * @param {Object} stages Map of stage name -> {fixed, per_mb} (config('videos.progress.stages')).
 */
export function uploadWeight(sizeBytes, stages) {
    const size = Number(sizeBytes);
    const sizeMb = Math.max(0, Number.isFinite(size) ? size : 0) / BYTES_PER_MB;
    const costs = STAGES.map(function (stage) {
        const cost = (stages && stages[stage]) || {};

        return Math.max(0, (Number(cost.fixed) || 0) + (Number(cost.per_mb) || 0) * sizeMb);
    });
    const total = costs.reduce(function (sum, cost) {
        return sum + cost;
    }, 0);

    if (total <= 0) {
        return 100 / STAGES.length;
    }

    return costs[0] / total * 100;
}
