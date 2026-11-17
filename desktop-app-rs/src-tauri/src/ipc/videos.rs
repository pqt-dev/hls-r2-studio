//! `videos:*` commands: read-only cloud video library (list and detail) through the site API.
//! Results are `{ ok: true, ... } | { ok: false, error }` with safe English error text; the
//! site's body, URL and token never reach the renderer.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Runtime, State, WebviewWindow};

use super::auth::rejected;
use super::jobs::{
    site_url, JobsDesktop, TauriJobsDesktop, CLIPBOARD_FAILED, FOREIGN_EMBED_URL, NO_EMBED_URL,
    OPEN_FAILED,
};
use super::validate::{parse_video_id, parse_video_link, parse_videos_list, VideosListInput};
use super::IpcError;
use crate::api::videos::{
    build_public_url, VideoDetail, VideoListItem, VideoListMeta, VideoStatus,
};
use crate::api::{SiteApiError, SiteClient};
use crate::desktop::{is_embed_url_of_site, open_external_https, safe_https_url};
use crate::dto::{ActionResult, VideoLinkKind};
use crate::logger::Log;
use crate::state::AppState;

pub const NO_PLAYLIST_URL: &str = "This video has no playlist URL yet.";

/// One list row for the renderer: URLs built here from the R2 public base URL. The storage
/// paths (`diskPrefix`, `playlistPath`, `*Path`) and the R2 base never leave Rust.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoListItemDto {
    pub id: i64,
    pub public_id: String,
    pub title: String,
    pub original_filename: Option<String>,
    pub status: VideoStatus,
    pub duration: Option<f64>,
    /// The custom image when the video has one, else the generated thumbnail; `None` when
    /// neither exists or R2 is not configured.
    pub thumbnail_url: Option<String>,
    pub has_custom_image: bool,
    pub embed_url: Option<String>,
    pub created_at: Option<String>,
}

impl VideoListItemDto {
    /// `r2_base` is the R2 public base URL of the loaded site config (`None` when not loaded).
    pub(crate) fn from_item(item: VideoListItem, r2_base: Option<&str>) -> Self {
        let url_of = |path: &Option<String>| {
            r2_base
                .zip(path.as_deref())
                .and_then(|(base, path)| build_public_url(base, path))
        };
        let custom = url_of(&item.custom_image_path);
        let has_custom_image = custom.is_some();
        let thumbnail_url = custom.or_else(|| url_of(&item.thumbnail_path));

        Self {
            id: item.id,
            public_id: item.public_id,
            title: item.title,
            original_filename: item.original_filename,
            status: item.status,
            duration: item.duration,
            thumbnail_url,
            has_custom_image,
            embed_url: item.embed_url,
            created_at: item.created_at,
        }
    }
}

/// `{ ok: true; data: VideoListItemDto[]; meta: VideoListMetaDto } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum VideosListResult {
    Ok {
        ok: bool,
        data: Vec<VideoListItemDto>,
        meta: VideoListMeta,
    },
    Err {
        ok: bool,
        error: String,
    },
}

/// `{ ok: true; video: VideoDetailDto } | { ok: false; error: string }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum VideosGetResult {
    Ok { ok: bool, video: Box<VideoDetail> },
    Err { ok: bool, error: String },
}

impl VideosListResult {
    fn failed(error: SiteApiError) -> Self {
        Self::Err {
            ok: false,
            error: error.message,
        }
    }
}

impl VideosGetResult {
    fn failed(error: SiteApiError) -> Self {
        Self::Err {
            ok: false,
            error: error.message,
        }
    }
}

pub(crate) async fn list_videos(
    client: &SiteClient,
    input: VideosListInput,
    r2_base: Option<&str>,
) -> VideosListResult {
    match client
        .list_videos(input.page, input.per_page, input.query.as_deref())
        .await
    {
        Ok(page) => VideosListResult::Ok {
            ok: true,
            data: page
                .data
                .into_iter()
                .map(|item| VideoListItemDto::from_item(item, r2_base))
                .collect(),
            meta: page.meta,
        },
        Err(error) => VideosListResult::failed(error),
    }
}

