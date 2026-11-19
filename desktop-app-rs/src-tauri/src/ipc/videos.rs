//! `videos:*` commands: the cloud video library (list, detail, rename, delete, bulk delete) through
//! the site API.
//! Results are `{ ok: true, ... } | { ok: false, error }` with safe English error text; the
//! site's body, URL and token never reach the renderer.

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Runtime, State, WebviewWindow};

use super::auth::rejected;
use super::jobs::{
    embed_shortcode, site_url, JobsDesktop, TauriJobsDesktop, CLIPBOARD_FAILED, FOREIGN_EMBED_URL,
    INVALID_VIDEO_ID, NO_EMBED_URL, OPEN_FAILED,
};
use super::validate::{
    parse_video_bulk_delete, parse_video_id, parse_video_link, parse_video_title_update,
    parse_videos_list, VideosListInput,
};
use super::IpcError;
use crate::api::image_upload::{read_image_file, IMAGE_UNREADABLE};
use crate::api::video_links::{VideoLinkCache, VideoLinks};
use crate::api::videos::{
    build_public_url, normalize_storage_folder, DeleteStatus, VideoDetail, VideoListItem,
    VideoListMeta, VideoStatus,
};
use crate::api::{SiteApiError, SiteClient};
use crate::desktop::{is_embed_url_of_site, open_external_https, safe_https_url};
use crate::dto::{ActionResult, VideoLinkKind};
use crate::logger::Log;
use crate::state::AppState;

pub const NO_PLAYLIST_URL: &str = "This video has no HLS URL (.m3u8) yet.";
pub const NO_THUMBNAIL_URL: &str = "This video has no thumbnail yet.";
pub const NO_CUSTOM_IMAGE_URL: &str = "This video has no custom image.";
pub const NO_STORAGE_FOLDER: &str = "This video has no storage folder yet.";
pub const NO_STORYBOARD_URL: &str = "This video has no such storyboard.";

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
    /// Output resolution in pixels (`None` until the video is processed).
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// Size of the original upload in bytes, when the site reports it.
    pub size_bytes: Option<u64>,
    /// Frames per second and video bitrate (kbps) of the output, when the site reports them.
    pub fps: Option<f64>,
    pub bitrate_kbps: Option<u64>,
    /// The generated thumbnail only (the custom image never replaces it, as on the web list);
    /// `None` when it does not exist or R2 is not configured.
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
        let has_custom_image = url_of(&item.custom_image_path).is_some();
        let thumbnail_url = url_of(&item.thumbnail_path);

        Self {
            id: item.id,
            public_id: item.public_id,
            title: item.title,
            original_filename: item.original_filename,
            status: item.status,
            duration: item.duration,
            width: item.output_width,
            height: item.output_height,
            size_bytes: item.original_size_bytes,
            fps: item.output_fps,
            bitrate_kbps: item.output_bitrate_kbps,
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
    cache: &VideoLinkCache,
) -> VideosListResult {
    match client
        .list_videos(
            input.page,
            input.per_page,
            input.query.as_deref(),
            input.sort,
            input.status.as_deref(),
        )
        .await
    {
        Ok(page) => {
            // Remembered for instant Copy / Open (no new request later).
            for item in &page.data {
                cache.put(item.id, VideoLinks::from_list_item(item, r2_base));
            }

            VideosListResult::Ok {
                ok: true,
                data: page
                    .data
                    .into_iter()
                    .map(|item| VideoListItemDto::from_item(item, r2_base))
                    .collect(),
                meta: page.meta,
            }
        }
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

    Ok(list_videos(
        &state.site_client,
        input,
        r2_base.as_deref(),
        &state.video_links,
    )
    .await)
}

#[tauri::command]
pub async fn videos_get(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosGetResult, IpcError> {
    let id = parse_video_id(payload).map_err(|e| rejected(&state, "videos:get", e))?;
    let result = get_video(&state.site_client, id).await;

    Ok(remember_and_fill(
        result,
        &state.video_links,
        site_url(&state).as_deref(),
    ))
}

/// `{ ok: true; status: 'deleted' | 'skipped' | 'failed'; message } | { ok: false; error }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum VideosDeleteResult {
    Ok {
        ok: bool,
        status: DeleteStatus,
        message: String,
    },
    Err {
        ok: bool,
        error: String,
    },
}

/// `{ ok: true; deleted; failed; skipped; message } | { ok: false; error }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum VideosBulkDeleteResult {
    Ok {
        ok: bool,
        deleted: u32,
        failed: u32,
        skipped: u32,
        message: String,
    },
    Err {
        ok: bool,
        error: String,
    },
}

pub(crate) async fn update_video_title(
    client: &SiteClient,
    id: i64,
    title: &str,
) -> VideosGetResult {
    match client.update_video_title(id, title).await {
        Ok(video) => VideosGetResult::Ok {
            ok: true,
            video: Box::new(video),
        },
        Err(error) => VideosGetResult::failed(error),
    }
}

pub(crate) async fn delete_video(client: &SiteClient, id: i64) -> VideosDeleteResult {
    match client.delete_video(id).await {
        Ok(outcome) => VideosDeleteResult::Ok {
            ok: true,
            status: outcome.status,
            message: outcome.message,
        },
        Err(error) => VideosDeleteResult::Err {
            ok: false,
            error: error.message,
        },
    }
}

pub(crate) async fn bulk_delete_videos(client: &SiteClient, ids: &[i64]) -> VideosBulkDeleteResult {
    match client.bulk_delete_videos(ids).await {
        Ok(outcome) => VideosBulkDeleteResult::Ok {
            ok: true,
            deleted: outcome.deleted,
            failed: outcome.failed,
            skipped: outcome.skipped,
            message: outcome.message,
        },
        Err(error) => VideosBulkDeleteResult::Err {
            ok: false,
            error: error.message,
        },
    }
}

/// `{ ok: true; canceled: true } | { ok: true; canceled: false; imageUrl?: string } |
/// { ok: false; error }`
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum VideosSetImageResult {
    Ok {
        ok: bool,
        canceled: bool,
        #[serde(rename = "imageUrl", skip_serializing_if = "Option::is_none")]
        image_url: Option<String>,
    },
    Err {
        ok: bool,
        error: String,
    },
}

impl VideosSetImageResult {
    fn err(error: impl Into<String>) -> Self {
        Self::Err {
            ok: false,
            error: error.into(),
        }
    }
}

