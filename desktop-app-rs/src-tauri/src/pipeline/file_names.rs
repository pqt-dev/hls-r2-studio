//! Fixed names of the files the pipeline produces inside a job's temp directory (port of
//! fileNames.ts). They already live in `ffmpeg::file_names` (the argument builders need them);
//! this module re-exports them so pipeline code has one place to import from.

pub use crate::ffmpeg::file_names::{
    pad4, storyboard_file_name, thumb_candidate_file_name, tile_sequence_pattern,
    CANDIDATE_PATTERN, PLAYLIST_FILE, SEGMENT_PATTERN, THUMBNAIL_FILE,
};
