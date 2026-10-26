> [English](TROUBLESHOOTING.md) | Tiếng Việt

# Xử lý sự cố, cấu trúc dữ liệu và Q&A

> Quay lại [README](../README.vi.md). Các bước cài đặt production nằm trong [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md) ("bước 4" được nhắc bên dưới là bước chạy local trong README).

## Cấu trúc dữ liệu

**`videos`** — mỗi dòng là một video: tiêu đề, tên/dung lượng file gốc, trạng thái xử lý (`status`: pending/processing/ready/failed, `stage`: queued/merging/transcoding/generating_thumbnail/generating_storyboard/uploading_r2/ready/failed, `progress` %), đường dẫn tới các file HLS/thumbnail/storyboard trên R2, thông số kỹ thuật thực tế của video đầu ra (độ phân giải, fps, bitrate, codec, thời lượng) và lỗi nếu xử lý thất bại.

**`settings`** — bảng cấu hình, luôn chỉ có đúng 1 dòng (`id = 1`, lấy qua `Setting::current()`): có xoá file trên R2 khi xoá video hay không, cấu hình transcode mặc định (độ phân giải/segment/fps), số video hiển thị mỗi trang, múi giờ hiển thị.

**`users`** — tài khoản đăng nhập admin (username + mật khẩu), dùng cơ chế Auth chuẩn của Laravel.

**`reports`** — báo cáo lỗi phát video gửi từ trang public: URL của trang đang phát, lý do (`reason`, nullable: `not_loading`/`not_playing`/`lag`/`wrong_video`/`other`), video khớp (`video_id`, nullable — ID video được lấy từ URL trang dạng `.../embed/{id}` khi video đó tồn tại, nếu không thì để trống; là foreign key của database tới `videos.id` với `ON DELETE SET NULL`, nên xoá video sẽ xoá giá trị này), ghi chú của người báo cáo, trạng thái (`new`/`resolved`), số lần cùng URL đó được báo cáo lại (`report_count`; một cột stored generated có ràng buộc unique là `active_report_key` chứa SHA-256 của URL khi trạng thái là `new` và NULL trong các trường hợp còn lại, nên mỗi URL chỉ có tối đa một báo cáo `new` ngay cả khi gửi đồng thời), thời điểm báo cáo gần nhất, thời điểm admin xử lý xong và người xử lý (`resolved_by`, nullable — ID của admin user đã bấm resolve; foreign key tới `users.id` với `ON DELETE SET NULL`). `video_status_logs.video_id` là foreign key tới `videos.id` với `ON DELETE CASCADE`, nên xoá video cũng xoá luôn các status log của nó.

## Lỗi thường gặp, cách xử lý và Q&A

| Lỗi gặp phải | Nguyên nhân | Cách xử lý |
|---|---|---|
| `destination path '.' already exists` khi `git clone` (aaPanel) | Thư mục site chứa các file ẩn do aaPanel tự tạo mà `ls` không hiển thị | Clone vào một thư mục tạm rồi `mv` đè lên |
| `composer install` báo thiếu `ext-fileinfo` | Extension `fileinfo` chưa được bật cho phiên bản PHP đang dùng | Bật qua aaPanel → PHP → Install extensions (hoặc cài extension tương ứng trên VPS thuần) |
| `composer install` báo một package Symfony yêu cầu PHP >= 8.4 | Đang chạy PHP < 8.4 trong khi `composer.lock` khoá phiên bản cần 8.4 | Cài/nâng cấp PHP lên 8.4 |
| `composer install` báo lệch `composer-runtime-api` | Composer cài sẵn quá cũ (< 2.2) | `composer self-update` |
| Trang trắng, lỗi `open_basedir restriction in effect` (aaPanel) | Công tắc "Anti-XSS attack" đang bật, giới hạn PHP chỉ đọc được `public/` | Tắt công tắc này tại site → Directory |
| `404 Not Found` khi truy cập `/login` (trang chủ `/` vẫn chạy) | Thiếu rewrite rule pretty-URL cho Laravel | Bật template URL rewrite của Laravel (aaPanel) hoặc kiểm tra lại `try_files` trong cấu hình Nginx (VPS thuần) |
| Upload lỗi ngay từ đầu với "The server does not have enough free disk space to process this upload." | Server cần trống khoảng 2 lần dung lượng file (file gốc đã ghép cộng với output HLS) cộng thêm một chút dự phòng | Giải phóng dung lượng đĩa trên server hoặc upload file nhỏ hơn |
| Video bị kẹt ở "Processing" mãi, log có `Job timed out` | Queue worker thiếu flag `--timeout`, nên Laravel kill job sau 60s mặc định | Thêm `--timeout=172800` vào `ExecStart` trong systemd unit |
| Console báo `You must pass your app key when you instantiate Pusher` | `REVERB_*`/`VITE_REVERB_*` bị thiếu trong `.env` tại thời điểm `npm run build`, hoặc Reverb chưa được cấu hình | Điền đủ các biến, chạy lại `npm run build` và đảm bảo Reverb đang chạy |
| WebSocket kết nối được nhưng tiến độ transcode không cập nhật trực tiếp; gửi event qua tinker báo `Pusher error: 404 Not Found` | Thiếu `location /apps/` trong cấu hình reverse proxy của Reverb | Thêm một `location /apps/` proxy tới cùng cổng Reverb |
| `systemctl restart nginx`/`php-fpm-84` báo lỗi nhưng service vẫn đang chạy (aaPanel) | Script khởi động kiểu LSB xử lý sai "restart" khi service đang chạy | Dùng `/etc/init.d/nginx reload` và `/etc/init.d/php-fpm-84 restart` thay cho `systemctl restart` |

