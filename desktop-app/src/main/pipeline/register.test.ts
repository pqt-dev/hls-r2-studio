import { describe, expect, it } from 'vitest';
import { EMPTY_OUTPUT_INFO } from '../ffmpeg/probeParse';
import {
    REGISTER_RETRY_DELAYS_MS,
    buildRegisterPayload,
    mapRegisterError,
    validatePrefixLength,
    validateRegisterPayload,
    type BuildRegisterPayloadInput,
    type RegisterPayload,
} from './register';

const PREFIX = '2026/03/05/my-video-ab12cd34ef56/';

function input(overrides: Partial<BuildRegisterPayloadInput> = {}): BuildRegisterPayloadInput {
    return {
        publicId: 'ab12cd34ef56',
        prefix: PREFIX,
        originalFilename: 'My Video.final.mp4',
        originalSizeBytes: 123456789,
        duration: 61.234,
        hasThumbnail: true,
        storyboardGrids: [3, 4, 5],
        output: { width: 1280, height: 720, fps: 29.97003, bitrateKbps: 2345.6, codec: 'h264' },
        ...overrides,
    };
}

describe('buildRegisterPayload', () => {
    it('builds the exact body of POST /api/app/videos', () => {
        expect(buildRegisterPayload(input())).toEqual({
            public_id: 'ab12cd34ef56',
            title: 'My Video.final',
            original_filename: 'My Video.final.mp4',
            original_size_bytes: 123456789,
            disk_prefix: PREFIX,
            playlist_path: `${PREFIX}playlist.m3u8`,
            thumbnail_path: `${PREFIX}thumbnail.jpg`,
            storyboards: {
                '3x3': { path: `${PREFIX}storyboard_3x3.jpg` },
                '4x4': { path: `${PREFIX}storyboard_4x4.jpg` },
                '5x5': { path: `${PREFIX}storyboard_5x5.jpg` },
            },
            duration: 61.234,
            output_width: 1280,
            output_height: 720,
            output_fps: 29.97,
            output_bitrate_kbps: 2346,
            output_codec: 'h264',
        });
    });

    it('uses null for missing thumbnail, storyboards, duration and output info', () => {
        const payload = buildRegisterPayload(
            input({ hasThumbnail: false, storyboardGrids: [], duration: null, output: null }),
        );

        expect(payload.thumbnail_path).toBeNull();
        expect(payload.storyboards).toBeNull();
        expect(payload.duration).toBeNull();
        expect(payload).toMatchObject({
            output_width: null,
            output_height: null,
            output_fps: null,
            output_bitrate_kbps: null,
            output_codec: null,
        });
        expect(buildRegisterPayload(input({ output: EMPTY_OUTPUT_INFO })).output_codec).toBeNull();
    });

    it('serializes storyboards that exist only', () => {
        expect(
            Object.keys(buildRegisterPayload(input({ storyboardGrids: [4] })).storyboards ?? {}),
        ).toEqual(['4x4']);
    });

    it('falls back to the file name when the base name is empty', () => {
        expect(buildRegisterPayload(input({ originalFilename: '.hidden' })).title).toBe('.hidden');
    });

    it('trims the title like the server middleware would', () => {
        expect(buildRegisterPayload(input({ originalFilename: '  spaced  .mp4' })).title).toBe(
            'spaced',
        );
    });
});

