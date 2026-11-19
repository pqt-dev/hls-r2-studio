import { useState } from 'react';
import { VideoFileIcon } from './icons';
import { Thumbnail } from './Thumbnail';

/**
 * Leading visual of a job row: the video's thumbnail when its URL is known, else a neutral media
 * icon tile.
 */
export function MediaTile({ thumbnailUrl = null }: { thumbnailUrl?: string | null }) {
    // The image failed to load (404, deleted video): back to the neutral icon tile. Remembered per
    // URL, so a new URL gets a fresh try.
    const [failedUrl, setFailedUrl] = useState<string | null>(null);

    if (thumbnailUrl !== null && failedUrl !== thumbnailUrl) {
        return (
            <span className="media-tile">
                <Thumbnail
                    key={thumbnailUrl}
                    url={thumbnailUrl}
                    onFailed={() => setFailedUrl(thumbnailUrl)}
                />
            </span>
        );
    }

    return (
        <span className="media-tile" aria-hidden="true">
            <VideoFileIcon />
        </span>
    );
}