**Q: Cả site bị đứng khi đang upload video, và mở trang Upload rất chậm?**
Chuyện này chỉ xảy ra với dev server (`php artisan serve`) vì nó đơn luồng: khi một request đang chạy (upload một chunk 8 MB) thì mọi request khác, kể cả chuyển trang và polling trạng thái, đều phải chờ. Hãy khởi động bằng `PHP_CLI_SERVER_WORKERS=4 php artisan serve --no-reload` (xem bước 4 của README). Trên production với Nginx + PHP-FPM thì không bị, vì server xử lý request đồng thời.

**Q: Tại sao web app chậm khi đang transcode video?**
ffmpeg tốn nhiều CPU và dùng chung VPS với PHP-FPM và MySQL. Hãy giữ `FFMPEG_NICE=10` (hạ mức ưu tiên CPU của ffmpeg), đặt `FFMPEG_THREADS` (khoảng số core CPU / số queue worker, ví dụ `2`), hoặc chạy ít queue worker hơn, rồi restart các queue worker.

**Q: Quên mật khẩu admin thì làm sao?**
Chạy lại `php artisan admin:create <username>` (hoặc dùng đường dẫn PHP 8.4 đầy đủ nếu bạn dùng aaPanel) — lệnh này upsert theo `username`, nên chạy lại với cùng username sẽ đổi mật khẩu của tài khoản đó thay vì báo lỗi trùng.

**Q: Video bị kẹt ở trạng thái processing và không bao giờ xong?**
Kiểm tra xem queue worker còn chạy không (`systemctl status hls-r2-studio-queue@1`, hoặc xem terminal đang chạy `queue:work`) và kiểm tra error log (`journalctl -u hls-r2-studio-queue@1 -f`). Nếu log có `Job timed out`, xem dòng xử lý tương ứng ở bảng phía trên.

**Q: Làm sao cho phép trang video player ở domain khác gửi báo cáo?**
Thêm domain đó vào `CORS_ALLOWED_ORIGINS` trong `.env` (phân tách bằng dấu phẩy; mặc định chỉ cho phép `https://toicovl.com`). Để từ chối thêm các báo cáo có host của `page_url` không phải của bạn, đặt `REPORT_ALLOWED_HOSTS` (các host phân tách bằng dấu phẩy, khớp chính xác; để trống nghĩa là không giới hạn). Route `/api/reports` có rate limit 5 request mỗi 10 phút theo mỗi IP, cộng thêm 20 request mỗi 10 phút theo mỗi `page_url`.

