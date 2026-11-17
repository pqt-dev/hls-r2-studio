# API cho app desktop (`/api/app`)

[English](DESKTOP-APP-API.md) | **Tiếng Việt**

API JSON dùng cho app desktop. Nguồn sự thật của hợp đồng API: `routes/api.php` và `app/Http/Controllers/Api/App/*`. Thiết kế ban đầu nằm ở `docs/DESKTOP-APP-SPEC.vi.md` (mục 3.5); file này là tài liệu đầy đủ từng endpoint, gồm cả các endpoint quản lý thêm sau. Thông báo lỗi/UI text trong code luôn bằng tiếng Anh.

## Quy ước chung

- **Xác thực**: mọi endpoint trừ `POST /api/app/login` cần header `Authorization: Bearer <token>` (token Sanctum nhận khi đăng nhập). Không bao giờ dùng cookie/session. Thiếu hoặc token đã thu hồi: `401 {"message": "Unauthenticated."}`.
- **Định dạng**: request và response đều JSON (gửi `Accept: application/json`). Mọi response có `Cache-Control: no-store`.
- **Phân quyền**: site chỉ có một bộ dữ liệu admin. Video không có chủ sở hữu, nên token hợp lệ nào cũng làm được đúng những gì admin web làm được với video. KHÔNG mở: cấu hình R2, đổi mật khẩu, quản lý app token, report, ghi activity log, đăng nhập web.
- **Throttle**: mọi endpoint cần auth dùng chung `throttle:app-api` (60 request/phút/token). Vượt: `429` kèm `Retry-After`. `POST /videos/{video}/image` thêm `throttle:20,1` (20 lần/phút) như web admin.
- **`{video}`**: là `id` số của video (không phải `public_id`). Giá trị không phải số không khớp route nào (404).
- **Lỗi**:
    - `404 {"error": "not_found"}`: không có video hoặc không có route.
    - `422`: body validation chuẩn của Laravel `{"message": "...", "errors": {"field": ["..."]}}`.
    - Lỗi nghiệp vụ: `{"error": "<code>", "message": "<text>"}` (endpoint cũ có thể không có `message`).
    - `429`: bị throttle. `5xx`: chỉ thông báo chung; không bao giờ trả stack trace, lỗi SDK hay credentials.
- Timestamp là chuỗi ISO 8601 (kèm múi giờ).

## Bảng endpoint

| Method và path                                 | Tên route                      | Mục đích                                     | Throttle thêm  |
| ---------------------------------------------- | ------------------------------ | -------------------------------------------- | -------------- |
| `POST /api/app/login`                          | `api.app.login`                | Lấy token (không cần auth, `throttle:app-login`) | 5/phút theo IP+user |
| `POST /api/app/logout`                         | `api.app.logout`               | Thu hồi token hiện tại                       |                |
| `GET /api/app/config`                          | `api.app.config`               | Config R2 + transcode                        |                |
| `GET /api/app/videos`                          | `api.app.videos.index`         | Danh sách có phân trang                      |                |
| `POST /api/app/videos`                         | `api.app.videos.store`         | Đăng ký video đã upload                      |                |
| `GET /api/app/videos/status`                   | `api.app.videos.status`        | Poll trạng thái nhiều video                  |                |
| `DELETE /api/app/videos/bulk-destroy`          | `api.app.videos.bulk-destroy`  | Xoá nhiều video                              |                |
| `GET /api/app/videos/{video}`                  | `api.app.videos.show`          | Chi tiết video                               |                |
| `PUT /api/app/videos/{video}`                  | `api.app.videos.update`        | Đổi tên                                      |                |
| `DELETE /api/app/videos/{video}`               | `api.app.videos.destroy`       | Xoá một video                                |                |
| `GET /api/app/videos/{video}/status-log`       | `api.app.videos.status-log`    | Lịch sử trạng thái                           |                |
| `POST /api/app/videos/{video}/image`           | `api.app.videos.image.store`   | Upload thumbnail tuỳ chỉnh                   | 20/phút        |
| `DELETE /api/app/videos/{video}/image`         | `api.app.videos.image.destroy` | Xoá thumbnail tuỳ chỉnh                      |                |
| `GET /api/app/overview`                        | `api.app.overview`             | Số liệu dashboard                            |                |
| `GET /api/app/logs`                            | `api.app.logs.index`           | Dữ liệu trang Logs                           |                |