/// Opens the native image picker (from Rust only), validates the chosen file locally (regular
/// file, 1..=5 MB, type from the magic bytes) and uploads it. The renderer never supplies a
/// path or bytes; neither the path nor the bytes are logged or put into an error.
pub(crate) async fn set_video_image(
    client: &SiteClient,
    cache: &VideoLinkCache,
    id: i64,
    desktop: &dyn JobsDesktop,
) -> VideosSetImageResult {
    let Some(path) = desktop.pick_image_file().await else {
        return VideosSetImageResult::Ok {
            ok: true,
            canceled: true,
            image_url: None,
        };
    };
    let read =
        tauri::async_runtime::spawn_blocking(move || read_image_file(std::path::Path::new(&path)))
            .await;
    let (kind, bytes) = match read {
        Ok(Ok(image)) => image,
        Ok(Err(message)) => return VideosSetImageResult::err(message),
        Err(_) => return VideosSetImageResult::err(IMAGE_UNREADABLE),
    };

    let uploaded = client.set_video_image(id, &bytes, kind).await;

    // The image URLs (with their `?v=`) remembered for this video are stale from now on, whatever
    // the outcome of the upload was.
    cache.remove(id);

    match uploaded {
        Ok(image_url) => VideosSetImageResult::Ok {
            ok: true,
            canceled: false,
            image_url,
        },
        Err(error) => VideosSetImageResult::err(error.message),
    }
}

pub(crate) async fn remove_video_image(
    client: &SiteClient,
    cache: &VideoLinkCache,
    id: i64,
) -> ActionResult {
    let removed = client.delete_video_image(id).await;

    cache.remove(id);

    match removed {
        Ok(()) => ActionResult::Ok,
        Err(error) => ActionResult::err(error.message),
    }
}

#[tauri::command]
pub async fn videos_set_image<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosSetImageResult, IpcError> {
    let id = parse_video_id(payload).map_err(|e| rejected(&state, "videos:set-image", e))?;

    Ok(set_video_image(
        &state.site_client,
        &state.video_links,
        id,
        &TauriJobsDesktop { window },
    )
    .await)
}

#[tauri::command]
pub async fn videos_remove_image(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    let id = parse_video_id(payload).map_err(|e| rejected(&state, "videos:remove-image", e))?;

    Ok(remove_video_image(&state.site_client, &state.video_links, id).await)
}

