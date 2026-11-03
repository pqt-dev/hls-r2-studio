import { describe, expect, it } from 'vitest';
import { resolveBinaries } from './binaries';

describe('resolveBinaries', () => {
    it('uses absolute bundled paths on Windows when packaged', () => {
        expect(
            resolveBinaries({
                platform: 'win32',
                resourcesPath: 'C:\\Users\\Me\\AppData\\Local\\Programs\\App\\resources',
                env: { FFMPEG_PATH: 'D:\\other\\ffmpeg.exe' },
                isPackaged: true,
            }),
        ).toEqual({
            ffmpeg: 'C:\\Users\\Me\\AppData\\Local\\Programs\\App\\resources\\bin\\ffmpeg.exe',
            ffprobe: 'C:\\Users\\Me\\AppData\\Local\\Programs\\App\\resources\\bin\\ffprobe.exe',
        });
    });

    it('uses bin/ffmpeg without a suffix on POSIX when packaged and ignores env', () => {
        expect(
            resolveBinaries({
                platform: 'darwin',
                resourcesPath: '/Applications/App.app/Contents/Resources',
                env: { FFMPEG_PATH: '/x/ffmpeg', FFPROBE_PATH: '/x/ffprobe' },
                isPackaged: true,
            }),
        ).toEqual({
            ffmpeg: '/Applications/App.app/Contents/Resources/bin/ffmpeg',
            ffprobe: '/Applications/App.app/Contents/Resources/bin/ffprobe',
        });
    });

    it('prefers the env overrides in development', () => {
        expect(
            resolveBinaries({
                platform: 'linux',
                resourcesPath: '/unused',
                env: { FFMPEG_PATH: '/opt/ff/ffmpeg', FFPROBE_PATH: '/opt/ff/ffprobe' },
                isPackaged: false,
            }),
        ).toEqual({ ffmpeg: '/opt/ff/ffmpeg', ffprobe: '/opt/ff/ffprobe' });
    });

    it('falls back to bare names (PATH) in development', () => {
        expect(
            resolveBinaries({ platform: 'linux', resourcesPath: '', env: {}, isPackaged: false }),
        ).toEqual({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' });
        expect(
            resolveBinaries({
                platform: 'win32',
                resourcesPath: '',
                env: { FFMPEG_PATH: '  ' },
                isPackaged: false,
            }),
        ).toEqual({ ffmpeg: 'ffmpeg.exe', ffprobe: 'ffprobe.exe' });
    });
});
