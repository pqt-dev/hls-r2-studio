> [English](DOMAIN-BLOCK-PLAYBOOK.md) | Tiếng Việt

# Playbook xử lý khi domain bị chặn

> Liên quan: [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md) (cài đặt server và Cloudflare), [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md) (lỗi, Q&A). Quay lại [README](../README.vi.md).

Cách chuẩn bị domain dự phòng và chuyển sang chúng khi một domain bị chặn. "Bị chặn" nghĩa là người dùng ở Việt Nam không truy cập được domain đó. Mỗi host có thể bị chặn độc lập, nên mỗi mục dùng được riêng. Không bao giờ dán nội dung `.env`, mật khẩu hay key vào ticket hoặc chat.

## Tên gọi và nơi thay đổi

| Tên | Vai trò |
|---|---|
| `main-site.com` / `new-main-site.com` | Website WordPress: hiện tại / dự phòng |
| `embed-site.com` / `new-embed-site.com` | Dashboard này và host của iframe (`/embed/ID`): hiện tại / dự phòng |
| `cdn.embed-site.com` / `cdn.new-embed-site.com` | R2 custom domain phục vụ `.m3u8` và `.ts`: hiện tại / dự phòng. Nó là subdomain của domain embed, nên bị chặn cùng lúc |

Server: một VPS aaPanel chạy cả hai site, thao tác qua SSH bằng root. Dashboard: `/www/wwwroot/embed-site.com`. WordPress: `/www/wwwroot/main-site.com`. PHP CLI: `/www/server/php/84/bin/php`. User của site: `www`. Bản WP Staging: `/www/wwwroot/main-site.com/staging` (Verify đường dẫn thật một lần; nhãn aaPanel và plugin cũng thay đổi theo phiên bản).

Backup: playbook này dựa vào backup tự động của aaPanel và không tự tạo backup.

| Thiết lập | Nơi sửa |
|---|---|
| `HLS_EMBED_HOST` | WPCode snippet "HLS Embed shortcode" trên website WordPress |
| `APP_URL`, `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME`, `REVERB_ALLOWED_ORIGINS`, `R2_URL` (phần bổ sung tùy chọn, mặc định rỗng: `CORS_ALLOWED_ORIGINS`, `REPORT_ALLOWED_HOSTS`) | `.env` của dashboard (aaPanel > Files, hoặc SSH `nano`) |
| Embed allowlist (domain của site chính: được phép nhúng player, gửi báo cáo qua CORS và là host được chấp nhận trong báo cáo) | Dashboard Settings > Embed protection > Embed allowlist. Nằm trong database, KHÔNG nằm trong `.env` |
| R2 CORS policy, R2 custom domain | Cloudflare > R2 > bucket > Settings |
| Cache và Redirect rule, DNS, chế độ SSL, Origin certificate | Cloudflare, trong zone của domain đó |
| Thêm domain, cài certificate | aaPanel > Website > site hiện có |
| URL tuyệt đối của ảnh FIFU và của chính WordPress | Database WordPress, bằng `wp search-replace` |

## Site embed (`embed-site.com` sang `new-embed-site.com`)

Bài viết chỉ lưu shortcode, nên host embed chỉ đổi ở một chỗ (`HLS_EMBED_HOST`).

### Chuẩn bị

1. Mua `new-embed-site.com` (không dùng `.vn`), thêm thành zone trong cùng tài khoản Cloudflare với R2, và thêm DNS record loại A trỏ tới IP của VPS, Proxied.
2. aaPanel: Website > site dashboard hiện có > Domain Manager > thêm domain (không bao giờ clone site). Trong Cloudflare tạo Origin CA certificate MỚI cho domain đó, dán vào tab SSL của site, và chỉ sau đó mới đặt Cloudflare SSL là Full (strict), nếu không sẽ bị 521/526. Đồng thời thêm các rule Cloudflare cho zone mới: bước 1, 3 và 5 của [DEPLOYMENT.vi.md mục 11](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare).
3. Cloudflare > R2 > bucket > Settings: gắn `cdn.new-embed-site.com` vào cùng bucket, và trong CORS policy thêm `https://new-embed-site.com` (giữ origin cũ). Verify: một bucket có thể có nhiều custom domain.

   ```json
   [{"AllowedOrigins":["https://embed-site.com","https://new-embed-site.com"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
4. Test trên WP Staging: đặt `HLS_EMBED_HOST` thành `https://new-embed-site.com`, purge cache staging, mở một bài có `[hls_embed_vl id="N"]`, rồi kiểm tra header. Việc phát video có thể trả 403 cho tới khi đổi `R2_URL` (hotlink rule); bản thân iframe phải load được. Verify: asset của trang embed có phụ thuộc `APP_URL` không (DevTools > Network: có request nào tới `embed-site.com` không?).

   ```bash
   curl -sI https://new-embed-site.com/embed/ID
   ```
5. Các giá trị `.env` cần đổi được liệt kê ở bước 2 của phần Ứng phó.

### Ứng phó

