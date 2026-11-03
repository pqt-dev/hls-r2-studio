import { describe, expect, it } from 'vitest';
import { createProgressParser, toFraction } from './progress';

const BLOCK_1 =
    'frame=10\nfps=0.0\nout_time_us=1500000\nout_time_ms=1500000\nout_time=00:00:01.500000\nprogress=continue\n';
const BLOCK_2 = 'out_time_us=3000000\nout_time_ms=3000000\nprogress=continue\n';
const END = 'out_time_us=9000000\nprogress=end\n';

describe('createProgressParser', () => {
    it('parses a whole block', () => {
        const parser = createProgressParser();

        expect(parser.feed(BLOCK_1)).toEqual({ outTimeSeconds: 1.5, ended: false });
    });

    it('returns the latest value when a chunk holds several blocks', () => {
        const parser = createProgressParser();

        expect(parser.feed(BLOCK_1 + BLOCK_2).outTimeSeconds).toBe(3);
    });

    it('buffers lines and keys split across chunks, at every possible boundary', () => {
        const stream = BLOCK_1 + BLOCK_2 + END;

        for (let cut = 1; cut < stream.length; cut++) {
            const parser = createProgressParser();
            const first = parser.feed(stream.slice(0, cut));
            const second = parser.feed(stream.slice(cut));
            const latest = second.outTimeSeconds ?? first.outTimeSeconds;

            expect(latest).toBe(9);
            expect(second.ended).toBe(true);
        }
    });

    it('does not emit a value from an unfinished line', () => {
        const parser = createProgressParser();

        expect(parser.feed('out_time_us=12').outTimeSeconds).toBeNull();
        expect(parser.feed('00000\n').outTimeSeconds).toBe(1.2);
    });

    it('works one character at a time', () => {
        const parser = createProgressParser();
        let latest: number | null = null;
        let ended = false;

        for (const ch of BLOCK_1 + END) {
            const update = parser.feed(ch);
            latest = update.outTimeSeconds ?? latest;
            ended = update.ended;
        }

        expect(latest).toBe(9);
        expect(ended).toBe(true);
    });

    it('falls back to out_time_ms (really microseconds) when out_time_us is absent', () => {
        const parser = createProgressParser();

        expect(parser.feed('out_time_ms=2500000\nprogress=continue\n').outTimeSeconds).toBe(2.5);
    });

    it('prefers out_time_us within a block, also when out_time_ms comes first', () => {
        const parser = createProgressParser();

        expect(
            parser.feed('out_time_ms=1\nout_time_us=2000000\nprogress=continue\n').outTimeSeconds,
        ).toBe(2);
        // Next block has only ms again: the fallback applies again.
        expect(parser.feed('out_time_ms=4000000\nprogress=continue\n').outTimeSeconds).toBe(4);
    });

    it('ignores N/A and negative values', () => {
        const parser = createProgressParser();

        expect(
            parser.feed('out_time_us=N/A\nout_time_ms=N/A\nout_time=N/A\nprogress=continue\n'),
        ).toEqual({ outTimeSeconds: null, ended: false });
        expect(
            parser.feed('out_time_us=-9223372036854775808\nprogress=continue\n').outTimeSeconds,
        ).toBeNull();
    });

    it('handles CRLF line endings and unrelated keys', () => {
        const parser = createProgressParser();

        expect(
            parser.feed('bitrate=N/A\r\nout_time_us=1000000\r\nprogress=continue\r\n')
                .outTimeSeconds,
        ).toBe(1);
    });

    it('detects progress=end and keeps it sticky', () => {
        const parser = createProgressParser();

        expect(parser.feed('progress=end\n').ended).toBe(true);
        expect(parser.feed('frame=1\n').ended).toBe(true);
    });

    it('flush() processes a final line without newline', () => {
        const parser = createProgressParser();

        parser.feed('out_time_us=5000000');

        expect(parser.flush()).toEqual({ outTimeSeconds: 5, ended: false });
        expect(parser.flush()).toEqual({ outTimeSeconds: null, ended: false });
    });

    it('flush() can complete progress=end', () => {
        const parser = createProgressParser();

        parser.feed('progress=end');

        expect(parser.flush().ended).toBe(true);
    });
});

describe('toFraction', () => {
    it('divides by the duration', () => {
        expect(toFraction(15, 60)).toBe(0.25);
    });

    it('clamps to [0, 1]', () => {
        expect(toFraction(90, 60)).toBe(1);
        expect(toFraction(-5, 60)).toBe(0);
    });

    it('never goes below the previous value', () => {
        expect(toFraction(10, 100, 0.5)).toBe(0.5);
        expect(toFraction(60, 100, 0.5)).toBe(0.6);
    });

    it.each([null, 0, -1, Number.NaN])('returns null for duration %j', (duration) => {
        expect(toFraction(10, duration)).toBeNull();
    });

    it('treats a non-finite out time as no progress', () => {
        expect(toFraction(Number.NaN, 10, 0.3)).toBe(0.3);
    });
});
