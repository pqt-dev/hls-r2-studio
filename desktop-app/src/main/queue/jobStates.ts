/** Job state groups and the translation key of each state label. */
import type { JobState } from '../../shared/types';

export const RUNNING_STATES: readonly JobState[] = [
    'transcoding',
    'thumbnail',
    'storyboard',
    'uploading',
    'registering',
];

/** Terminal states: the job can be removed from the list (and retried, except `done`). */
export const FINAL_STATES: readonly JobState[] = ['done', 'failed', 'cancelled', 'interrupted'];

/** Files are on R2 but registering did not finish. */
export const ATTENTION_STATES: readonly JobState[] = ['register_failed', 'needs_sign_in'];

/** Upload paused: temp files are kept on disk until Resume / Start over / Remove. */
export const PAUSED_UPLOAD_STATE: JobState = 'upload_interrupted';

export const RETRYABLE_STATES: readonly JobState[] = ['failed', 'cancelled', 'interrupted'];

export function isRunningState(state: JobState): boolean {
    return RUNNING_STATES.includes(state);
}

export function isFinalState(state: JobState): boolean {
    return FINAL_STATES.includes(state);
}

export function isAttentionState(state: JobState): boolean {
    return ATTENTION_STATES.includes(state);
}

export function isPausedUpload(state: JobState): boolean {
    return state === PAUSED_UPLOAD_STATE;
}

export const STAGE_KEYS: Record<JobState, string> = {
    waiting: 'job.state.waiting',
    transcoding: 'job.state.transcoding',
    thumbnail: 'job.state.thumbnail',
    storyboard: 'job.state.storyboard',
    uploading: 'job.state.uploading',
    registering: 'job.state.registering',
    done: 'job.state.done',
    failed: 'job.state.failed',
    cancelled: 'job.state.cancelled',
    interrupted: 'job.state.interrupted',
    register_failed: 'job.state.register_failed',
    needs_sign_in: 'job.state.needs_sign_in',
    upload_interrupted: 'job.state.upload_interrupted',
};