#[tauri::command]
pub async fn videos_update_title(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosGetResult, IpcError> {
    let (id, title) = parse_video_title_update(payload)
        .map_err(|e| rejected(&state, "videos:update-title", e))?;

    let result = update_video_title(&state.site_client, id, &title).await;

    Ok(remember_and_fill(
        result,
        &state.video_links,
        site_url(&state).as_deref(),
    ))
}

#[tauri::command]
pub async fn videos_delete(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosDeleteResult, IpcError> {
    let id = parse_video_id(payload).map_err(|e| rejected(&state, "videos:delete", e))?;

    Ok(delete_video(&state.site_client, id).await)
}

#[tauri::command]
pub async fn videos_bulk_delete(
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<VideosBulkDeleteResult, IpcError> {
    let ids =
        parse_video_bulk_delete(payload).map_err(|e| rejected(&state, "videos:bulk-delete", e))?;

    Ok(bulk_delete_videos(&state.site_client, &ids).await)
}

/// Iframe snippet of the website's Embed dialog (`buildEmbedIframeCode` in
/// `resources/views/videos/index.blade.php`, without autoplay/muted). The aspect ratio uses the real
/// output size only for landscape videos, else `16 / 9` (as `$embedAspectRatio` in `_row.blade.php`).
/// The renderer builds the same string for display (`iframeCode` in VideoDetailPage.tsx).
fn iframe_code(embed_url: &str, width: Option<u32>, height: Option<u32>) -> String {
    let ratio = match (width, height) {
        (Some(w), Some(h)) if w > 0 && h > 0 && w > h => format!("{w} / {h}"),
        _ => "16 / 9".to_string(),
    };

    format!(
        "<iframe src=\"{embed_url}\" style=\"width:100%; aspect-ratio:{ratio}; max-height:75vh; border:0;\" allowfullscreen allow=\"autoplay; fullscreen\"></iframe>"
    )
}

/// The text one Copy action puts on the clipboard, or the safe message when it cannot be built.
/// Only a plain https URL is copied; the shortcode and the iframe code need an https embed URL on
/// the signed-in site, and the shortcode a plain public id.
fn link_text(
    links: &VideoLinks,
    kind: VideoLinkKind,
    site_url: Option<&str>,
) -> Result<String, &'static str> {
    match kind {
        VideoLinkKind::EmbedUrl | VideoLinkKind::PlaylistUrl => {
            let (url, missing) = if kind == VideoLinkKind::EmbedUrl {
                (links.embed_url.as_deref(), NO_EMBED_URL)
            } else {
                (links.playlist_url.as_deref(), NO_PLAYLIST_URL)
            };

            url.filter(|url| safe_https_url(url).is_some())
                .map(str::to_string)
                .ok_or(missing)
        }
        VideoLinkKind::ThumbnailUrl | VideoLinkKind::CustomImageUrl => {
            let (url, missing) = if kind == VideoLinkKind::ThumbnailUrl {
                (links.thumbnail_url.as_deref(), NO_THUMBNAIL_URL)
            } else {
                (links.custom_image_url.as_deref(), NO_CUSTOM_IMAGE_URL)
            };

            url.filter(|url| safe_https_url(url).is_some())
                .map(str::to_string)
                .ok_or(missing)
        }
        VideoLinkKind::StorageFolder => links
            .storage_folder
            .as_deref()
            .and_then(normalize_storage_folder)
            .ok_or(NO_STORAGE_FOLDER),
        VideoLinkKind::StoryboardUrl(index) => links
            .storyboard_urls
            .get(index)
            .filter(|url| safe_https_url(url).is_some())
            .cloned()
            .ok_or(NO_STORYBOARD_URL),
        VideoLinkKind::IframeCode => {
            let embed_url = links.embed_url.as_deref().ok_or(NO_EMBED_URL)?;

            if !is_embed_url_of_site(embed_url, site_url) {
                return Err(FOREIGN_EMBED_URL);
            }

            Ok(iframe_code(embed_url, links.width, links.height))
        }
        VideoLinkKind::Shortcode => {
            let embed_url = links.embed_url.as_deref().ok_or(NO_EMBED_URL)?;

            if !is_embed_url_of_site(embed_url, site_url) {
                return Err(FOREIGN_EMBED_URL);
            }

            embed_shortcode(&links.public_id).ok_or(INVALID_VIDEO_ID)
        }
    }
}

/// Remembers a loaded detail for instant Copy / Open and fills its ready-made shortcode and
/// iframe snippet (shown by the detail page; `None` when the same checks as the Copy buttons fail).
fn remember_and_fill(
    result: VideosGetResult,
    cache: &VideoLinkCache,
    site_url: Option<&str>,
) -> VideosGetResult {
    match result {
        VideosGetResult::Ok { ok, mut video } => {
            let links = VideoLinks::from(&*video);

            cache.put(video.id, links.clone());
            video.shortcode = link_text(&links, VideoLinkKind::Shortcode, site_url).ok();
            video.iframe_code = link_text(&links, VideoLinkKind::IframeCode, site_url).ok();

            VideosGetResult::Ok { ok, video }
        }
        other => other,
    }
}

/// Copies the embed URL, playlist URL, shortcode or iframe code of a video. The text is built here
/// from data Rust loaded itself (the renderer never supplies clipboard text).
pub(crate) fn copy_video_link(
    links: &VideoLinks,
    kind: VideoLinkKind,
    desktop: &dyn JobsDesktop,
    site_url: Option<&str>,
    logger: &dyn Log,
) -> ActionResult {
    let text = match link_text(links, kind, site_url) {
        Ok(text) => text,
        Err(message) => return ActionResult::err(message),
    };

    match desktop.write_clipboard(&text) {
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
    links: &VideoLinks,
    desktop: &dyn JobsDesktop,
    site_url: Option<&str>,
    logger: &dyn Log,
) -> ActionResult {
    let Some(embed_url) = links.embed_url.as_deref() else {
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
                "Could not open the direct URL",
                Some(json!({ "error": error })),
            );
            ActionResult::err(OPEN_FAILED)
        }
    }
}

/// The links of a video from what the list or detail call already returned (no request). A rare
/// miss (or a cached entry without the playlist URL when that is wanted) fetches the detail once
/// and remembers it.
pub(crate) async fn stored_links(
    client: &SiteClient,
    cache: &VideoLinkCache,
    id: i64,
    needs_playlist: bool,
) -> Result<VideoLinks, SiteApiError> {
    if let Some(links) = cache.get(id) {
        if !needs_playlist || links.playlist_url.is_some() {
            return Ok(links);
        }
    }

    let video = client.get_video(id).await?;
    let links = VideoLinks::from(&video);

    cache.put(id, links.clone());

    Ok(links)
}

/// The links for the image Copy buttons: the remembered entry only when it came from a detail
/// (current `?v=` URLs, storyboards known); a list entry or a miss fetches the detail once.
async fn image_links(
    client: &SiteClient,
    cache: &VideoLinkCache,
    id: i64,
) -> Result<VideoLinks, SiteApiError> {
    match cache.get(id) {
        Some(links) if links.detail_loaded => Ok(links),
        _ => fresh_links(client, cache, id).await,
    }
}

/// The links for the thumbnail Copy button: a remembered entry (from the list or a detail) that
/// already has the generated thumbnail URL is used as is (the generated thumbnail does not change
/// when a custom image is set or removed, so no `?v=` freshness is needed); otherwise the detail
/// is fetched once.
async fn thumbnail_links(
    client: &SiteClient,
    cache: &VideoLinkCache,
    id: i64,
) -> Result<VideoLinks, SiteApiError> {
    match cache.get(id) {
        Some(links) if links.thumbnail_url.is_some() => Ok(links),
        _ => fresh_links(client, cache, id).await,
    }
}

/// The links of a video from a new detail request, remembered for later Copy / Open.
async fn fresh_links(
    client: &SiteClient,
    cache: &VideoLinkCache,
    id: i64,
) -> Result<VideoLinks, SiteApiError> {
    let video = client.get_video(id).await?;
    let links = VideoLinks::from(&video);

    cache.put(id, links.clone());

    Ok(links)
}

/// The OS calls (clipboard, browser) run off the async workers; the links come from memory.
#[tauri::command]
pub async fn videos_copy_link<R: Runtime>(
    window: WebviewWindow<R>,
    state: State<'_, AppState>,
    payload: Option<Value>,
) -> Result<ActionResult, IpcError> {
    let (id, kind) =
        parse_video_link(payload).map_err(|e| rejected(&state, "videos:copy-link", e))?;
    // Custom-image and storyboard URLs change when an image is replaced or removed (and carry a
    // cache-buster): they come from the remembered detail, which set/remove image and every detail
    // load keep current.
    let client = &state.site_client;
    let cache = &state.video_links;
    let links = match kind {
        VideoLinkKind::ThumbnailUrl => thumbnail_links(client, cache, id).await,
        // Needs a loaded detail: current `?v=` URLs / storyboards, or the storage folder (a list
        // entry has none).
        VideoLinkKind::CustomImageUrl
        | VideoLinkKind::StoryboardUrl(_)
        | VideoLinkKind::StorageFolder => image_links(client, cache, id).await,
        _ => stored_links(client, cache, id, kind == VideoLinkKind::PlaylistUrl).await,
    };
    let links = match links {
        Ok(links) => links,
        Err(error) => return Ok(ActionResult::err(error.message)),
    };
    let logger = state.logger.clone();
    let site = site_url(&state);

    Ok(tauri::async_runtime::spawn_blocking(move || {
        copy_video_link(
            &links,
            kind,
            &TauriJobsDesktop { window },
            site.as_deref(),
            &*logger,
        )
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
    let links = match stored_links(&state.site_client, &state.video_links, id, false).await {
        Ok(links) => links,
        Err(error) => return Ok(ActionResult::err(error.message)),
    };
    let logger = state.logger.clone();
    let site = site_url(&state);

    Ok(tauri::async_runtime::spawn_blocking(move || {
        open_video_embed(
            &links,
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
    fn copy_from_stored_links_builds_all_four_kinds_with_the_same_checks() {
        let links = VideoLinks {
            public_id: "abcdefghijkl".into(),
            embed_url: Some("https://site.example.com/embed/abcdefghijkl".into()),
            playlist_url: Some("https://cdn.example.com/v/master.m3u8".into()),
            storage_folder: None,
            thumbnail_url: None,
            custom_image_url: None,
            storyboard_urls: Vec::new(),
            detail_loaded: false,
            width: Some(1920),
            height: Some(1080),
        };
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        for kind in [
            VideoLinkKind::EmbedUrl,
            VideoLinkKind::PlaylistUrl,
            VideoLinkKind::Shortcode,
            VideoLinkKind::IframeCode,
        ] {
            assert_eq!(
                copy_video_link(&links, kind, &desktop, SITE, &log),
                ActionResult::Ok
            );
        }

        let copied = desktop.clipboard.lock().unwrap().clone();

        assert_eq!(copied[0], "https://site.example.com/embed/abcdefghijkl");
        assert_eq!(copied[1], "https://cdn.example.com/v/master.m3u8");
        assert_eq!(copied[2], "[hls_embed_vl id=\"abcdefghijkl\"]");
        assert!(
            copied[3].starts_with("<iframe src=\"https://site.example.com/embed/abcdefghijkl\"")
        );

        // The same checks as before: http, a foreign site and an invalid id are refused.
        let insecure = VideoLinks {
            embed_url: Some("http://site.example.com/embed/abcdefghijkl".into()),
            ..links.clone()
        };
        let bad_id = VideoLinks {
            public_id: "Bad Id".into(),
            ..links.clone()
        };

        assert_eq!(
            copy_video_link(&insecure, VideoLinkKind::EmbedUrl, &desktop, SITE, &log),
            ActionResult::err(NO_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(
                &links,
                VideoLinkKind::Shortcode,
                &desktop,
                Some("https://other.example.com"),
                &log
            ),
            ActionResult::err(FOREIGN_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(&bad_id, VideoLinkKind::Shortcode, &desktop, SITE, &log),
            ActionResult::err(INVALID_VIDEO_ID)
        );
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
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::EmbedUrl,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::Ok
        );
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::PlaylistUrl,
                &desktop,
                SITE,
                &log
            ),
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
            copy_video_link(
                &VideoLinks::from(&none),
                VideoLinkKind::EmbedUrl,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::err(NO_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&none),
                VideoLinkKind::PlaylistUrl,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::err(NO_PLAYLIST_URL)
        );

        // `sanitize` already drops http URLs; the copy check also holds on its own.
        let mut insecure = detail(None, None);
        insecure.embed_url = Some("http://site.example.com/embed/a".into());
        insecure.playlist_url = Some("https://user:pw@cdn.example.com/p.m3u8".into());

        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&insecure),
                VideoLinkKind::EmbedUrl,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::err(NO_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&insecure),
                VideoLinkKind::PlaylistUrl,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::err(NO_PLAYLIST_URL)
        );
        assert!(desktop.clipboard.lock().unwrap().is_empty());

        let failing = FakeDesktop {
            clipboard_fails: true,
            ..FakeDesktop::default()
        };
        let ok = detail(Some("https://site.example.com/embed/a"), None);

        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&ok),
                VideoLinkKind::EmbedUrl,
                &failing,
                SITE,
                &log
            ),
            ActionResult::err(CLIPBOARD_FAILED)
        );
    }

    #[test]
    fn copy_iframe_code_mirrors_the_website_and_checks_the_embed_url() {
        let log = RecordingLogger::default();
        let desktop = FakeDesktop::default();
        let mut video = detail(Some("https://site.example.com/embed/abcdefghijkl"), None);

        // No output size: the 16 / 9 fallback.
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::IframeCode,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::Ok
        );
        video.output_width = Some(1920);
        video.output_height = Some(800);
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::IframeCode,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::Ok
        );
        // Portrait: back to the fallback.
        video.output_width = Some(720);
        video.output_height = Some(1280);
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::IframeCode,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::Ok
        );
        let tail = "; max-height:75vh; border:0;\" allowfullscreen allow=\"autoplay; fullscreen\"></iframe>";
        let head = "<iframe src=\"https://site.example.com/embed/abcdefghijkl\" style=\"width:100%; aspect-ratio:";

        assert_eq!(
            *desktop.clipboard.lock().unwrap(),
            [
                format!("{head}16 / 9{tail}"),
                format!("{head}1920 / 800{tail}"),
                format!("{head}16 / 9{tail}"),
            ]
        );

        let other = FakeDesktop::default();

        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::IframeCode,
                &other,
                None,
                &log
            ),
            ActionResult::err(FOREIGN_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&detail(None, None)),
                VideoLinkKind::IframeCode,
                &other,
                SITE,
                &log
            ),
            ActionResult::err(NO_EMBED_URL)
        );
        assert!(other.clipboard.lock().unwrap().is_empty());
    }

    #[test]
    fn copy_shortcode_matches_the_queue_format_and_checks_the_embed_url() {
        let log = RecordingLogger::default();
        let desktop = FakeDesktop::default();
        let video = detail(Some("https://site.example.com/embed/abcdefghijkl"), None);

        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::Shortcode,
                &desktop,
                SITE,
                &log
            ),
            ActionResult::Ok
        );
        assert_eq!(
            *desktop.clipboard.lock().unwrap(),
            ["[hls_embed_vl id=\"abcdefghijkl\"]"]
        );
        // Same string as the Queue copy for the same public id.
        assert_eq!(
            embed_shortcode("abcdefghijkl").as_deref(),
            Some("[hls_embed_vl id=\"abcdefghijkl\"]")
        );

        let other = FakeDesktop::default();
        let cases = [
            (detail(None, None), NO_EMBED_URL),
            (
                detail(Some("https://evil.example.net/embed/abcdefghijkl"), None),
                FOREIGN_EMBED_URL,
            ),
        ];

        for (video, expected) in cases {
            assert_eq!(
                copy_video_link(
                    &VideoLinks::from(&video),
                    VideoLinkKind::Shortcode,
                    &other,
                    SITE,
                    &log
                ),
                ActionResult::err(expected)
            );
        }

        let mut insecure = detail(None, None);
        insecure.embed_url = Some("http://site.example.com/embed/a".into());
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&insecure),
                VideoLinkKind::Shortcode,
                &other,
                SITE,
                &log
            ),
            ActionResult::err(FOREIGN_EMBED_URL)
        );
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::Shortcode,
                &other,
                None,
                &log
            ),
            ActionResult::err(FOREIGN_EMBED_URL)
        );

        let mut bad_id = detail(Some("https://site.example.com/embed/a"), None);
        bad_id.public_id = "A\"b".into();
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&bad_id),
                VideoLinkKind::Shortcode,
                &other,
                SITE,
                &log
            ),
            ActionResult::err(INVALID_VIDEO_ID)
        );
        assert!(other.clipboard.lock().unwrap().is_empty());

        let failing = FakeDesktop {
            clipboard_fails: true,
            ..FakeDesktop::default()
        };
        assert_eq!(
            copy_video_link(
                &VideoLinks::from(&video),
                VideoLinkKind::Shortcode,
                &failing,
                SITE,
                &log
            ),
            ActionResult::err(CLIPBOARD_FAILED)
        );
    }

    #[test]
    fn open_embed_opens_an_https_embed_url_of_the_signed_in_site() {
        let video = detail(Some("https://site.example.com/embed/abcdefghijkl"), None);
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        assert_eq!(
            open_video_embed(&VideoLinks::from(&video), &desktop, SITE, &log),
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
                open_video_embed(&VideoLinks::from(&video), &desktop, site, &log),
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
    fn list_dto_carries_resolution_and_size() {
        let item = item_json(json!({
            "output_width": 1920,
            "output_height": 1080,
            "original_size_bytes": 1048576,
            "output_fps": 29.97,
            "output_bitrate_kbps": 2400
        }));
        let dto = VideoListItemDto::from_item(item, None);

        assert_eq!(dto.width, Some(1920));
        assert_eq!(dto.height, Some(1080));
        assert_eq!(dto.size_bytes, Some(1_048_576));
        assert_eq!(dto.fps, Some(29.97));
        assert_eq!(dto.bitrate_kbps, Some(2400));

        let bare = VideoListItemDto::from_item(item_json(json!({})), None);

        assert_eq!(
            (bare.width, bare.height, bare.size_bytes),
            (None, None, None)
        );
        assert_eq!((bare.fps, bare.bitrate_kbps), (None, None));
    }

    #[test]
    fn list_thumbnail_stays_the_generated_one_when_a_custom_image_exists() {
        let item = item_json(json!({ "custom_image_path": "videos/abcdefghijkl/custom.png" }));
        let dto = VideoListItemDto::from_item(item.clone(), Some("https://cdn.example.com/"));

        assert!(dto.has_custom_image);
        assert_eq!(
            dto.thumbnail_url.as_deref(),
            Some("https://cdn.example.com/videos/abcdefghijkl/thumb%201.jpg")
        );

        for base in [None, Some("http://cdn.example.com")] {
            let dto = VideoListItemDto::from_item(item.clone(), base);

            assert_eq!(dto.thumbnail_url, None);
            assert!(!dto.has_custom_image);
        }
    }

    #[test]
    fn a_custom_image_without_a_generated_thumbnail_leaves_the_list_thumbnail_empty() {
        let item = item_json(json!({
            "thumbnail_path": null,
            "custom_image_path": "videos/abcdefghijkl/custom.png"
        }));
        let dto = VideoListItemDto::from_item(item, Some("https://cdn.example.com"));

        assert!(dto.has_custom_image);
        assert_eq!(dto.thumbnail_url, None);
    }

    #[test]
    fn copy_image_urls_need_a_safe_https_url() {
        let links = VideoLinks {
            public_id: "abcdefghijkl".into(),
            embed_url: None,
            playlist_url: None,
            storage_folder: None,
            thumbnail_url: Some("https://cdn.example.com/t.jpg?v=1".into()),
            custom_image_url: None,
            storyboard_urls: Vec::new(),
            detail_loaded: false,
            width: None,
            height: None,
        };
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        assert_eq!(
            copy_video_link(&links, VideoLinkKind::ThumbnailUrl, &desktop, SITE, &log),
            ActionResult::Ok
        );
        assert_eq!(
            copy_video_link(&links, VideoLinkKind::CustomImageUrl, &desktop, SITE, &log),
            ActionResult::err(NO_CUSTOM_IMAGE_URL)
        );

        let insecure = VideoLinks {
            thumbnail_url: Some("http://cdn.example.com/t.jpg".into()),
            ..links
        };

        assert_eq!(
            copy_video_link(&insecure, VideoLinkKind::ThumbnailUrl, &desktop, SITE, &log),
            ActionResult::err(NO_THUMBNAIL_URL)
        );
        assert_eq!(
            desktop.clipboard.lock().unwrap().clone(),
            vec!["https://cdn.example.com/t.jpg?v=1".to_string()]
        );
    }

    #[test]
    fn copy_storyboard_url_by_index_needs_a_safe_https_url() {
        let links = VideoLinks {
            public_id: "abcdefghijkl".into(),
            embed_url: None,
            playlist_url: None,
            storage_folder: None,
            thumbnail_url: None,
            custom_image_url: None,
            storyboard_urls: vec![
                "https://cdn.example.com/a.jpg".into(),
                "http://cdn.example.com/b.jpg".into(),
            ],
            detail_loaded: true,
            width: None,
            height: None,
        };
        let desktop = FakeDesktop::default();
        let log = RecordingLogger::default();

        assert_eq!(
            copy_video_link(
                &links,
                VideoLinkKind::StoryboardUrl(0),
                &desktop,
                SITE,
                &log
            ),
            ActionResult::Ok
        );
        // An insecure URL and an index past the end are both refused with the same message.
        assert_eq!(
            copy_video_link(
                &links,
                VideoLinkKind::StoryboardUrl(1),
                &desktop,
                SITE,
                &log
            ),
            ActionResult::err(NO_STORYBOARD_URL)
        );
        assert_eq!(
            copy_video_link(
                &links,
                VideoLinkKind::StoryboardUrl(2),
                &desktop,
                SITE,
                &log
            ),
            ActionResult::err(NO_STORYBOARD_URL)
        );
        assert_eq!(
            desktop.clipboard.lock().unwrap().clone(),
            vec!["https://cdn.example.com/a.jpg".to_string()]
        );
    }

    #[test]
    fn links_from_a_detail_keep_storyboard_urls_that_have_one_in_key_order() {
        let detail: VideoDetail = serde_json::from_value(json!({
            "id": 1,
            "public_id": "abcdefghijkl",
            "title": "Holiday",
            "status": "ready",
            "storyboards": {
                "5x5": { "url": "https://cdn.example.com/5.jpg" },
                "3x3": { "url": "https://cdn.example.com/3.jpg" },
                "4x4": { "url": null }
            }
        }))
        .unwrap();

        assert_eq!(
            VideoLinks::from(&detail).storyboard_urls,
            vec![
                "https://cdn.example.com/3.jpg".to_string(),
                "https://cdn.example.com/5.jpg".to_string()
            ]
        );
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

    mod calls {
        use std::sync::Arc;
        use std::time::Duration;

        use super::*;
        use crate::api::test_server::{Reply, TestServer};
        use crate::api::SiteClientOptions;
        use crate::secure::Secret;

        fn client_for(server: &TestServer) -> SiteClient {
            let base = server.base_url.clone();

            SiteClient::new_for_loopback_tests(
                SiteClientOptions {
                    get_base_url: Arc::new(move || base.clone()),
                    get_token: Arc::new(|| Some(Secret::from("tok-secret"))),
                    user_agent: "test".into(),
                    timeout: Duration::from_secs(5),
                    on_unauthorized: None,
                    logger: None,
                },
                false,
            )
        }

        fn list_reply() -> Reply {
            Reply::json(
                200,
                json!({
                    "data": [{
                        "id": 7,
                        "public_id": "abcdefghijkl",
                        "title": "T",
                        "status": "ready",
                        "output_width": 1280,
                        "output_height": 720,
                        "playlist_path": "videos/abcdefghijkl/master.m3u8",
                        "embed_url": "https://site.example.com/embed/abcdefghijkl"
                    }],
                    "meta": { "page": 1, "per_page": 24, "total": 1, "last_page": 1 }
                }),
            )
        }

        fn detail_reply() -> Reply {
            Reply::json(
                200,
                json!({
                    "id": 7,
                    "public_id": "abcdefghijkl",
                    "title": "T",
                    "status": "ready",
                    "output_width": 1920,
                    "output_height": 800,
                    "embed_url": "https://site.example.com/embed/abcdefghijkl",
                    "playlist_url": "https://cdn.example.com/videos/abcdefghijkl/master.m3u8"
                }),
            )
        }

        fn detail_with_image_reply(version: u32) -> Reply {
            Reply::json(
                200,
                json!({
                    "id": 7,
                    "public_id": "abcdefghijkl",
                    "title": "T",
                    "status": "ready",
                    "embed_url": "https://site.example.com/embed/abcdefghijkl",
                    "thumbnail_url": format!("https://cdn.example.com/t.jpg?v={version}"),
                    "custom_image_url": format!("https://cdn.example.com/c.jpg?v={version}")
                }),
            )
        }

        #[tokio::test]
        async fn image_links_from_a_loaded_detail_need_no_request() {
            let server = TestServer::start(|_| detail_with_image_reply(1)).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            remember_and_fill(get_video(&client, 7).await, &cache, SITE);
            assert_eq!(server.requests().len(), 1);

            let links = image_links(&client, &cache, 7).await.unwrap();

            assert_eq!(
                links.custom_image_url.as_deref(),
                Some("https://cdn.example.com/c.jpg?v=1")
            );
            assert_eq!(server.requests().len(), 1);
        }

        fn list_item_with_thumbnail_reply() -> Reply {
            Reply::json(
                200,
                json!({
                    "data": [{
                        "id": 7,
                        "public_id": "abcdefghijkl",
                        "title": "T",
                        "status": "ready",
                        "thumbnail_path": "videos/abcdefghijkl/thumbnail.jpg",
                        "custom_image_path": "videos/abcdefghijkl/custom.jpg",
                        "embed_url": "https://site.example.com/embed/abcdefghijkl"
                    }],
                    "meta": { "page": 1, "per_page": 24, "total": 1, "last_page": 1 }
                }),
            )
        }

        #[tokio::test]
        async fn a_list_entry_serves_the_thumbnail_without_a_request_but_not_custom_or_storyboard()
        {
            let server = TestServer::start(|request| {
                if request.path.contains("/videos/7") {
                    detail_with_image_reply(3)
                } else {
                    list_item_with_thumbnail_reply()
                }
            })
            .await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            list_videos(
                &client,
                parse_videos_list(None).unwrap(),
                Some("https://cdn.example.com"),
                &cache,
            )
            .await;
            assert_eq!(server.requests().len(), 1);

            let links = thumbnail_links(&client, &cache, 7).await.unwrap();

            assert_eq!(
                links.thumbnail_url.as_deref(),
                Some("https://cdn.example.com/videos/abcdefghijkl/thumbnail.jpg")
            );
            assert_eq!(server.requests().len(), 1);

            // The stricter rule still holds for the custom image and storyboards.
            image_links(&client, &cache, 7).await.unwrap();
            assert_eq!(server.requests().len(), 2);
        }

        #[tokio::test]
        async fn the_thumbnail_falls_back_to_one_fetch_when_nothing_is_remembered() {
            let server = TestServer::start(|_| detail_with_image_reply(1)).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            let links = thumbnail_links(&client, &cache, 7).await.unwrap();

            assert!(links.thumbnail_url.is_some());
            assert_eq!(server.requests().len(), 1);
            thumbnail_links(&client, &cache, 7).await.unwrap();
            assert_eq!(server.requests().len(), 1);
        }

        fn detail_with_folder_reply(folder: serde_json::Value) -> Reply {
            Reply::json(
                200,
                json!({
                    "id": 7,
                    "public_id": "abcdefghijkl",
                    "title": "T",
                    "status": "ready",
                    "disk_prefix": folder,
                    "embed_url": "https://site.example.com/embed/abcdefghijkl"
                }),
            )
        }

        #[tokio::test]
        async fn the_storage_folder_is_copied_from_a_loaded_detail_without_a_request() {
            let server = TestServer::start(|_| {
                detail_with_folder_reply(json!("2026/11/18/clip-abcdefghijkl"))
            })
            .await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();
            let result = remember_and_fill(get_video(&client, 7).await, &cache, SITE);
            let value = serde_json::to_value(&result).unwrap();

            // Normalised (one trailing slash) and exposed to the renderer as `storageFolder`.
            assert_eq!(
                value["video"]["storageFolder"],
                json!("2026/11/18/clip-abcdefghijkl/")
            );
            assert!(value["video"].get("diskPrefix").is_none());
            assert_eq!(server.requests().len(), 1);

            let links = image_links(&client, &cache, 7).await.unwrap();

            assert_eq!(server.requests().len(), 1);
            assert_eq!(
                link_text(&links, VideoLinkKind::StorageFolder, SITE),
                Ok("2026/11/18/clip-abcdefghijkl/".to_string())
            );
        }

        #[tokio::test]
        async fn a_list_entry_fetches_the_detail_once_for_the_storage_folder() {
            let server = TestServer::start(|request| {
                if request.path.contains("/videos/7") {
                    detail_with_folder_reply(json!("2026/11/18/clip-abcdefghijkl/"))
                } else {
                    list_reply()
                }
            })
            .await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            list_videos(&client, parse_videos_list(None).unwrap(), None, &cache).await;
            let links = image_links(&client, &cache, 7).await.unwrap();

            assert_eq!(server.requests().len(), 2);
            assert_eq!(
                links.storage_folder.as_deref(),
                Some("2026/11/18/clip-abcdefghijkl/")
            );
        }

        #[test]
        fn the_storage_folder_copy_errors_when_absent_or_unsafe() {
            let mut links = VideoLinks::from_list_item(
                &serde_json::from_value(json!({
                    "id": 7, "public_id": "abcdefghijkl", "title": "T", "status": "ready"
                }))
                .unwrap(),
                None,
            );

            assert_eq!(
                link_text(&links, VideoLinkKind::StorageFolder, SITE),
                Err(NO_STORAGE_FOLDER)
            );
            assert_eq!(NO_STORAGE_FOLDER, "This video has no storage folder yet.");

            links.storage_folder = Some("/../etc".into());
            assert_eq!(
                link_text(&links, VideoLinkKind::StorageFolder, SITE),
                Err(NO_STORAGE_FOLDER)
            );
        }

        #[tokio::test]
        async fn image_links_fall_back_to_one_fetch_when_empty_or_from_the_list() {
            let server = TestServer::start(|_| detail_with_image_reply(1)).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            image_links(&client, &cache, 7).await.unwrap();
            assert_eq!(server.requests().len(), 1);
            image_links(&client, &cache, 7).await.unwrap();
            assert_eq!(server.requests().len(), 1);

            // A list entry has no cache-busted image URLs, so it is not trusted for images.
            cache.put(
                7,
                VideoLinks {
                    detail_loaded: false,
                    ..cache.get(7).unwrap()
                },
            );
            image_links(&client, &cache, 7).await.unwrap();
            assert_eq!(server.requests().len(), 2);
            assert!(cache.get(7).unwrap().detail_loaded);
        }

        #[tokio::test]
        async fn set_and_remove_image_drop_the_stale_entry_so_the_next_copy_refetches() {
            let dir = tempfile::tempdir().unwrap();
            let path = png_file(&dir, "p.png", 32);
            let server = TestServer::start(|request| {
                if request.path.ends_with("/image") || request.path.contains("/image") {
                    Reply::json(
                        200,
                        json!({ "ok": true, "image_url": "https://cdn.example.com/c.jpg?v=2" }),
                    )
                } else {
                    detail_with_image_reply(2)
                }
            })
            .await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();
            let stale = VideoLinks {
                custom_image_url: Some("https://cdn.example.com/c.jpg?v=1".into()),
                detail_loaded: true,
                ..VideoLinks::from_list_item(
                    &serde_json::from_value(json!({
                        "id": 7, "public_id": "abcdefghijkl", "title": "T", "status": "ready"
                    }))
                    .unwrap(),
                    None,
                )
            };

            cache.put(7, stale.clone());
            set_video_image(&client, &cache, 7, &desktop_with(Some(path))).await;
            assert!(cache.get(7).is_none());

            cache.put(7, stale);
            remove_video_image(&client, &cache, 7).await;
            assert!(cache.get(7).is_none());

            let links = image_links(&client, &cache, 7).await.unwrap();

            assert_eq!(
                links.custom_image_url.as_deref(),
                Some("https://cdn.example.com/c.jpg?v=2")
            );
        }

        fn list_input() -> VideosListInput {
            parse_videos_list(None).unwrap()
        }

        #[tokio::test]
        async fn links_loaded_by_the_list_are_used_without_any_request() {
            let server = TestServer::start(|_| list_reply()).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            list_videos(
                &client,
                list_input(),
                Some("https://cdn.example.com"),
                &cache,
            )
            .await;
            assert_eq!(server.requests().len(), 1);

            let links = stored_links(&client, &cache, 7, false).await.unwrap();

            assert_eq!(links.public_id, "abcdefghijkl");
            assert_eq!(links.width, Some(1280));
            assert_eq!(
                links.playlist_url.as_deref(),
                Some("https://cdn.example.com/videos/abcdefghijkl/master.m3u8")
            );
            // Asking again for any kind (also the playlist the list could build): still no request.
            stored_links(&client, &cache, 7, true).await.unwrap();
            assert_eq!(server.requests().len(), 1);
        }

        #[tokio::test]
        async fn a_miss_fetches_the_detail_once_and_remembers_it() {
            let server = TestServer::start(|_| detail_reply()).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            let first = stored_links(&client, &cache, 7, false).await.unwrap();

            assert_eq!(first.height, Some(800));
            assert_eq!(server.requests().len(), 1);
            assert_eq!(server.requests()[0].path, "/api/app/videos/7");

            stored_links(&client, &cache, 7, false).await.unwrap();
            stored_links(&client, &cache, 7, true).await.unwrap();
            assert_eq!(server.requests().len(), 1);
        }

        #[tokio::test]
        async fn a_remembered_entry_without_a_playlist_url_is_completed_by_one_fetch() {
            let server = TestServer::start(|_| detail_reply()).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            // The list could not build a playlist URL (no R2 base URL loaded).
            cache.put(
                7,
                VideoLinks {
                    public_id: "abcdefghijkl".into(),
                    embed_url: Some("https://site.example.com/embed/abcdefghijkl".into()),
                    playlist_url: None,
                    storage_folder: None,
                    thumbnail_url: None,
                    custom_image_url: None,
                    storyboard_urls: Vec::new(),
                    detail_loaded: false,
                    width: None,
                    height: None,
                },
            );
            stored_links(&client, &cache, 7, false).await.unwrap();
            assert!(server.requests().is_empty());

            let links = stored_links(&client, &cache, 7, true).await.unwrap();

            assert!(links.playlist_url.is_some());
            assert_eq!(server.requests().len(), 1);
        }

        #[tokio::test]
        async fn a_failed_fetch_is_reported_and_nothing_is_remembered() {
            let server =
                TestServer::start(|_| Reply::json(404, json!({ "message": "gone" }))).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();

            assert!(stored_links(&client, &cache, 9, false).await.is_err());
            assert!(cache.is_empty());
        }

        #[tokio::test]
        async fn the_detail_carries_a_ready_made_shortcode_and_iframe_code() {
            let server = TestServer::start(|_| detail_reply()).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();
            let result = remember_and_fill(get_video(&client, 7).await, &cache, SITE);
            let value = serde_json::to_value(&result).unwrap();

            assert_eq!(
                value["video"]["shortcode"],
                json!("[hls_embed_vl id=\"abcdefghijkl\"]")
            );
            assert_eq!(
                value["video"]["iframeCode"],
                json!(iframe_code(
                    "https://site.example.com/embed/abcdefghijkl",
                    Some(1920),
                    Some(800)
                ))
            );
            // The detail is remembered for the next Copy / Open.
            assert!(cache.get(7).is_some());

            // An embed URL of another site gets neither snippet (same check as the Copy buttons).
            let foreign = remember_and_fill(
                get_video(&client, 7).await,
                &cache,
                Some("https://other.example.com"),
            );
            let foreign = serde_json::to_value(&foreign).unwrap();

            assert!(foreign["video"]["shortcode"].is_null());
            assert!(foreign["video"]["iframeCode"].is_null());
        }

        #[tokio::test]
        async fn a_failed_detail_is_passed_on_untouched() {
            let server = TestServer::start(|_| Reply::json(404, json!({}))).await;
            let client = client_for(&server);
            let cache = VideoLinkCache::default();
            let result = remember_and_fill(get_video(&client, 7).await, &cache, SITE);

            assert!(matches!(result, VideosGetResult::Err { .. }));
            assert!(cache.is_empty());
        }

        #[tokio::test]
        async fn delete_and_bulk_results_have_the_documented_shape() {
            let server = TestServer::start(|request| {
                if request.path.ends_with("bulk-destroy") {
                    Reply::json(
                        200,
                        json!({ "deleted": 2, "failed": 0, "skipped": 1, "message": "Deleted 2 videos (1 skipped)." }),
                    )
                } else {
                    Reply::json(200, json!({ "status": "skipped", "message": "Still processing." }))
                }
            })
            .await;
            let client = client_for(&server);

            assert_eq!(
                serde_json::to_value(delete_video(&client, 5).await).unwrap(),
                json!({ "ok": true, "status": "skipped", "message": "Still processing." })
            );
            assert_eq!(
                serde_json::to_value(bulk_delete_videos(&client, &[1, 2, 2, 3]).await).unwrap(),
                json!({ "ok": true, "deleted": 2, "failed": 0, "skipped": 1, "message": "Deleted 2 videos (1 skipped)." })
            );
            // The duplicate id was dropped before sending.
            assert_eq!(
                server.requests()[1].json(),
                json!({ "selected_ids": [1, 2, 3] })
            );
        }

        #[tokio::test]
        async fn errors_are_safe_and_never_carry_the_site_body_url_or_token() {
            let server = TestServer::start(|_| {
                Reply::json(
                    500,
                    json!({ "message": "SQLSTATE secret /var/www tok-secret" }),
                )
            })
            .await;
            let client = client_for(&server);
            let results = [
                serde_json::to_value(delete_video(&client, 5).await).unwrap(),
                serde_json::to_value(bulk_delete_videos(&client, &[5]).await).unwrap(),
                serde_json::to_value(update_video_title(&client, 5, "New").await).unwrap(),
            ];

            for value in results {
                assert_eq!(value["ok"], false);

                let text = value.to_string();

                for needle in ["SQLSTATE", "/var/www", "tok-secret", "127.0.0.1", "http"] {
                    assert!(!text.contains(needle), "{needle}: {text}");
                }
            }
        }

        fn png_file(dir: &tempfile::TempDir, name: &str, len: usize) -> String {
            let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

            bytes.resize(len, 1);

            let path = dir.path().join(name);

            std::fs::write(&path, bytes).unwrap();
            path.to_string_lossy().into_owned()
        }

        fn desktop_with(path: Option<String>) -> FakeDesktop {
            FakeDesktop {
                picked_image: path,
                ..FakeDesktop::default()
            }
        }

        #[tokio::test]
        async fn set_image_cancel_sends_nothing() {
            let server = TestServer::start(|_| Reply::json(200, json!({}))).await;
            let result = set_video_image(
                &client_for(&server),
                &VideoLinkCache::default(),
                5,
                &desktop_with(None),
            )
            .await;

            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({ "ok": true, "canceled": true })
            );
            assert!(server.requests().is_empty());
        }

        #[tokio::test]
        async fn set_image_uploads_the_picked_file_and_returns_the_new_url() {
            let dir = tempfile::tempdir().unwrap();
            // A PNG named .jpg is uploaded as a PNG, under our own file name.
            let path = png_file(&dir, "holiday-secret.jpg", 64);
            let server = TestServer::start(|_| {
                Reply::json(
                    200,
                    json!({ "label": "Custom image", "url": "https://cdn.example.com/c.png?v=2" }),
                )
            })
            .await;
            let result = set_video_image(
                &client_for(&server),
                &VideoLinkCache::default(),
                5,
                &desktop_with(Some(path)),
            )
            .await;

            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({ "ok": true, "canceled": false, "imageUrl": "https://cdn.example.com/c.png?v=2" })
            );

            let body = String::from_utf8_lossy(&server.requests()[0].body).into_owned();

            assert!(body.contains("filename=\"thumbnail.png\""));
            assert!(body.contains("Content-Type: image/png"));
            assert!(!body.contains("holiday-secret"));
        }

        #[tokio::test]
        async fn set_image_enforces_the_size_limit_before_uploading() {
            let dir = tempfile::tempdir().unwrap();
            let max = 5 * 1024 * 1024;
            let server = TestServer::start(|_| {
                Reply::json(200, json!({ "url": "https://c.example.com/a.png" }))
            })
            .await;
            let client = client_for(&server);

            let ok = set_video_image(
                &client,
                &VideoLinkCache::default(),
                5,
                &desktop_with(Some(png_file(&dir, "ok.png", max))),
            )
            .await;

            assert_eq!(serde_json::to_value(ok).unwrap()["ok"], true);
            assert_eq!(server.requests().len(), 1);

            let over = set_video_image(
                &client,
                &VideoLinkCache::default(),
                5,
                &desktop_with(Some(png_file(&dir, "big.png", max + 1))),
            )
            .await;

            assert_eq!(
                serde_json::to_value(over).unwrap(),
                json!({ "ok": false, "error": "The image is larger than 5 MB." })
            );
            assert_eq!(server.requests().len(), 1);
        }

        #[tokio::test]
        async fn set_image_rejects_non_images_dirs_and_symlinks_without_a_request() {
            let dir = tempfile::tempdir().unwrap();
            let fake = dir.path().join("fake.png");

            std::fs::write(&fake, b"GIF89a not accepted").unwrap();

            let server = TestServer::start(|_| Reply::json(200, json!({}))).await;
            let client = client_for(&server);
            // `inputs` is only mutated in the unix-only symlink block below.
            #[cfg_attr(not(unix), allow(unused_mut))]
            let mut inputs = vec![
                (
                    fake.to_string_lossy().into_owned(),
                    "Choose a JPG, PNG or WebP image.",
                ),
                (
                    dir.path().to_string_lossy().into_owned(),
                    "Choose a regular image file.",
                ),
            ];

            #[cfg(unix)]
            {
                let real = png_file(&dir, "real.png", 32);
                let link = dir.path().join("link.png");

                std::os::unix::fs::symlink(&real, &link).unwrap();
                inputs.push((
                    link.to_string_lossy().into_owned(),
                    "Choose a regular image file.",
                ));
            }

            for (path, message) in inputs {
                let result = set_video_image(
                    &client,
                    &VideoLinkCache::default(),
                    5,
                    &desktop_with(Some(path.clone())),
                )
                .await;
                let value = serde_json::to_value(result).unwrap();

                assert_eq!(value, json!({ "ok": false, "error": message }));
                assert!(!value.to_string().contains(&path));
            }

            assert!(server.requests().is_empty());
        }

        #[tokio::test]
        async fn set_and_remove_image_errors_never_leak_paths_bodies_urls_or_tokens() {
            let dir = tempfile::tempdir().unwrap();
            let path = png_file(&dir, "p.png", 32);
            let server = TestServer::start(|_| {
                Reply::json(500, json!({ "error": "image_store_failed", "message": "SQLSTATE /var/www tok-secret" }))
            })
            .await;
            let client = client_for(&server);
            let results = [
                serde_json::to_value(
                    set_video_image(
                        &client,
                        &VideoLinkCache::default(),
                        5,
                        &desktop_with(Some(path.clone())),
                    )
                    .await,
                )
                .unwrap(),
                serde_json::to_value(
                    remove_video_image(&client, &VideoLinkCache::default(), 5).await,
                )
                .unwrap(),
            ];

            assert_eq!(results[0]["error"], "Could not save the image.");
            assert_eq!(results[1]["error"], "Could not remove the image.");

            for value in results {
                let text = value.to_string();

                for needle in [
                    "SQLSTATE",
                    "/var/www",
                    "tok-secret",
                    "127.0.0.1",
                    "http",
                    path.as_str(),
                ] {
                    assert!(!text.contains(needle), "{needle}: {text}");
                }
            }
        }

        #[tokio::test]
        async fn remove_image_maps_success_and_no_custom_image() {
            let server = TestServer::start(|request| {
                if request.path.starts_with("/api/app/videos/1/") {
                    Reply::json(200, json!({ "ok": true }))
                } else {
                    Reply::json(404, json!({ "error": "no_custom_image" }))
                }
            })
            .await;
            let client = client_for(&server);

            assert_eq!(
                remove_video_image(&client, &VideoLinkCache::default(), 1).await,
                ActionResult::Ok
            );
            assert_eq!(
                remove_video_image(&client, &VideoLinkCache::default(), 2).await,
                ActionResult::err("No custom thumbnail to remove.")
            );
        }

        #[tokio::test]
        async fn update_title_returns_the_updated_detail() {
            let server = TestServer::start(|request| {
                Reply::json(
                    200,
                    json!({ "id": 5, "public_id": "abcdefghijkl", "title": request.json()["title"], "status": "ready" }),
                )
            })
            .await;
            let value = serde_json::to_value(
                update_video_title(&client_for(&server), 5, "  New name ").await,
            )
            .unwrap();

            assert_eq!(value["ok"], true);
            assert_eq!(value["video"]["title"], "New name");
        }
    }
}