**Q: Đổi giới hạn upload ở đâu?**
Upload được chia chunk. Giới hạn tổng dung lượng file là `UPLOAD_MAX_SIZE_MB` trong `.env` (mức app). Mỗi request chỉ mang một chunk (`UPLOAD_CHUNK_SIZE_MB`, mặc định 8), nên `client_max_body_size` của Nginx, `upload_max_filesize` và `post_max_size` của php.ini chỉ cần lớn hơn kích thước chunk (hướng dẫn deploy dùng 100M). Cloudflare Free/Pro giới hạn request body ở 100 MB, nên hãy giữ chunk tối đa khoảng 90 MB. Lỗi 413 nghĩa là một trong các giới hạn đó đang nhỏ hơn kích thước chunk. Xem [mục 9 của DEPLOYMENT.vi.md](DEPLOYMENT.vi.md#9-web-server-và-ssl).

**Q: Còn tuỳ chọn nâng cao nào khác không?**
Không bắt buộc, đã có giá trị mặc định hợp lý; thêm vào `.env` nếu bạn muốn thay đổi:
```env
UPLOAD_ABANDONED_TTL_HOURS=24       # how long before abandoned upload chunks are cleaned up
TRANSCODE_ORPHANED_TTL_HOURS=60     # how long before crashed/stuck HLS transcode temp directories are cleaned up
UPLOAD_ORPHANED_TTL_HOURS=72        # how long before orphaned original video files are cleaned up
TRANSCODE_TIMEOUT_MULTIPLIER=8      # multiplier applied to video length to compute the HLS transcode timeout
STORYBOARD_TILE_SIZE=160            # size (px) of each tile in the storyboard grid image
REVERB_ALLOWED_ORIGINS=*                 # comma-separated origins allowed to connect to Reverb (default `*`); hostnames only, no scheme; in production set it to your real domain, e.g. embed.example.com
KEEP_ORIGINAL_UPLOAD=false          # true keeps original uploads on disk; the orphaned-upload cleanup then does nothing
DB_QUEUE_RETRY_AFTER=176400         # must be greater than the queue worker's --timeout
```

**Q: App chạy sau một HTTPS reverse proxy (aaPanel/Nginx/Cloudflare Tunnel) nhưng link asset lại ra `http://` (mixed content)?**
Đặt `FORCE_HTTPS=true` trong `.env` (nếu hoàn toàn không đặt `FORCE_HTTPS` thì `APP_ENV=production` là đủ, nhưng `FORCE_HTTPS=false` copy từ `.env.example` sẽ ghi đè) — khi đó Laravel sẽ ép dùng `https` cho mọi URL được tạo ra. Không bật tuỳ chọn này trên môi trường dev local không có HTTPS thật, nếu không trình duyệt sẽ không tải được asset.

**Q: Làm sao để rate limit theo từng IP đáng tin cậy khi chạy sau reverse proxy?**
Sau Cloudflare (orange cloud), đặt `TRUSTED_PROXIES=cloudflare` trong `.env`; cấu hình này chỉ tin các dải IP Cloudflare đã công bố (có thể kết hợp với các mục khác nếu cần, ví dụ `cloudflare,127.0.0.1`). Giá trị mặc định `*` tin mọi proxy, nên client có thể tự gửi `X-Forwarded-For` và `X-Forwarded-Host` để né throttling theo IP (login, embed, upload, reports). Sau một reverse proxy khác, hãy đặt thành IP của proxy đó (phân tách bằng dấu phẩy). Chạy `php artisan config:clear` sau khi thay đổi. Danh sách Cloudflare tích hợp sẵn nên được đối chiếu với https://www.cloudflare.com/ips/ định kỳ.

**Q: Rate limit mặc định của các API là bao nhiêu?**
Login: 5 request/phút. `/uploads/init`: 30 request/phút. `/uploads/{id}/chunk`: 900 request/phút. POST activity log: 120 request/phút. Các request upload có rate limit riêng (mỗi loại có bộ đếm riêng), cấu hình trong `config/videos.php` (`upload_rate_limits`). `/api/reports`: 5 request/10 phút theo mỗi IP (cộng thêm 20 request/10 phút theo mỗi `page_url`). Việc gặp lỗi "Too Many Requests" khi thao tác quá nhanh là do các giới hạn này.

**Q: Chuyện gì xảy ra nếu Redis ngừng hoạt động?**
Với `CACHE_STORE=failover`, app sẽ chuyển sang bảng cache của database, nên login, embed và các route có throttle khác vẫn hoạt động; Laravel dispatch một event `CacheFailedOver` khi điều này xảy ra. Bộ đếm rate limit bắt đầu lại từ 0 trên store dự phòng. Kiểm tra bằng `redis-cli ping` (phải trả lời `PONG`), rồi cài hoặc restart Redis (`sudo systemctl restart redis-server`); app sẽ tự động dùng lại Redis.

## Ghi chú bổ sung

**Phần trăm tiến độ**: mỗi video có một phần trăm tiến độ tổng, tính từ lúc bạn bấm Upload cho đến khi output HLS nằm trên R2 (chỉ đạt 100% khi video đã ready). Mỗi giai đoạn (upload, merge, transcode, thumbnail, storyboard, upload lên R2) được chia một phần tỷ lệ với thời gian ước tính của nó, và phần này thích ứng theo dung lượng file: video nhẹ dành phần lớn tỷ trọng cho các chi phí cố định, video nặng dành cho các giai đoạn phụ thuộc dung lượng. Các ước tính nằm trong `config/videos.php` ở mục `progress` và nên được tinh chỉnh theo từng deployment (tốc độ CPU và mạng làm lệch các tỷ trọng).

**Activity Log**: Activity Log của trang Upload được lưu trong database cho 100 upload/video gần nhất (`config/videos.php`, `activity_log`) và trang hiển thị 10 mục gần nhất, nên khi reload bạn thấy lại những gì đã hiển thị realtime. Các dòng log do trình duyệt ghi chỉ được lưu khi trình duyệt kết nối được tới server.

**Tính năng khác**: trang cài đặt (đổi mật khẩu, tuỳ chọn xử lý, số video mỗi trang, múi giờ hiển thị, allowlist domain embed); danh sách video dạng bảng có phân trang, xoá hàng loạt và thông số kỹ thuật (độ phân giải, fps, codec, bitrate, dung lượng); có thể chạy song song nhiều worker để transcode nhiều video cùng lúc; admin có thể xem các báo cáo lỗi phát video và đánh dấu đã xử lý.
