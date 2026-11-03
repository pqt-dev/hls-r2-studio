/** Parsers for ffprobe output, mirroring probeDuration / probeFps / probeOutputInfo in PHP. */

const NUMERIC = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** PHP `floatval`: the leading numeric prefix, or 0. */
function floatval(value: string): number {
    const parsed = Number.parseFloat(value);

    return Number.isFinite(parsed) ? parsed : 0;
}

/** Raw `format=duration` output -> seconds, or null when not numeric or <= 0. */
export function parseDurationOutput(raw: string): number | null {
    const trimmed = raw.trim();

    if (!NUMERIC.test(trimmed)) {
        return null;
    }

    const value = Number(trimmed);

    return Number.isFinite(value) && value > 0 ? value : null;
}

/** Raw `r_frame_rate` output (`num/den` or a plain number) -> fps; 0 when unusable (like PHP). */
export function parseFrameRateOutput(raw: string): number {
    const rate = raw.trim();

    const slash = rate.indexOf('/');

    if (slash !== -1) {
        const denominator = floatval(rate.slice(slash + 1));

        return denominator > 0 ? floatval(rate.slice(0, slash)) / denominator : 0;
    }

    return floatval(rate);
}

export interface OutputInfo {
    width: number | null;
    height: number | null;
    /** Rounded to 2 decimals. */
    fps: number | null;
    /** Integer kbps. */
    bitrateKbps: number | null;
    codec: string | null;
}

export const EMPTY_OUTPUT_INFO: OutputInfo = {
    width: null,
    height: null,
    fps: null,
    bitrateKbps: null,
    codec: null,
};

function round2(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function positiveIntOrNull(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

export interface ParseOutputInfoOptions {
    /** Size in bytes of the probed segment, used when ffprobe reports no bit_rate. */
    segmentBytes: number;
    segmentSeconds: number;
}

/**
 * Parses the `-of json` output of {@link probeOutputInfoArgs}. Callers pass EMPTY_OUTPUT_INFO
 * (instead of calling this) when ffprobe itself failed.
 */
export function parseOutputInfo(rawJson: string, options: ParseOutputInfoOptions): OutputInfo {
    let stream: Record<string, unknown> = {};

    try {
        const data: unknown = JSON.parse(rawJson);
        const streams = (data as { streams?: unknown } | null)?.streams;
        const first = Array.isArray(streams) ? (streams[0] as unknown) : undefined;

        if (typeof first === 'object' && first !== null) {
            stream = first as Record<string, unknown>;
        }
    } catch {
        // PHP keeps going with an empty stream; the bitrate fallback below still applies.
    }

    let fps: number | null = null;
    const frameRate = stream['r_frame_rate'];

    if (typeof frameRate === 'string' && frameRate.includes('/')) {
        const [num = '', den = ''] = frameRate.split('/');
        const denominator = floatval(den);

        fps = denominator > 0 ? round2(floatval(num) / denominator) : null;
    }

    let bitrateKbps: number | null = null;
    const bitRate = stream['bit_rate'];
    const bitRateNumber =
        typeof bitRate === 'string' || typeof bitRate === 'number' ? Number(bitRate) : NaN;

    if (Number.isFinite(bitRateNumber) && bitRateNumber > 0) {
        bitrateKbps = Math.round(bitRateNumber / 1000);
    } else if (options.segmentSeconds > 0) {
        bitrateKbps = Math.round((options.segmentBytes * 8) / 1000 / options.segmentSeconds);
    }

    const codec = stream['codec_name'];

    return {
        width: positiveIntOrNull(stream['width']),
        height: positiveIntOrNull(stream['height']),
        fps,
        bitrateKbps,
        codec: typeof codec === 'string' && codec !== '' ? codec : null,
    };
}
