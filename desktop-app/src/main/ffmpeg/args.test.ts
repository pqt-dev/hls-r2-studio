import { describe, expect, it } from 'vitest';
import {
    computeGop,
    detailProbeArgs,
    formatNumber,
    hstackArgs,
    maxWidthForResolution,
    probeDurationArgs,
    probeFpsArgs,
    probeOutputInfoArgs,
    SOURCE_FORMAT_WHITELIST,
    saturationProbeArgs,
    shortVideoThumbnailArgs,
    smartCropCropArgs,
    smartCropScaleArgs,
    storyboardCandidateArgs,
    storyboardTileArgs,
    storyboardTimeoutSeconds,
    thumbnailFrameArgs,
    transcodeArgs,
    transcodeTimeoutSeconds,
} from './args';

describe('probe builders', () => {
    it('probes duration', () => {
        expect(probeDurationArgs('in.mp4')).toEqual([
            '-v',
            'error',
            '-format_whitelist',
            SOURCE_FORMAT_WHITELIST,
            '-show_entries',
            'format=duration',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            'in.mp4',
        ]);
    });

    it('probes fps', () => {
        expect(probeFpsArgs('in.mp4')).toEqual([
            '-v',
            'error',
            '-format_whitelist',
            SOURCE_FORMAT_WHITELIST,
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=r_frame_rate',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
            'in.mp4',
        ]);
    });

    it('probes the output info of a segment', () => {
        expect(probeOutputInfoArgs('segment_000.ts')).toEqual([
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height,r_frame_rate,bit_rate,codec_name',
            '-of',
            'json',
            'segment_000.ts',
        ]);
    });
});

describe('source demuxer allow-list', () => {
    it('lists exactly the demuxers of the five accepted containers', () => {
        expect(SOURCE_FORMAT_WHITELIST.split(',').sort()).toEqual(
            ['3g2', '3gp', 'avi', 'm4a', 'matroska', 'mj2', 'mov', 'mp4', 'webm'].sort(),
        );
        expect(SOURCE_FORMAT_WHITELIST).not.toMatch(/hls|concat|http|file/);
    });

    it('is an input option (before -i) on every command that reads the source file', () => {
        const commands = [
            transcodeArgs({
                input: 'in.mp4',
                resolution: '720',
                segmentSeconds: 6,
                fps: null,
                outputFps: 25,
            }),
            thumbnailFrameArgs('in.mp4', 1, 'o.jpg'),
            shortVideoThumbnailArgs('in.mp4', 2),
            storyboardCandidateArgs({ input: 'in.mp4', duration: 10 }),
        ];

        for (const args of commands) {
            const flag = args.indexOf('-format_whitelist');

            expect(flag).toBeGreaterThan(-1);
            expect(args[flag + 1]).toBe(SOURCE_FORMAT_WHITELIST);
            expect(flag).toBeLessThan(args.indexOf('-i'));
        }

        for (const args of [probeDurationArgs('in.mp4'), probeFpsArgs('in.mp4')]) {
            expect(args.indexOf('-format_whitelist')).toBeGreaterThan(-1);
            expect(args.indexOf('-format_whitelist')).toBeLessThan(args.length - 1);
            expect(args[args.length - 1]).toBe('in.mp4');
        }
    });

    it('is not added to commands that only read our own generated files', () => {
        expect(probeOutputInfoArgs('segment_000.ts')).not.toContain('-format_whitelist');
        expect(storyboardTileArgs(3)).not.toContain('-format_whitelist');
        expect(saturationProbeArgs('a.jpg')).not.toContain('-format_whitelist');
    });
});

