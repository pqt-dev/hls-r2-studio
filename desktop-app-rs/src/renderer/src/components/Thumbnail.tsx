import { useState } from 'react';

/** The image falls back to a placeholder when there is no URL or it fails to load. */
export function Thumbnail({ url }: { url: string | null }) {
    const [failed, setFailed] = useState(false);

    if (url === null || failed) {
        return (
            <div className="thumb thumb-placeholder" aria-hidden="true">
                No preview
            </div>
        );
    }

    return (
        <img className="thumb" src={url} alt="" loading="lazy" onError={() => setFailed(true)} />
    );
}