Login, logout, config, list và register được mô tả ở `docs/DESKTOP-APP-SPEC.vi.md` mục 3.5; list là `GET /videos?page=&per_page=(1..50, mặc định 24)&q=` trả `{"data": [...], "meta": {"page","per_page","total","last_page"}}`. Các mục dưới đây là các endpoint quản lý.

## GET /api/app/videos/{video}

Auth: bearer. 200: object chi tiết (ví dụ đầy đủ ở bản tiếng Anh, `DESKTOP-APP-API.md`):

```json
{
    "id": 12,
    "public_id": "abcdefghij12",
    "title": "My clip",
    "original_filename": "my clip.mp4",
    "original_size_bytes": 1234,
    "status": "ready",
    "stage": "ready",
    "progress": 100,
    "error": null,
    "duration": 12.5,
    "output_width": 1280,
    "output_height": 720,
    "output_fps": 30,
    "output_bitrate_kbps": 2500,
    "output_codec": "h264",
    "embed_url": "https://site.example/embed/abcdefghij12",
    "playlist_url": "https://cdn.example.com/2026/11/03/clip-abcdefghij12/playlist.m3u8",
    "thumbnail_url": "https://cdn.example.com/.../thumbnail.jpg",
    "has_custom_image": true,
    "custom_image_url": "https://cdn.example.com/.../custom-clip-abcdefghij12.jpg?v=1793700000",
    "storyboards": {
        "3x3": { "url": "https://cdn.example.com/.../storyboard_3x3.jpg", "columns": 3, "count": 9 },
        "5x5": { "url": "https://cdn.example.com/.../storyboard_5x5.jpg", "columns": 5, "count": 25 }
    },
    "embed_storyboard": { "url": "https://cdn.example.com/.../storyboard_5x5.jpg", "number": 25, "column": 5, "width": 160, "height": 160 },
    "created_at": "2026-11-03T10:00:00+00:00",
    "updated_at": "2026-11-03T10:05:00+00:00"
}
```

- `status`: `pending`, `processing`, `ready` hoặc `failed`. Video do app desktop đăng ký được tạo với `stage=ready`, `progress=100`.
- `error` là `null` trừ khi `status` là `failed`; khi đó là `{"message", "detail", "failed_at"}`. `detail` đã được làm sạch phía server (thay đường dẫn, bỏ ký tự điều khiển, cắt độ dài).
- `embed_storyboard` là lưới mà player embed dùng (lưới lớn nhất đã tạo) hoặc `null`.
- Các field URL là `null` khi file không có hoặc R2 chưa cấu hình. Không bao giờ trả: R2 credentials, bucket/endpoint, object key nội bộ, `upload_id`.
- Lỗi: 404 `not_found`.

## PUT /api/app/videos/{video}

Body: `{"title": "bắt buộc, string, tối đa 255"}`; field khác bị bỏ qua. 200: object chi tiết như trên. Lỗi: 404, 422 (`title`).

## GET /api/app/videos/status?ids=1,2,3

Dùng để polling. `ids` bắt buộc: danh sách số nguyên dương cách nhau dấu phẩy (giá trị rác và trùng bị loại, chỉ đọc tối đa **50** id khác nhau, phần dư bị bỏ qua). 200:

```json
{ "data": [ { "id": 1, "status": "processing", "stage": "transcoding", "progress": 42 } ] }
```

Id không tồn tại bị bỏ; không có id hợp lệ thì `{"data": []}`. Lỗi: 422 (thiếu `ids`).

## GET /api/app/videos/{video}/status-log

Lịch sử trạng thái phía server, cũ nhất trước (không gồm dòng activity-log từ client). 200:

```json
{ "data": [ { "status": "processing", "stage": "transcoding", "progress": 50, "created_at": "2026-11-03T10:01:00+00:00" } ] }
```

Lỗi: 404.

## DELETE /api/app/videos/{video}

Xoá bản ghi và, nếu setting của site "delete from R2 on destroy" đang bật, cả thư mục R2 của video. Kết quả nằm ở `status`; HTTP luôn là 200 cho cả ba trường hợp (giống JSON của web admin):

| `status`  | Khi nào                                                      |
| --------- | ------------------------------------------------------------ |
| `deleted` | Đã xoá (message cho biết file R2 có bị giữ lại không)        |
| `skipped` | Video đang `pending`/`processing`; không đổi gì              |
| `failed`  | Dọn R2 thất bại; bản ghi được giữ lại để thử lại             |

```json
{ "status": "deleted", "message": "Video has been deleted." }
```

Lỗi: 404.

## DELETE /api/app/videos/bulk-destroy

Body: `{"selected_ids": [1, 2, 3]}`: từ 1 đến **100** id, mỗi id là số nguyên có tồn tại. 200:

```json
{ "deleted": 2, "failed": 0, "skipped": 1, "message": "Deleted 2 videos (1 skipped: still processing)." }
```

Video đang xử lý bị bỏ qua; lỗi từng video được đếm. Lỗi: 422 (`selected_ids`, `selected_ids.N` với id không tồn tại, quá 100 id).

## POST /api/app/videos/{video}/image

`multipart/form-data`, field `image`: bắt buộc, file `jpg|jpeg|png|webp`, tối đa 5 MB (5120 KB). Loại file được kiểm tra theo NỘI DUNG (MIME sniffing), không chỉ đuôi file. Không giới hạn kích thước ảnh (pixel), giống web admin. Lưu trên R2 tại `<thư mục video>/custom-<tên thư mục>.<ext>`; thay bằng đuôi khác thì object cũ bị xoá. Throttle: 20/phút.

200: `{"label": "Custom image", "url": "https://cdn.example.com/.../custom-....jpg?v=1793700000"}`

Lỗi: 404; 422 validation (`image`); 422 `{"error": "no_storage_folder", "message": ...}` (video chưa có thư mục R2); 500 `{"error": "image_store_failed", "message": ...}`; 429.

## DELETE /api/app/videos/{video}/image

200 `{"ok": true}`. Lỗi: 404 `not_found` (video) hoặc 404 `{"error": "no_custom_image", ...}`; 500 `{"error": "image_delete_failed", ...}` (DB vẫn giữ path để thử xoá lại).

## GET /api/app/overview

Các con số của dashboard overview trên web. 200:

```json
{
    "videos": { "total": 5, "ready": 2, "processing": 2, "failed": 1 },
    "system": {
        "cpu_percent": 12, "cpu_cores": 4, "load_avg_1min": 0.5,
        "ram_percent": 40, "ram_used_gb": 3.1, "ram_total_gb": 8,
        "disk_percent": 55, "disk_used_gb": 20.5, "disk_total_gb": 40
    }
}
```

`processing` gồm cả `pending` và `processing`. CPU và RAM là `null` khi server không đọc được (máy không phải Linux).

## GET /api/app/logs

Trang Logs của web dưới dạng JSON. Mỗi item (`LogItem`): `id, public_id, title, original_filename, status, stage, progress, error_message, error_detail, failed_at, created_at, updated_at`.

- Không có `type`: bản tóm tắt như trang web, 200:
  `{"counts": {"total","success","error","processing"}, "success": [LogItem x10 mới nhất], "error": [LogItem x10 lỗi mới nhất], "processing": [LogItem x25, cũ nhất trước]}`.
- Có `type=success|error|processing` (kèm `page`, `per_page` 1..50 mặc định 24 tuỳ chọn): phân trang như list video, 200:
  `{"counts": {...}, "data": [LogItem], "meta": {"page","per_page","total","last_page"}}`.

Lỗi: 422 (`type`, `page`, `per_page`).

## Ghi chú deploy

Các endpoint này không cần migration.
