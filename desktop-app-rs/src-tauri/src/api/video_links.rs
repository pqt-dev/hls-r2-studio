//! The few fields of a video that the Copy and Open actions need, kept in memory after the video
//! list or a detail was loaded, so copying a link needs no new request. In-memory only, bounded,
//! and cleared on sign-out.

use std::collections::HashMap;
use std::sync::Mutex;

use super::videos::{build_public_url, VideoDetail, VideoListItem};

/// Videos kept at most; a longer list restarts the cache instead of growing it.
pub const MAX_CACHED_VIDEOS: usize = 5000;

/// Minimal data of one video for building a link or opening the embed page.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoLinks {
    pub public_id: String,
    pub embed_url: Option<String>,
    pub playlist_url: Option<String>,
    /// Generated thumbnail and custom image URLs (public R2 URLs), for the Copy buttons.
    pub thumbnail_url: Option<String>,
    pub custom_image_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl From<&VideoDetail> for VideoLinks {
    fn from(video: &VideoDetail) -> Self {
        Self {
            public_id: video.public_id.clone(),
            embed_url: video.embed_url.clone(),
            playlist_url: video.playlist_url.clone(),
            thumbnail_url: video.thumbnail_url.clone(),
            custom_image_url: video.custom_image_url.clone(),
            width: video.output_width,
            height: video.output_height,
        }
    }
}

impl VideoLinks {
    /// From a list item; the playlist URL is built from its storage path and the R2 public base
    /// URL (`None` when either is missing).
    pub fn from_list_item(item: &VideoListItem, r2_base: Option<&str>) -> Self {
        Self {
            public_id: item.public_id.clone(),
            embed_url: item.embed_url.clone(),
            playlist_url: r2_base
                .zip(item.playlist_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            thumbnail_url: r2_base
                .zip(item.thumbnail_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            custom_image_url: r2_base
                .zip(item.custom_image_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            width: item.output_width,
            height: item.output_height,
        }
    }
}

#[derive(Default)]
pub struct VideoLinkCache {
    entries: Mutex<HashMap<i64, VideoLinks>>,
}

impl VideoLinkCache {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<i64, VideoLinks>> {
        self.entries.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn put(&self, id: i64, links: VideoLinks) {
        let mut entries = self.lock();

        if entries.len() >= MAX_CACHED_VIDEOS && !entries.contains_key(&id) {
            entries.clear();
        }

        entries.insert(id, links);
    }

    pub fn get(&self, id: i64) -> Option<VideoLinks> {
        self.lock().get(&id).cloned()
    }

    pub fn clear(&self) {
        self.lock().clear();
    }

    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(id: &str) -> VideoLinks {
        VideoLinks {
            public_id: id.into(),
            embed_url: Some(format!("https://site.example.com/embed/{id}")),
            playlist_url: None,
            thumbnail_url: None,
            custom_image_url: None,
            width: Some(1280),
            height: Some(720),
        }
    }

    #[test]
    fn stores_returns_replaces_and_clears() {
        let cache = VideoLinkCache::default();

        assert!(cache.is_empty());
        cache.put(1, links("aaa"));
        cache.put(2, links("bbb"));
        assert_eq!(cache.get(1), Some(links("aaa")));
        assert_eq!(cache.get(3), None);

        cache.put(1, links("ccc"));
        assert_eq!(cache.get(1).unwrap().public_id, "ccc");
        assert_eq!(cache.len(), 2);

        cache.clear();
        assert!(cache.is_empty());
        assert_eq!(cache.get(2), None);
    }

    #[test]
    fn is_bounded() {
        let cache = VideoLinkCache::default();

        for id in 0..MAX_CACHED_VIDEOS as i64 {
            cache.put(id, links("x"));
        }

        assert_eq!(cache.len(), MAX_CACHED_VIDEOS);
        // Replacing an entry never counts as growth.
        cache.put(0, links("y"));
        assert_eq!(cache.len(), MAX_CACHED_VIDEOS);
        // A new id past the bound restarts the cache with just that entry.
        cache.put(MAX_CACHED_VIDEOS as i64 + 1, links("z"));
        assert_eq!(cache.len(), 1);
    }
}
