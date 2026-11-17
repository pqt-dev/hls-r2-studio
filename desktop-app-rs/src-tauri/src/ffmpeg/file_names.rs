//! Fixed names of the files the pipeline produces inside a job's temp directory (the part of
//! desktop-app/src/main/pipeline/fileNames.ts that the ffmpeg argument builders need).

pub const PLAYLIST_FILE: &str = "playlist.m3u8";
pub const SEGMENT_PATTERN: &str = "segment_%03d.ts";
pub const THUMBNAIL_FILE: &str = "thumbnail.jpg";
pub const CANDIDATE_PATTERN: &str = "candidate_%04d.jpg";

pub fn storyboard_file_name(grid_size: u32) -> String {
    format!("storyboard_{grid_size}x{grid_size}.jpg")
}

pub fn thumb_candidate_file_name(index: u32) -> String {
    format!("thumb_candidate_{index}.jpg")
}

/// Zero padded 4 digit index, like PHP `sprintf('%04d')`.
pub fn pad4(index: u32) -> String {
    format!("{index:04}")
}

pub fn tile_sequence_pattern(grid_size: u32) -> String {
    format!("tile_{grid_size}x{grid_size}_%04d.jpg")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_match_the_pipeline() {
        assert_eq!(storyboard_file_name(4), "storyboard_4x4.jpg");
        assert_eq!(thumb_candidate_file_name(7), "thumb_candidate_7.jpg");
        assert_eq!(pad4(7), "0007");
        assert_eq!(pad4(12345), "12345");
        assert_eq!(tile_sequence_pattern(3), "tile_3x3_%04d.jpg");
    }
}
