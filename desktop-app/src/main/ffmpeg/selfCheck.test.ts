import { describe, expect, it } from 'vitest';
import {
    REQUIRED_FILTERS,
    checkFfmpeg,
    parseEncoderNames,
    parseFilterNames,
    parseMuxerNames,
    parseVersion,
    type FfmpegTextRunner,
} from './selfCheck';

const VERSION =
    'ffmpeg version 7.1.1-essentials_build Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc 14';

const ENCODERS = `Encoders:
 V..... = Video
 A..... = Audio
 ------
 V....D libx264              libx264 H.264 / AVC (codec h264)
 V....D libx265              libx265 H.265 / HEVC (codec hevc)
 A....D aac                  AAC (Advanced Audio Coding)
`;

const MUXERS = `File formats:
 D. = Demuxing supported
 .E = Muxing supported
 --
 D  aac             raw ADTS AAC
  E hls             Apple HTTP Live Streaming
 DE mov             QuickTime / MOV
  E mp4             MP4 (MPEG-4 Part 14)
`;

function filters(names: readonly string[]): string {
    const lines = names.map((n) => ` ... ${n.padEnd(16)} V->V       Some filter.`);

    return `Filters:\n  T.. = Timeline support\n ------\n${lines.join('\n')}\n .. movie            |->N       Read from a movie source.\n`;
}

function runnerFor(outputs: Record<string, string | null>): FfmpegTextRunner {
    return async (args) => outputs[args[1] ?? ''] ?? null;
}

const FULL = {
    '-version': VERSION,
    '-encoders': ENCODERS,
    '-muxers': MUXERS,
    '-filters': filters(REQUIRED_FILTERS.filter((f) => f !== 'movie')),
};

describe('parsers', () => {
    it('parses the version', () => {
        expect(parseVersion(VERSION)).toBe('7.1.1-essentials_build');
        expect(parseVersion('garbage')).toBeNull();
    });

    it('parses encoder, muxer and filter names', () => {
        expect(parseEncoderNames(ENCODERS).has('libx264')).toBe(true);
        expect(parseEncoderNames(ENCODERS).has('aac')).toBe(true);
        expect(parseMuxerNames(MUXERS)).toEqual(new Set(['hls', 'mov', 'mp4']));
        expect(parseFilterNames(filters(['scale', 'tile'])).has('movie')).toBe(true);
    });
});

describe('checkFfmpeg', () => {
    it('accepts a complete build', async () => {
        await expect(checkFfmpeg(runnerFor(FULL))).resolves.toEqual({
            ok: true,
            version: '7.1.1-essentials_build',
            missing: [],
        });
    });

    it('lists every missing feature', async () => {
        const result = await checkFfmpeg(
            runnerFor({
                ...FULL,
                '-encoders': ' A....D aac   AAC\n',
                '-filters': filters(['scale', 'crop']),
                '-muxers': ' DE mov  QuickTime\n',
            }),
        );

        expect(result.ok).toBe(false);
        expect(result.missing).toEqual(
            expect.arrayContaining([
                'encoder:libx264',
                'muxer:hls',
                'filter:thumbnail',
                'filter:signalstats',
                'filter:edgedetect',
                'filter:hstack',
                'filter:tile',
                'filter:fps',
            ]),
        );
        expect(result.missing).not.toContain('filter:scale');
        expect(result.missing).not.toContain('filter:movie');
        expect(result.missing).not.toContain('encoder:aac');
    });

    it('fails when ffmpeg cannot be run at all', async () => {
        const result = await checkFfmpeg(async () => null);

        expect(result.ok).toBe(false);
        expect(result.version).toBeNull();
        expect(result.missing).toContain('ffmpeg:version');
        expect(result.missing).toContain('encoder:libx264');
    });
});