pub(crate) async fn get_video(client: &SiteClient, id: i64) -> VideosGetResult {
    match client.get_video(id).await {
        Ok(video) => VideosGetResult::Ok {
            ok: true,
            video: Box::new(video),
        },
        Err(error) => VideosGetResult::failed(error),
    }
}

#[tauri::command]
pub async fn videos_list(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosListResult, IpcError> {
    let input = parse_videos_list(payload).map_err(|e| rejected(&state, "videos:list", e))?;

    // The R2 public base URL of the config loaded after login (never sent to the renderer).
    let r2_base = state.config.r2_public_url();

    Ok(list_videos(&state.site_client, input, r2_base.as_deref()).await)
}

#[tauri::command]
pub async fn videos_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosGetResult, IpcError> {
    let id = parse_video_id(payload).map_err(|e| rejected(&state, "videos:get", e))?;

    Ok(get_video(&state.site_client, id).await)
}

/// Copies the embed or playlist URL of a video detail that Rust fetched itself; the renderer
/// never supplies clipboard text. Only a plain https URL is copied.
pub(crate) fn copy_video_link(
    video: &VideoDetail,
    kind: VideoLinkKind,
    desktop: &dyn JobsDesktop,
    logger: &dyn Log,
) -> ActionResult {
    let (url, missing) = match kind {
        VideoLinkKind::EmbedUrl => (video.embed_url.as_deref(), NO_EMBED_URL),
        VideoLinkKind::PlaylistUrl => (video.playlist_url.as_deref(), NO_PLAYLIST_URL),
    };
    let Some(url) = url else {
        return ActionResult::err(missing);
    };

    if safe_https_url(url).is_none() {
        return ActionResult::err(missing);
    }

    match desktop.write_clipboard(url) {
        Ok(()) => ActionResult::Ok,
        Err(error) => {
            logger.warn(
                "Could not write the clipboard",
                Some(json!({ "error": error })),
            );
            ActionResult::err(CLIPBOARD_FAILED)
        }
    }
}

/// Opens the embed page of a video detail, only when it is https on the signed-in site.
pub(crate) fn open_video_embed(
    video: &VideoDetail,
    desktop: &dyn JobsDesktop,
    site_url: Option<&str>,
    logger: &dyn Log,
) -> ActionResult {
    let Some(embed_url) = video.embed_url.as_deref() else {
        return ActionResult::err(NO_EMBED_URL);
    };

    if !is_embed_url_of_site(embed_url, site_url) {
        return ActionResult::err(FOREIGN_EMBED_URL);
    }

    match open_external_https(embed_url, |url| desktop.open_external(url)) {
        Ok(true) => ActionResult::Ok,
        Ok(false) => ActionResult::err(OPEN_FAILED),
        Err(error) => {
            logger.warn(
                "Could not open the embed URL",
                Some(json!({ "error": error })),
            );
            ActionResult::err(OPEN_FAILED)
        }
    }
}

/// The OS calls (clipboard, browser) run off the async workers, after the network call.
#[tauri::command]
pub async fn videos_copy_link<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    let (id, kind) =
        parse_video_link(payload).map_err(|e| rejected(&state, "videos:copy-link", e))?;
    let video = match state.site_client.get_video(id).await {
        Ok(video) => video,
        Err(error) => return Ok(ActionResult::err(error.message)),
    };
    let logger = state.logger.clone();

    Ok(tauri::async_runtime::spawn_blocking(move || {
        copy_video_link(&video, kind, &TauriJobsDesktop { window }, &*logger)
    })
    .await
    .unwrap_or_else(|_| ActionResult::err(CLIPBOARD_FAILED)))
}