describe('transcodeArgs', () => {
    it('builds the default command (no -r, no threads)', () => {
        expect(
            transcodeArgs({
                input: 'C:\\v\\in.mp4',
                resolution: '720',
                segmentSeconds: 6,
                fps: null,
                outputFps: 29.97,
            }),
        ).toEqual([
            '-y',
            '-format_whitelist',
            SOURCE_FORMAT_WHITELIST,
            '-i',
            'C:\\v\\in.mp4',
            '-vf',
            "scale='min(1280,iw)':-2",
            '-c:v',
            'libx264',
            '-preset',
            'veryfast',
            '-crf',
            '23',
            '-g',
            '180',
            '-keyint_min',
            '180',
            '-sc_threshold',
            '0',
            '-c:a',
            'aac',
            '-b:a',
            '128k',
            '-hls_time',
            '6',
            '-hls_playlist_type',
            'vod',
            '-hls_segment_filename',
            'segment_%03d.ts',
            '-progress',
            'pipe:1',
            '-nostats',
            'playlist.m3u8',
        ]);
    });

    it('adds -r only when fps is configured, before the audio options', () => {
        const args = transcodeArgs({
            input: 'a.mp4',
            resolution: '480',
            segmentSeconds: 4,
            fps: 24,
            outputFps: 24,
        });
        const r = args.indexOf('-r');

        expect(args.slice(r, r + 3)).toEqual(['-r', '24', '-c:a']);
        expect(args).toContain("scale='min(854,iw)':-2");
        expect(args.slice(args.indexOf('-g'), args.indexOf('-g') + 2)).toEqual(['-g', '96']);
    });

    it('adds optional thread limits right after -sc_threshold', () => {
        const args = transcodeArgs({
            input: 'a.mp4',
            resolution: '1080',
            segmentSeconds: 6,
            fps: 30,
            outputFps: 30,
            threads: 4,
        });
        const i = args.indexOf('-sc_threshold');

        expect(args.slice(i, i + 5)).toEqual(['-sc_threshold', '0', '-threads', '4', '-r']);
        expect(args).toContain("scale='min(1920,iw)':-2");
    });

    it('ignores a zero thread count', () => {
        expect(
            transcodeArgs({
                input: 'a.mp4',
                resolution: '720',
                segmentSeconds: 6,
                fps: null,
                outputFps: 30,
                threads: 0,
            }),
        ).not.toContain('-threads');
    });
});

describe('transcode helpers', () => {
    it.each([
        ['480', 854],
        ['720', 1280],
        ['1080', 1920],
        [720, 1280],
        ['360', 1280],
        ['', 1280],
        ['abc', 1280],
    ])('maps resolution %j to %i px', (resolution, width) => {
        expect(maxWidthForResolution(resolution)).toBe(width);
    });

    it.each([
        [30, 6, 180],
        [29.97, 6, 180],
        [23.976, 6, 144],
        [25, 4, 100],
        [0, 6, 1],
        [0.01, 2, 1],
        [59.94, 2.5, 150],
    ])('gop(%d fps, %d s) = %d', (fps, seconds, gop) => {
        expect(computeGop(fps, seconds)).toBe(gop);
    });

    it('rounds half away from zero like PHP for positive values', () => {
        expect(computeGop(2.5, 1)).toBe(3);
        expect(computeGop(0.5, 1)).toBe(1);
    });

    it.each([
        [null, 172800],
        [0, 600],
        [10, 600],
        [75, 600],
        [75.1, 601],
        [3600, 28800],
        [3600.2, 28802],
    ])('transcode timeout for duration %j = %i s', (duration, seconds) => {
        expect(transcodeTimeoutSeconds(duration)).toBe(seconds);
    });

    it.each([
        [1, 60],
        [30, 60],
        [31, 62],
        [100.2, 201],
        [3600, 7200],
    ])('storyboard timeout for duration %j = %i s', (duration, seconds) => {
        expect(storyboardTimeoutSeconds(duration)).toBe(seconds);
    });

    it('formats numbers like PHP precision 14', () => {
        expect(formatNumber(12)).toBe('12');
        expect(formatNumber(12.5)).toBe('12.5');
        expect(formatNumber(1 / 3)).toBe('0.33333333333333');
        expect(formatNumber(0.1 + 0.2)).toBe('0.3');
        expect(formatNumber(0)).toBe('0');
    });
});

