/**
 * Incremental parser for the `-progress pipe:1` stream (`key=value` lines, blocks ended by a
 * `progress=continue|end` line). Chunks may split lines and keys anywhere.
 */

export interface ProgressUpdate {
    /** Latest out_time (seconds) found in the completed lines of this feed, or null. */
    outTimeSeconds: number | null;
    /** True once `progress=end` has been seen (sticky). */
    ended: boolean;
}

export interface ProgressParser {
    feed(chunk: string): ProgressUpdate;
    /** Processes a trailing line that had no newline (call when the stream closes). */
    flush(): ProgressUpdate;
}

const OUT_TIME_US = /^out_time_us=(\d+)$/;
const OUT_TIME_MS = /^out_time_ms=(\d+)$/;

export function createProgressParser(): ProgressParser {
    let buffer = '';
    let ended = false;
    // out_time_ms (really microseconds) is only a fallback when the same block has no out_time_us.
    let blockHasUs = false;

    function processLine(line: string, state: { latest: number | null }): void {
        const us = OUT_TIME_US.exec(line);

        if (us?.[1] !== undefined) {
            blockHasUs = true;
            state.latest = Number(us[1]) / 1e6;

            return;
        }

        const ms = OUT_TIME_MS.exec(line);

        if (ms?.[1] !== undefined) {
            if (!blockHasUs) {
                state.latest = Number(ms[1]) / 1e6;
            }

            return;
        }

        if (line.startsWith('progress=')) {
            blockHasUs = false;

            if (line === 'progress=end') {
                ended = true;
            }
        }
    }

    function drain(lines: string[]): ProgressUpdate {
        const state: { latest: number | null } = { latest: null };

        for (const line of lines) {
            processLine(line.trim(), state);
        }

        return { outTimeSeconds: state.latest, ended };
    }

    return {
        feed(chunk: string): ProgressUpdate {
            buffer += chunk;
            const parts = buffer.split('\n');
            buffer = parts.pop() ?? '';

            return drain(parts);
        },
        flush(): ProgressUpdate {
            const rest = buffer;
            buffer = '';

            return drain(rest === '' ? [] : [rest]);
        },
    };
}

/**
 * Fraction of the transcode done, clamped to [0, 1] and never below `previous`.
 * Null when the duration is unknown (null or <= 0).
 */
export function toFraction(
    outTimeSeconds: number,
    duration: number | null,
    previous = 0,
): number | null {
    if (duration === null || !(duration > 0)) {
        return null;
    }

    const raw = Number.isFinite(outTimeSeconds) ? outTimeSeconds / duration : 0;
    const clamped = Math.min(1, Math.max(0, raw));

    return Math.max(previous, clamped);
}