#[tauri::command]
pub async fn videos_open_embed<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    let id = parse_video_id(payload).map_err(|e| rejected(&state, "videos:open-embed", e))?;
    let video = match state.site_client.get_video(id).await {
        Ok(video) => video,
        Err(error) => return Ok(ActionResult::err(error.message)),
    };
    let logger = state.logger.clone();
    let site = site_url(&state);

    Ok(tauri::async_runtime::spawn_blocking(move || {
        open_video_embed(
            &video,
            &TauriJobsDesktop { window },
            site.as_deref(),
            &*logger,
        )
    })
    .await
    .unwrap_or_else(|_| ActionResult::err(OPEN_FAILED)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::jobs::tests::FakeDesktop;
    use super::*;
    use crate::logger::testing::RecordingLogger;

    const SITE: Option<&str> = Some("https://site.example.com");

    fn detail(embed: Option<&str>, playlist: Option<&str>) -> VideoDetail {
        let mut video: VideoDetail = serde_json::from_value(json!({
            "id": 7,
            "public_id": "abcdefghijkl",
            "title": "T",
            "status": "ready",
            "embed_url": embed,
            "playlist_url": playlist,
        }))
        .unwrap();

        video.sanitize();
        video
    }

    #[test]
    fn copy_link_writes_the_url_of_the_detail() {
        let video = detail(
            Some("https://site.example.com/embed/abcdefghijkl"),
            Some("https://cdn.example.com/v/master.m3u8"),
        );
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        assert_eq!(
            copy_video_link(&video, VideoLinkKind::EmbedUrl, &desktop, &log),
            ActionResult::Ok
        );
        assert_eq!(
            copy_video_link(&video, VideoLinkKind::PlaylistUrl, &desktop, &log),
            ActionResult::Ok
        );
        assert_eq!(
            *desktop.clipboard.lock().unwrap(),
            [
                "https://site.example.com/embed/abcdefghijkl",
                "https://cdn.example.com/v/master.m3u8"
            ]
        );
    }

    #[test]
    fn copy_link_refuses_missing_or_non_https_urls_and_reports_clipboard_failures() {
        let log = RecordingLogger::default();
        let desktop = FakeDesktop::default();
        let none = detail(None, None);

        assert_eq!(
            copy_video_link(&none, VideoLinkKind::EmbedUrl, &desktop, &log),
            ActionResult::err(NO_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(&none, VideoLinkKind::PlaylistUrl, &desktop, &log),
            ActionResult::err(NO_PLAYLIST_URL)
        );

        // `sanitize` already drops http URLs; the copy check also holds on its own.
        let mut insecure = detail(None, None);
        insecure.embed_url = Some("http://site.example.com/embed/a".into());
        insecure.playlist_url = Some("https://user:pw@cdn.example.com/p.m3u8".into());

        assert_eq!(
            copy_video_link(&insecure, VideoLinkKind::EmbedUrl, &desktop, &log),
            ActionResult::err(NO_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(&insecure, VideoLinkKind::PlaylistUrl, &desktop, &log),
            ActionResult::err(NO_PLAYLIST_URL)
        );
        assert!(desktop.clipboard.lock().unwrap().is_empty());

        let failing = FakeDesktop {
            clipboard_fails: true,
            ..FakeDesktop::default()
        };
        let ok = detail(Some("https://site.example.com/embed/a"), None);

        assert_eq!(
            copy_video_link(&ok, VideoLinkKind::EmbedUrl, &failing, &log),
            ActionResult::err(CLIPBOARD_FAILED)
        );
    }

    #[test]
    fn open_embed_opens_an_https_embed_url_of_the_signed_in_site() {
        let video = detail(Some("https://site.example.com/embed/abcdefghijkl"), None);
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        assert_eq!(
            open_video_embed(&video, &desktop, SITE, &log),
            ActionResult::Ok
        );
        assert_eq!(
            *desktop.opened.lock().unwrap(),
            ["https://site.example.com/embed/abcdefghijkl"]
        );
    }

    #[test]
    fn open_embed_refuses_foreign_insecure_or_missing_embed_urls() {
        let log = RecordingLogger::default();
        let desktop = FakeDesktop::default();
        let mut insecure = detail(None, None);
        insecure.embed_url = Some("http://site.example.com/embed/a".into());
        let cases = [
            (
                detail(Some("https://evil.example.com/embed/a"), None),
                SITE,
                FOREIGN_EMBED_URL,
            ),
            (
                detail(Some("https://site.example.com.evil.test/embed/a"), None),
                SITE,
                FOREIGN_EMBED_URL,
            ),
            (insecure, SITE, FOREIGN_EMBED_URL),
            (
                detail(Some("https://site.example.com/embed/a"), None),
                None,
                FOREIGN_EMBED_URL,
            ),
            (detail(None, None), SITE, NO_EMBED_URL),
        ];

        for (video, site, error) in cases {
            assert_eq!(
                open_video_embed(&video, &desktop, site, &log),
                ActionResult::err(error)
            );
        }
        assert!(desktop.opened.lock().unwrap().is_empty());
    }

    #[test]
    fn results_serialize_like_the_other_ok_or_error_results() {
        let failed = VideosGetResult::failed(SiteApiError::new("Video not found."));

        assert_eq!(
            serde_json::to_value(failed).unwrap(),
            json!({ "ok": false, "error": "Video not found." })
        );

        let meta = VideoListMeta {
            page: 1,
            per_page: 24,
            total: 0,
            last_page: 1,
        };
        let listed = VideosListResult::Ok {
            ok: true,
            data: vec![],
            meta,
        };

        assert_eq!(
            serde_json::to_value(listed).unwrap(),
            json!({ "ok": true, "data": [], "meta": { "page": 1, "perPage": 24, "total": 0, "lastPage": 1 } })
        );
    }

    fn item_json(extra: serde_json::Value) -> VideoListItem {
        let mut base = json!({
            "id": 7,
            "public_id": "abcdefghijkl",
            "title": "Holiday",
            "status": "ready",
            "duration": 61.5,
            "disk_prefix": "videos/abcdefghijkl",
            "playlist_path": "videos/abcdefghijkl/master.m3u8",
            "thumbnail_path": "videos/abcdefghijkl/thumb 1.jpg",
            "custom_image_path": null,
            "storyboards": { "3x3": { "path": "videos/abcdefghijkl/sb.jpg" } },
            "embed_url": "https://site.example.com/embed/abcdefghijkl",
            "created_at": "2026-01-01T00:00:00+00:00"
        });

        base.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());

        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn list_item_has_urls_and_no_storage_paths() {
        let dto =
            VideoListItemDto::from_item(item_json(json!({})), Some("https://cdn.example.com"));
        let value = serde_json::to_value(&dto).unwrap();
        let text = value.to_string();

        assert_eq!(
            value["thumbnailUrl"],
            "https://cdn.example.com/videos/abcdefghijkl/thumb%201.jpg"
        );
        assert_eq!(value["hasCustomImage"], false);
        assert_eq!(
            value["embedUrl"],
            "https://site.example.com/embed/abcdefghijkl"
        );

        for key in [
            "diskPrefix",
            "playlistPath",
            "thumbnailPath",
            "customImagePath",
            "storyboards",
        ] {
            assert!(value.get(key).is_none(), "{key}");
        }

        assert!(!text.contains("Path"), "{text}");
        assert!(!text.contains("master.m3u8"), "{text}");
        assert!(!text.contains("disk"), "{text}");
    }

    #[test]
    fn custom_image_wins_and_missing_config_gives_no_thumbnail() {
        let item = item_json(json!({ "custom_image_path": "videos/abcdefghijkl/custom.png" }));
        let dto = VideoListItemDto::from_item(item.clone(), Some("https://cdn.example.com/"));

        assert!(dto.has_custom_image);
        assert_eq!(
            dto.thumbnail_url.as_deref(),
            Some("https://cdn.example.com/videos/abcdefghijkl/custom.png")
        );

        for base in [None, Some("http://cdn.example.com")] {
            let dto = VideoListItemDto::from_item(item.clone(), base);

            assert_eq!(dto.thumbnail_url, None);
            assert!(!dto.has_custom_image);
        }
    }

    #[test]
    fn detail_never_carries_internal_keys() {
        let mut detail: VideoDetail = serde_json::from_value(json!({
            "id": 1,
            "public_id": "abcdefghijkl",
            "title": "T",
            "status": "ready",
            "disk_prefix": "videos/x",
            "playlist_path": "videos/x/master.m3u8",
            "upload_id": "secret-upload-id",
            "thumbnail_url": "https://cdn.example.com/t.jpg"
        }))
        .unwrap();

        detail.sanitize();

        let text = serde_json::to_value(&detail).unwrap().to_string();

        for needle in [
            "diskPrefix",
            "playlistPath",
            "upload",
            "disk_prefix",
            "secret-upload-id",
        ] {
            assert!(!text.contains(needle), "{needle}: {text}");
        }
    }
}