describe('thumbnail builders', () => {
    it('extracts a candidate frame', () => {
        expect(thumbnailFrameArgs('in.mp4', 12.5, 'thumb_candidate_0.jpg')).toEqual([
            '-y',
            '-ss',
            '12.5',
            '-format_whitelist',
            SOURCE_FORMAT_WHITELIST,
            '-i',
            'in.mp4',
            '-vf',
            'thumbnail=24',
            '-frames:v',
            '1',
            'thumb_candidate_0.jpg',
        ]);
    });

    it('extracts the single frame for short videos at duration / 2', () => {
        expect(shortVideoThumbnailArgs('in.mp4', 2)).toEqual([
            '-y',
            '-ss',
            '1',
            '-format_whitelist',
            SOURCE_FORMAT_WHITELIST,
            '-i',
            'in.mp4',
            '-vf',
            'thumbnail=24',
            '-frames:v',
            '1',
            'thumbnail.jpg',
        ]);
        expect(shortVideoThumbnailArgs('in.mp4', null)[2]).toBe('0');
    });

    it('measures saturation and detail through lavfi movie=', () => {
        expect(saturationProbeArgs('thumb_candidate_0.jpg')).toEqual([
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'movie=thumb_candidate_0.jpg,signalstats',
            '-show_entries',
            'frame_tags=lavfi.signalstats.SATAVG',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
        ]);
        expect(detailProbeArgs('candidate_0001.jpg')).toEqual([
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'movie=candidate_0001.jpg,edgedetect,signalstats',
            '-show_entries',
            'frame_tags=lavfi.signalstats.YAVG',
            '-of',
            'default=noprint_wrappers=1:nokey=1',
        ]);
    });

    it.each([
        'C:\\tmp\\a.jpg',
        'dir/a.jpg',
        "a'b.jpg",
        'a b.jpg',
        'a,b.jpg',
        'a:b.jpg',
        '',
        'é.jpg',
        'a;b.jpg',
    ])('refuses an unsafe lavfi file name %j', (name) => {
        expect(() => saturationProbeArgs(name)).toThrow(/Unsafe file name/);
        expect(() => detailProbeArgs(name)).toThrow(/Unsafe file name/);
    });

    it('builds the smart-crop scale and crop steps', () => {
        expect(smartCropScaleArgs('a.jpg', 'b.jpg', 360, 1080)).toEqual([
            '-y',
            '-i',
            'a.jpg',
            '-vf',
            'scale=360:1080:force_original_aspect_ratio=increase',
            '-frames:v',
            '1',
            'b.jpg',
        ]);
        expect(smartCropCropArgs('b.jpg', 'c.jpg', 360, 1080, 12, 0)).toEqual([
            '-y',
            '-i',
            'b.jpg',
            '-vf',
            'crop=360:1080:12:0',
            '-frames:v',
            '1',
            'c.jpg',
        ]);
    });

    it('joins three columns with hstack', () => {
        expect(hstackArgs(['c0.jpg', 'c1.jpg', 'c2.jpg'], 'thumbnail.jpg')).toEqual([
            '-y',
            '-i',
            'c0.jpg',
            '-i',
            'c1.jpg',
            '-i',
            'c2.jpg',
            '-filter_complex',
            '[0:v][1:v][2:v]hstack=inputs=3[v]',
            '-map',
            '[v]',
            '-frames:v',
            '1',
            'thumbnail.jpg',
        ]);
    });
});

describe('storyboard builders', () => {
    it('extracts the 75 candidates in one pass', () => {
        expect(storyboardCandidateArgs({ input: 'in.mp4', duration: 120.5 })).toEqual([
            '-y',
            '-format_whitelist',
            SOURCE_FORMAT_WHITELIST,
            '-i',
            'in.mp4',
            '-vf',
            "fps=75/120.5,crop='min(iw\\,ih)':'min(iw\\,ih)',scale=160:160",
            '-frames:v',
            '75',
            '-start_number',
            '0',
            'candidate_%04d.jpg',
        ]);
    });

    it('puts the optional thread limit before -start_number', () => {
        const args = storyboardCandidateArgs({ input: 'in.mp4', duration: 60, threads: 2 });
        const i = args.indexOf('-threads');

        expect(args.slice(i, i + 3)).toEqual(['-threads', '2', '-start_number']);
    });

    it('tiles a grid', () => {
        expect(storyboardTileArgs(4)).toEqual([
            '-y',
            '-start_number',
            '0',
            '-i',
            'tile_4x4_%04d.jpg',
            '-vf',
            'tile=4x4',
            '-frames:v',
            '1',
            'storyboard_4x4.jpg',
        ]);
    });
});