1. Xác nhận bị chặn từ một mạng ở Việt Nam.
2. Sửa `.env` của dashboard (aaPanel > Files, hoặc SSH `nano`) và đặt các dòng sau. `REVERB_PORT` và `REVERB_SCHEME` giữ nguyên. `R2_URL` cũng đổi ở đây, vì cdn bị chặn cùng domain embed.

   ```env
   APP_URL=https://new-embed-site.com
   REVERB_HOST=new-embed-site.com
   REVERB_ALLOWED_ORIGINS=new-embed-site.com
   R2_URL=https://cdn.new-embed-site.com
   ```
3. Nạp lại config và restart. Restart queue làm gián đoạn video đang transcode, nên chỉ chạy khi không có video nào đang xử lý. Artisan chạy bằng user của site ([DEPLOYMENT.vi.md "Vận hành"](DEPLOYMENT.vi.md#vận-hành)); cần `npm run build` vì `REVERB_*` được nhúng vào JS.

   ```bash
   cd /www/wwwroot/embed-site.com
   sudo -u www /www/server/php/84/bin/php artisan config:clear
   npm run build
   systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2
   systemctl restart hls-r2-studio-reverb
   systemctl restart hls-r2-studio-scheduler
   ```
4. WPCode snippet "HLS Embed shortcode" trên website WordPress: đổi `HLS_EMBED_HOST` thành `https://new-embed-site.com`, lưu, giữ ở trạng thái Active.
5. Purge TẤT CẢ page cache (plugin cache và Cloudflare).
6. Kiểm tra (mong đợi 200). Sau đó mở một bài có video từ một mạng ở Việt Nam: page source hiển thị iframe từ `https://new-embed-site.com/embed/`.

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://new-embed-site.com/up
   ```

## Custom domain (R2): `cdn.embed-site.com` sang `cdn.new-embed-site.com`

Chỉ `R2_URL` thay đổi: database lưu đường dẫn tương đối và URL được dựng lúc runtime. Không upload lại, không đổi database.

### Chuẩn bị

1. Gắn `cdn.new-embed-site.com` và cập nhật CORS (Chuẩn bị bước 3 của site embed).
2. Cache rule và hotlink rule cho host mới: bước 4 và 6 của [DEPLOYMENT.vi.md mục 11](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare). Hotlink rule phải cho phép domain embed MỚI làm Referer.

### Ứng phó

1. `R2_URL` đã được đặt ở bước 2 phần Ứng phó của site embed. Lấy path `.m3u8` của một video đã ready từ DevTools > Network (chỉ path) và kiểm tra (mong đợi 200; path của một segment `.ts` kiểm tra tương tự):

   ```bash
   curl -I https://cdn.new-embed-site.com/<path>.m3u8
   ```
2. Phát một video trên trình duyệt: console không có lỗi CORS, các request đi tới `cdn.new-embed-site.com`, video cũ vẫn phát được.

## FIFU (đi theo domain cdn)

FIFU lưu URL cdn tuyệt đối trong database WordPress; shortcode không sửa được, `wp search-replace` ghi đè chúng (an toàn với serialized). Chạy WP-CLI bằng user của site và luôn `--dry-run` trước.

### Chuẩn bị

1. Kiểm tra WP-CLI, rồi chạy dry run. Số lượng theo từng bảng cho biết host cdn được lưu ở đâu (hãy tin kết quả này; cấu trúc nội bộ của FIFU chưa được kiểm tra). Giữ `--skip-columns=guid`; nếu một lần dry run với `--include-columns=guid` có kết quả khớp thì bỏ flag đó.

   ```bash
   sudo -u www wp --info
   ```
   ```bash
   sudo -u www wp search-replace 'https://cdn.embed-site.com' 'https://cdn.new-embed-site.com' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=/www/wwwroot/main-site.com
   ```
2. Diễn tập trên WP Staging: lặp lại dry run với `--path=/www/wwwroot/main-site.com/staging`.

### Ứng phó

1. Trước khi thay đổi database, kiểm tra trong aaPanel rằng bản backup tự động mới nhất của database WordPress đã tồn tại.
2. Chạy thật (sau khi phần custom domain đã xong):

   ```bash
   sudo -u www wp search-replace 'https://cdn.embed-site.com' 'https://cdn.new-embed-site.com' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=/www/wwwroot/main-site.com
   ```
3. Purge cache (plugin cache, Cloudflare, cache của FIFU nếu có). Kiểm tra thumbnail ở trang chủ, một trang archive và một bài viết đơn, và `og:image` trong page source.

Phương án dự phòng: nếu không cài được WP-CLI, plugin Better Search Replace cài trong chính site WordPress đó có thể làm cùng việc từ trang admin (dry run trước, tắt "Replace GUIDs").

## Site chính (`main-site.com` sang `new-main-site.com`)

WordPress lưu URL tuyệt đối của chính domain của nó (posts, postmeta, options, thường là serialized), nên dùng `wp search-replace`. Chỉ cần khi chính `main-site.com` bị chặn.

### Chuẩn bị

1. Mua `new-main-site.com` (không dùng `.vn`) và thêm thành zone Cloudflare.
2. Search Console: xác minh cả hai property (`main-site.com` và `new-main-site.com`).
3. Dry run: số lượng cho biết domain được lưu ở đâu.

   ```bash
   sudo -u www wp search-replace 'https://main-site.com' 'https://new-main-site.com' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=/www/wwwroot/main-site.com
   ```
4. Diễn tập toàn bộ việc chuyển đổi trên WP Staging (`--path=/www/wwwroot/main-site.com/staging`) và ghi lại thời gian.

### Ứng phó

1. Xác nhận bị chặn từ một mạng ở Việt Nam.
2. aaPanel: Website > site WordPress > Domain Manager > thêm domain mới (không bao giờ clone site). Sau đó làm DNS, Origin certificate MỚI, SSL và Full (strict) như Chuẩn bị bước 1 và 2 của site embed.
3. Trước khi thay đổi database, kiểm tra trong aaPanel rằng bản backup tự động mới nhất của database WordPress đã tồn tại.
4. Chạy thật. Nếu còn link cũ `http://main-site.com` hoặc dạng `www.`, chạy cùng lệnh với `http://main-site.com` sang `http://new-main-site.com` (và host `www.`). Search-replace đã ghi đè `home` và `siteurl`; kiểm tra Settings > General hiển thị địa chỉ mới.

   ```bash
   sudo -u www wp search-replace 'https://main-site.com' 'https://new-main-site.com' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=/www/wwwroot/main-site.com
   ```
5. Dashboard: thêm `new-main-site.com` và `www.new-main-site.com` vào Embed allowlist (Dashboard Settings > Embed protection > Embed allowlist). Danh sách nằm trong database và cũng quy định CORS và host của báo cáo: không cần sửa `.env`, `config:clear` hay restart.
6. Purge TẤT CẢ page cache. Trang embed có thể mất tới 5 phút mới hiển thị thay đổi allowlist.
7. Cloudflare, zone cũ > Redirect Rules: 301 tới `https://new-main-site.com`, giữ path và query. Search Console: Change of Address. Giữ redirect ít nhất 1 năm (Google yêu cầu tối thiểu 180 ngày).
8. Kiểm tra trên domain mới: video phát được, thumbnail load được.

## Runbook (theo thứ tự này)

Nếu chỉ một số host bị chặn, chỉ chạy các dòng tương ứng.

| # | Làm gì | Vì sao |
|---|---|---|
| 1 | Site embed | Người dùng xem video; không đổi database WordPress |
| 2 | Custom domain (R2) | Nó bị chặn cùng domain embed; việc phát video cần nó (cùng lần sửa `.env` với dòng 1) |
| 3 | FIFU | Thumbnail phụ thuộc host cdn, nên làm sau khi cdn đã chạy |
| 4 | Site chính | Thay đổi nặng nhất, chỉ cần khi `main-site.com` bị chặn; làm sau cùng và riêng |
| 5 | Purge cache | Sau mỗi lần đổi host; trang cũ vẫn giữ host cũ |
| 6 | Thông báo | Chỉ khi mọi thứ đã được kiểm tra xong |

## Xử lý sự cố

Thêm: [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md#các-lỗi-thường-gặp-khi-deploy) và [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md#lỗi-thường-gặp-cách-xử-lý-và-qa).

| Triệu chứng | Cần kiểm tra |
|---|---|
| Bài viết hiển thị văn bản thô `[hls_embed_vl ...]` | WPCode snippet không active hoặc bị mất (khôi phục từ bản sao bên ngoài) |
| Page source có `<!-- hls-embed: invalid configuration -->` | `HLS_EMBED_HOST` bị thiếu, không phải `https`, hoặc `id` của shortcode không hợp lệ |
| Iframe bị từ chối hoặc trống | Embed allowlist thiếu domain WordPress (tới 5 phút mới cập nhật) |
| Player load được nhưng video không phát | Origin trong R2 CORS, `R2_URL`, `cdn.new-embed-site.com` chưa gắn, hoặc Referer của hotlink rule |
| Thumbnail bị lỗi | FIFU vẫn dùng host cdn cũ: chạy mục FIFU |
| Vẫn hiển thị host cũ | Page cache chưa được purge |
| Live progress của dashboard dừng | `REVERB_*` sai, chưa chạy `npm run build`, hoặc chưa restart Reverb |
| Cloudflare 521 / 526 | Chưa cài Origin certificate, hoặc đặt Full (strict) trước khi cài |

## Cũng nên làm

- Thông báo domain mới trên các kênh bạn sở hữu (fan page, Telegram hoặc Zalo, danh sách email) và giữ nguyên tên thương hiệu để mọi người tìm được trên Google.
- Redirect 301 (Cloudflare Redirect Rule trên zone cũ, giữ path và query) chỉ giúp Googlebot, người dùng VPN và các mạng khác. Nó KHÔNG giúp người dùng ở Việt Nam khi nhà mạng cắt kết nối trước.
- Giữ một bản sao của WPCode snippet "HLS Embed shortcode" bên ngoài WordPress; nếu mất snippet, mọi shortcode sẽ hiển thị dưới dạng văn bản thô.
- Nhờ người ở Việt Nam test ba host định kỳ, và diễn tập toàn bộ việc chuyển đổi một lần trên WP Staging.