describe('validateRegisterPayload', () => {
    const valid = (): RegisterPayload => buildRegisterPayload(input());

    it('accepts a payload from buildRegisterPayload (with and without optional parts)', () => {
        expect(validateRegisterPayload(valid())).toEqual([]);
        expect(
            validateRegisterPayload(
                buildRegisterPayload(
                    input({
                        hasThumbnail: false,
                        storyboardGrids: [],
                        duration: null,
                        output: null,
                    }),
                ),
            ),
        ).toEqual([]);
    });

    it.each<[string, (p: RegisterPayload) => void, RegExp]>([
        [
            'bad public id',
            (p) => {
                p.public_id = 'short';
            },
            /public_id/,
        ],
        [
            'empty title',
            (p) => {
                p.title = '  ';
            },
            /title/,
        ],
        [
            'long title',
            (p) => {
                p.title = 'x'.repeat(256);
            },
            /title/,
        ],
        [
            'long filename',
            (p) => {
                p.original_filename = 'x'.repeat(256);
            },
            /original_filename/,
        ],
        [
            'zero size',
            (p) => {
                p.original_size_bytes = 0;
            },
            /original_size_bytes/,
        ],
        [
            'fractional size',
            (p) => {
                p.original_size_bytes = 1.5;
            },
            /original_size_bytes/,
        ],
        [
            'prefix for another id',
            (p) => {
                p.disk_prefix = '2026/03/05/x-zzzzzzzzzzzz/';
            },
            /disk_prefix/,
        ],
        [
            'wrong playlist path',
            (p) => {
                p.playlist_path = 'other/playlist.m3u8';
            },
            /playlist_path/,
        ],
        [
            'wrong thumbnail path',
            (p) => {
                p.thumbnail_path = `${PREFIX}thumb.jpg`;
            },
            /thumbnail_path/,
        ],
        [
            'unknown storyboard key',
            (p) => {
                p.storyboards = { '2x2': { path: `${PREFIX}storyboard_2x2.jpg` } };
            },
            /storyboards/,
        ],
        [
            'wrong storyboard path',
            (p) => {
                p.storyboards = { '3x3': { path: `${PREFIX}storyboard_4x4.jpg` } };
            },
            /storyboards/,
        ],
        [
            'extra storyboard field',
            (p) => {
                p.storyboards = {
                    '3x3': { path: `${PREFIX}storyboard_3x3.jpg`, extra: 1 } as { path: string },
                };
            },
            /storyboards/,
        ],
        [
            'negative duration',
            (p) => {
                p.duration = -1;
            },
            /duration/,
        ],
        [
            'NaN duration',
            (p) => {
                p.duration = Number.NaN;
            },
            /duration/,
        ],
        [
            'zero width',
            (p) => {
                p.output_width = 0;
            },
            /output_width/,
        ],
        [
            'huge height',
            (p) => {
                p.output_height = 70000;
            },
            /output_height/,
        ],
        [
            'fps too high',
            (p) => {
                p.output_fps = 1000;
            },
            /output_fps/,
        ],
        [
            'negative bitrate',
            (p) => {
                p.output_bitrate_kbps = -1;
            },
            /output_bitrate_kbps/,
        ],
        [
            'fractional bitrate',
            (p) => {
                p.output_bitrate_kbps = 10.5;
            },
            /output_bitrate_kbps/,
        ],
        [
            'long codec',
            (p) => {
                p.output_codec = 'c'.repeat(21);
            },
            /output_codec/,
        ],
    ])('rejects: %s', (_name, mutate, pattern) => {
        const payload = valid();

        mutate(payload);

        const errors = validateRegisterPayload(payload);

        expect(errors.length).toBeGreaterThan(0);
        expect(errors.some((e) => pattern.test(e))).toBe(true);
    });

    it('accepts paths of exactly 255 characters and rejects 256', () => {
        const id = 'ab12cd34ef56';
        // prefix = 11 + slug + 1 + 12 + 1; longest key adds 18 ("storyboard_5x5.jpg").
        const prefixFor = (slugLength: number) => `2026/03/05/${'a'.repeat(slugLength)}-${id}/`;
        const build = (slugLength: number) =>
            buildRegisterPayload(input({ prefix: prefixFor(slugLength), publicId: id }));

        // 25 + slug + 18 = 255 -> slug 212 fits; 213 does not.
        expect(validateRegisterPayload(build(212))).toEqual([]);
        expect(validateRegisterPayload(build(213)).join(' ')).toMatch(/255 characters/);
        expect(validatePrefixLength(prefixFor(212))).toEqual([]);
        expect(validatePrefixLength(prefixFor(213)).join(' ')).toMatch(/too long/);
    });

    it('rejects an over-long disk_prefix, playlist_path or thumbnail_path', () => {
        const payload = valid();

        payload.playlist_path = `${PREFIX}${'x'.repeat(300)}`;

        expect(validateRegisterPayload(payload).join(' ')).toMatch(/at most 255 characters/);
    });

    it('counts characters, not bytes, for the 255 limit', () => {
        const payload = valid();

        payload.title = 'Đ'.repeat(255);

        expect(validateRegisterPayload(payload)).toEqual([]);
    });
});

