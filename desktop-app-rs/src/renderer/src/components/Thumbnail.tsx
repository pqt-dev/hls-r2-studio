import { useState } from 'react';

/**
 * Square thumbnail, like the site's video table: a fixed square box, the image fills it
 * (`object-fit: cover`) and never depends on the video's width or height. The box size comes from
 * the context (CSS: card width in the grid, a small fixed size in rows). Without a URL, or when the
 * image fails to load, a "No thumbnail" placeholder is shown.
 */
export function Thumbnail({
    url,
    onFailed,
}: {
    url: string | null;
    /** Ignored: kept so older call sites that still pass the video size keep compiling. */
    width?: number | null;
    height?: number | null;
    /** Called once when the image fails to load. */
    onFailed?: () => void;
}) {
    const [failed, setFailed] = useState(false);

    if (url === null || failed) {
        return (
            <div className="thumb-frame thumb-placeholder" aria-hidden="true">
                <span>No thumbnail</span>
            </div>
        );
    }

    return (
        <div className="thumb-frame">
            <img
                className="thumb"
                src={url}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => {
                    setFailed(true);
                    onFailed?.();
                }}
            />
        </div>
    );
}
