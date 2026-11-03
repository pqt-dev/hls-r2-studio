import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { noticesPath, openNotices, type NoticesDeps } from './notices';

function deps(partial: Partial<NoticesDeps> = {}): NoticesDeps {
    return {
        isPackaged: false,
        resourcesPath: join('res'),
        appPath: join('app'),
        exists: () => true,
        openPath: vi.fn(() => Promise.resolve('')),
        ...partial,
    };
}

describe('notices', () => {
    it('resolves the path from resources when packaged and from the app folder in dev', () => {
        const expected = join('LICENSES', 'THIRD-PARTY-NOTICES.txt');

        expect(noticesPath(deps({ isPackaged: true }))).toBe(join('res', expected));
        expect(noticesPath(deps({ isPackaged: false }))).toBe(join('app', expected));
    });

    it('opens an existing file', async () => {
        const d = deps({ isPackaged: true });

        expect(await openNotices(d)).toBe('opened');
        expect(d.openPath).toHaveBeenCalledWith(noticesPath(d));
    });

    it('reports a missing file without trying to open it', async () => {
        const d = deps({ exists: () => false });

        expect(await openNotices(d)).toBe('not_found');
        expect(d.openPath).not.toHaveBeenCalled();
    });

    it('reports a failure when the shell returns an error or throws', async () => {
        expect(await openNotices(deps({ openPath: () => Promise.resolve('no handler') }))).toBe(
            'failed',
        );
        expect(await openNotices(deps({ openPath: () => Promise.reject(new Error('x')) }))).toBe(
            'failed',
        );
    });
});