describe('mapRegisterError', () => {
    it('retries network failures', () => {
        expect(mapRegisterError({ kind: 'network' })).toMatchObject({
            retryable: true,
            needsSignIn: false,
        });
    });

    it.each([500, 502, 503, 504])('retries HTTP %i', (status) => {
        expect(mapRegisterError({ kind: 'http', status })).toMatchObject({
            retryable: true,
            needsSignIn: false,
        });
    });

    it('explains storage_unavailable', () => {
        const info = mapRegisterError({
            kind: 'http',
            status: 503,
            errorCode: 'storage_unavailable',
        });

        expect(info.retryable).toBe(true);
        expect(info.userMessage).toMatch(/R2/);
    });

    it('retries HTTP 429 with the normal backoff when there is no Retry-After', () => {
        expect(mapRegisterError({ kind: 'http', status: 429 })).toMatchObject({
            retryable: true,
            retryAfterMs: null,
            needsSignIn: false,
        });
    });

    it('honors a numeric Retry-After on HTTP 429 (capped at 60 s)', () => {
        const wait = (retryAfterSeconds: number | null) =>
            mapRegisterError({ kind: 'http', status: 429, retryAfterSeconds }).retryAfterMs;

        expect(wait(3)).toBe(3000);
        expect(wait(0.5)).toBe(500);
        expect(wait(9999)).toBe(60000);
        expect(wait(-1)).toBeNull();
        expect(wait(Number.NaN)).toBeNull();
        expect(wait(null)).toBeNull();
    });

    it('ignores Retry-After for other statuses', () => {
        expect(
            mapRegisterError({ kind: 'http', status: 503, retryAfterSeconds: 5 }).retryAfterMs,
        ).toBeNull();
    });

    it('asks for sign-in on 401 without retrying', () => {
        expect(mapRegisterError({ kind: 'http', status: 401 })).toMatchObject({
            retryable: false,
            needsSignIn: true,
        });
    });

    it.each([
        [409, 'public_id_conflict', /different video/],
        [422, 'playlist_not_found', /playlist/],
    ])('treats HTTP %i (%s) as definitive', (status, errorCode, message) => {
        const info = mapRegisterError({ kind: 'http', status, errorCode });

        expect(info).toMatchObject({ retryable: false, needsSignIn: false, definitive: true });
        expect(info.userMessage).toMatch(message);
    });

    it.each([
        [409, undefined, /conflict/],
        [409, 'something_else', /conflict/],
        [422, undefined, /invalid/],
        [422, 'validation_failed', /invalid/],
        [422, 'public_id_conflict', /invalid/],
        [409, 'playlist_not_found', /conflict/],
    ])('keeps the upload on generic HTTP %i (%s)', (status, errorCode, message) => {
        const info = mapRegisterError({ kind: 'http', status, errorCode });

        expect(info).toMatchObject({ retryable: false, needsSignIn: false, definitive: false });
        expect(info.userMessage).toMatch(message);
    });

    it.each([400, 403, 404, 405, 413])('keeps the upload on HTTP %i (not definitive)', (status) => {
        const info = mapRegisterError({ kind: 'http', status });

        expect(info).toMatchObject({ retryable: false, needsSignIn: false, definitive: false });
        expect(info.userMessage).toMatch(new RegExp(`HTTP ${status}`));
    });

    it('never marks retryable, 401 or network outcomes as definitive', () => {
        expect(mapRegisterError({ kind: 'network' }).definitive).toBe(false);
        expect(mapRegisterError({ kind: 'http', status: 503 }).definitive).toBe(false);
        expect(mapRegisterError({ kind: 'http', status: 429 }).definitive).toBe(false);
        expect(mapRegisterError({ kind: 'http', status: 401 }).definitive).toBe(false);
    });

    it('uses the 1, 2, 4, 8, 16 s backoff', () => {
        expect(REGISTER_RETRY_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 16000]);
    });
});
