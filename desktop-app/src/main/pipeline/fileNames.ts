/** Fixed names of the files the pipeline produces inside a job's temp directory. */
export const PLAYLIST_FILE = 'playlist.m3u8';
export const SEGMENT_PATTERN = 'segment_%03d.ts';
export const THUMBNAIL_FILE = 'thumbnail.jpg';
export const CANDIDATE_PATTERN = 'candidate_%04d.jpg';

export function storyboardFileName(gridSize: number): string {
    return `storyboard_${gridSize}x${gridSize}.jpg`;
}

export function thumbCandidateFileName(index: number): string {
    return `thumb_candidate_${index}.jpg`;
}

/** Zero padded 4 digit index, like PHP `sprintf('%04d')`. */
export function pad4(index: number): string {
    return String(index).padStart(4, '0');
}

export function tileSequencePattern(gridSize: number): string {
    return `tile_${gridSize}x${gridSize}_%04d.jpg`;
}
