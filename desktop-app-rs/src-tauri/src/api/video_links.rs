//! The few fields of a video that the Copy and Open actions need, kept in memory after the video
//! list or a detail was loaded, so copying a link needs no new request. In-memory only, bounded,
//! and cleared on sign-out.

use std::collections::HashMap;
use std::sync::Mutex;

use super::videos::{build_public_url, VideoDetail, VideoListItem};
use crate::pipeline::register::{RegisterPayload, RegisteredVideo};

/// Videos kept at most; a longer list restarts the cache instead of growing it.
pub const MAX_CACHED_VIDEOS: usize = 5000;

/// Minimal data of one video for building a link or opening the embed page.
#[derive(Debug, Clone, PartialEq)]
pub struct VideoLinks {
    pub public_id: String,
    pub embed_url: Option<String>,
    pub playlist_url: Option<String>,
    /// Storage folder (normalised R2 key prefix) of the detail; `None` for a list item or an older site.
    pub storage_folder: Option<String>,
    /// Generated thumbnail and custom image URLs (public R2 URLs), for the Copy buttons.
    pub thumbnail_url: Option<String>,
    pub custom_image_url: Option<String>,
    /// Storyboard URLs of the detail that have one, in the order the detail lists them (by grid
    /// key). The Copy buttons address them by position. Empty for a list item.
    pub storyboard_urls: Vec<String>,
    /// True when built from a detail response (the image URLs then carry their current `?v=`
    /// cache-buster and the storyboards are known); false for a list item.
    pub detail_loaded: bool,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

impl From<&VideoDetail> for VideoLinks {
    fn from(video: &VideoDetail) -> Self {
        Self {
            public_id: video.public_id.clone(),
            embed_url: video.embed_url.clone(),
            playlist_url: video.playlist_url.clone(),
            storage_folder: video.storage_folder.clone(),
            thumbnail_url: video.thumbnail_url.clone(),
            custom_image_url: video.custom_image_url.clone(),
            storyboard_urls: video
                .storyboards
                .values()
                .filter_map(|board| board.url.clone())
                .collect(),
            detail_loaded: true,
            width: video.output_width,
            height: video.output_height,
        }
    }
}

impl VideoLinks {
    /// From a video the app just registered: the playlist and thumbnail URLs are built from the
    /// register payload paths and the R2 public base URL (`None` when either is missing).
    pub fn from_registered(
        registered: &RegisteredVideo,
        payload: &RegisterPayload,
        r2_base: Option<&str>,
    ) -> Self {
        Self {
            public_id: registered.public_id.clone(),
            embed_url: Some(registered.embed_url.clone()),
            playlist_url: r2_base.and_then(|base| build_public_url(base, &payload.playlist_path)),
            storage_folder: None,
            thumbnail_url: r2_base
                .zip(payload.thumbnail_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            custom_image_url: None,
            storyboard_urls: Vec::new(),
            detail_loaded: false,
            width: payload.output_width.and_then(|w| u32::try_from(w).ok()),
            height: payload.output_height.and_then(|h| u32::try_from(h).ok()),
        }
    }

    /// From a list item; the playlist URL is built from its storage path and the R2 public base
    /// URL (`None` when either is missing).
    pub fn from_list_item(item: &VideoListItem, r2_base: Option<&str>) -> Self {
        Self {
            public_id: item.public_id.clone(),
            embed_url: item.embed_url.clone(),
            playlist_url: r2_base
                .zip(item.playlist_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            storage_folder: None,
            thumbnail_url: r2_base
                .zip(item.thumbnail_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            custom_image_url: r2_base
                .zip(item.custom_image_path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path)),
            storyboard_urls: Vec::new(),
            detail_loaded: false,
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

    /// Forgets one video (its image changed, so the remembered image URLs are stale).
    pub fn remove(&self, id: i64) {
        self.lock().remove(&id);
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
            storage_folder: None,
            thumbnail_url: None,
            custom_image_url: None,
            storyboard_urls: Vec::new(),
            detail_loaded: false,
            width: Some(1280),
            height: Some(720),
        }
    }

    fn registered() -> (RegisteredVideo, RegisterPayload) {
        let payload: RegisterPayload = serde_json::from_value(serde_json::json!({
            "public_id": "aaaaaaaaaaaa", "title": "t", "original_filename": "t.mp4",
            "original_size_bytes": 1, "disk_prefix": "2026/01/01/t-aaaaaaaaaaaa/",
            "playlist_path": "2026/01/01/t-aaaaaaaaaaaa/playlist.m3u8",
            "thumbnail_path": "2026/01/01/t-aaaaaaaaaaaa/thumbnail.jpg",
            "storyboards": null, "duration": null, "output_width": 1280, "output_height": 720,
            "output_fps": null, "output_bitrate_kbps": null, "output_codec": null
        }))
        .unwrap();
        let registered = RegisteredVideo {
            id: 5,
            public_id: "aaaaaaaaaaaa".into(),
            embed_url: "https://site.example.com/embed/aaaaaaaaaaaa".into(),
        };

        (registered, payload)
    }

    #[test]
    fn from_registered_builds_urls_from_the_payload_and_r2_base() {
        let (registered, mut payload) = registered();
        let links =
            VideoLinks::from_registered(&registered, &payload, Some("https://cdn.example.com"));

        assert_eq!(
            links.thumbnail_url.as_deref(),
            Some("https://cdn.example.com/2026/01/01/t-aaaaaaaaaaaa/thumbnail.jpg")
        );
        assert_eq!(
            links.playlist_url.as_deref(),
            Some("https://cdn.example.com/2026/01/01/t-aaaaaaaaaaaa/playlist.m3u8")
        );
        assert_eq!((links.width, links.height), (Some(1280), Some(720)));
        assert!(!links.detail_loaded);

        // No R2 base or no thumbnail path: no thumbnail URL.
        assert_eq!(
            VideoLinks::from_registered(&registered, &payload, None).thumbnail_url,
            None
        );
        payload.thumbnail_path = None;
        assert_eq!(
            VideoLinks::from_registered(&registered, &payload, Some("https://cdn.example.com"))
                .thumbnail_url,
            None
        );
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
