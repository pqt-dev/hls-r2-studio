import { describe, expect, it } from 'vitest';
import { planKill } from './killTree';

describe('planKill', () => {
    it('uses taskkill /T /F on Windows', () => {
        expect(planKill('win32', 4321, { SystemRoot: 'D:\\WINNT' })).toEqual({
            kind: 'spawn',
            command: 'D:\\WINNT\\System32\\taskkill.exe',
            args: ['/PID', '4321', '/T', '/F'],
        });
    });

    it('falls back to C:\\Windows when SystemRoot is not set', () => {
        expect(planKill('win32', 1, {})).toMatchObject({
            command: 'C:\\Windows\\System32\\taskkill.exe',
        });
    });

    it.each<NodeJS.Platform>(['darwin', 'linux'])(
        'signals the negative pid (process group) on %s',
        (platform) => {
            expect(planKill(platform, 4321)).toEqual({
                kind: 'signal-group',
                pid: -4321,
                signal: 'SIGKILL',
            });
        },
    );
});
