import { describe, expect, it } from 'vitest';
import {
    EMPTY_OUTPUT_INFO,
    parseDurationOutput,
    parseFrameRateOutput,
    parseOutputInfo,
} from './probeParse';

describe('parseDurationOutput', () => {
    it.each([
        ['12.345000\n', 12.345],
        ['  7 ', 7],
        ['1e2', 100],
        ['.5', 0.5],
    ])('parses %j', (raw, expected) => {
        expect(parseDurationOutput(raw)).toBe(expected);
    });

    it.each(['N/A', '', '0', '0.000000', '-3', 'abc', '1,5', 'Infinity'])(
        'returns null for %j',
        (raw) => {
            expect(parseDurationOutput(raw)).toBeNull();
        },
    );
});

describe('parseFrameRateOutput', () => {
    it.each([
        ['30000/1001\n', 30000 / 1001],
        ['25/1', 25],
        ['0/0', 0],
        ['30/0', 0],
        ['24', 24],
        ['', 0],
        ['N/A', 0],
    ])('parses %j', (raw, expected) => {
        expect(parseFrameRateOutput(raw)).toBeCloseTo(expected, 10);
    });
});

describe('parseOutputInfo', () => {
    const options = { segmentBytes: 1_000_000, segmentSeconds: 6 };

    it('reads all fields and rounds fps to 2 decimals and bitrate to integer kbps', () => {
        const json = JSON.stringify({
            streams: [
                {
                    codec_name: 'h264',
                    width: 1280,
                    height: 720,
                    r_frame_rate: '30000/1001',
                    bit_rate: '2345678',
                },
            ],
        });

        expect(parseOutputInfo(json, options)).toEqual({
            width: 1280,
            height: 720,
            fps: 29.97,
            bitrateKbps: 2346,
            codec: 'h264',
        });
    });

    it('falls back to the segment size when bit_rate is missing or zero', () => {
        const json = JSON.stringify({
            streams: [{ codec_name: 'h264', width: 2, height: 2, r_frame_rate: '25/1' }],
        });

        expect(parseOutputInfo(json, options).bitrateKbps).toBe(
            Math.round((1_000_000 * 8) / 1000 / 6),
        );
        expect(
            parseOutputInfo(JSON.stringify({ streams: [{ bit_rate: '0' }] }), options).bitrateKbps,
        ).toBe(1333);
    });

    it('has no fallback bitrate when the segment length is unusable', () => {
        expect(
            parseOutputInfo('{"streams":[{}]}', { segmentBytes: 5, segmentSeconds: 0 }).bitrateKbps,
        ).toBeNull();
    });

    it('returns null fps for an invalid rate', () => {
        const info = parseOutputInfo(
            JSON.stringify({ streams: [{ r_frame_rate: '0/0' }] }),
            options,
        );

        expect(info.fps).toBeNull();
    });

    it('survives empty streams and invalid JSON like PHP (bitrate fallback only)', () => {
        expect(parseOutputInfo('{"streams":[]}', options)).toEqual({
            ...EMPTY_OUTPUT_INFO,
            bitrateKbps: 1333,
        });
        expect(parseOutputInfo('not json', options)).toEqual({
            ...EMPTY_OUTPUT_INFO,
            bitrateKbps: 1333,
        });
    });
});
