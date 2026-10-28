> [English](DOMAIN-BLOCK-PLAYBOOK.md) | Tiếng Việt

# Playbook xử lý khi domain bị chặn

> Liên quan: [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md) (cài đặt server và Cloudflare), [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md) (lỗi, Q&A). Quay lại [README](../README.vi.md).

## Tóm tắt

**Chuẩn bị (làm trước khi bị chặn)**

Site embed, B sang C (mục 2.1):

1. Mua domain `C` (không dùng `.vn`) và thêm vào Cloudflare trên cùng tài khoản với R2.
2. Cloudflare: DNS record loại A cho `C` trỏ tới cùng IP VPS (Proxied), Origin CA certificate, SSL Full (strict), Cache Rule `/embed/*`, WAF Skip rule cho `/embed/`, `/apps/` và `/app/`.
3. aaPanel: thêm `C` vào site HIỆN CÓ (Domain Manager); không clone site.
4. R2 (Cloudflare): gắn `cdn.C` vào cùng bucket và thêm `https://C` vào CORS `AllowedOrigins`.
5. Ghi lại (chưa áp dụng) các giá trị `.env` dự phòng: `APP_URL`, `REVERB_*`, `REVERB_ALLOWED_ORIGINS`, `R2_URL`.
6. Test trên WP Staging: đặt `HLS_EMBED_HOST` thành `https://C` và mở `https://C/embed/ID`.

FIFU và site chính (mục 2.3 và 2.4):

1. Cài hoặc kiểm tra WP-CLI (`wp --info`) và chạy bằng user của site, không chạy bằng root.
2. Dry-run `wp search-replace` để biết host cdn và domain WordPress được lưu ở đâu.
3. Mua domain `D`, thêm vào Cloudflare, và xác minh cả hai property trong Search Console.
4. Diễn tập toàn bộ việc chuyển đổi trên WP Staging và ghi lại thời gian.

Chung (mục 4): giữ một bản sao của WPCode snippet "HLS Embed shortcode" bên ngoài WordPress; nhờ người ở Việt Nam test `A`, `B` và `cdn.B` định kỳ.

**Ứng phó (khi bị chặn)**

Nếu domain embed `B` bị chặn (`cdn.B` bị chặn theo) (mục 2.1, 2.2 và 2.3):

1. Xác nhận bị chặn từ một mạng ở Việt Nam.
2. `.env` trên VPS: áp dụng các giá trị dự phòng (`APP_URL`, `REVERB_*`, `REVERB_ALLOWED_ORIGINS`, `R2_URL` sang `https://cdn.C`).
3. Chạy `config:clear` và `npm run build` (vì `REVERB_*`), rồi restart queue worker, Reverb và scheduler.
4. Kiểm tra `https://C/up`, một playlist và một segment trên `cdn.C`, và không có lỗi CORS.
5. WPCode snippet "HLS Embed shortcode": đổi `HLS_EMBED_HOST` thành `https://C`.
6. Purge cache (plugin cache và Cloudflare).
7. FIFU: backup bằng `wp db export`, dry-run, rồi chạy thật `wp search-replace 'https://cdn.B' 'https://cdn.C' --skip-columns=guid`, purge cache, kiểm tra thumbnail.

Nếu domain WordPress `A` bị chặn (mục 2.4):

1. Thêm `D` vào site WordPress hiện có và cấu hình Cloudflare cho `D`.
2. `wp db export`, rồi dry-run và chạy thật `wp search-replace` cho `https://A` và `http://A` sang `D`, và kiểm tra Site Address.
3. Dashboard: thêm `D` vào Embed allowlist (trang Settings của Dashboard), thêm `D` vào `CORS_ALLOWED_ORIGINS` và `REPORT_ALLOWED_HOSTS` trong `.env`, rồi `config:clear` và restart các dịch vụ.
4. Purge cache, redirect 301 từ `A` sang `D`, Change of Address trong Search Console.

Cuối cùng (mục 3): thông báo domain mới trên các kênh bạn sở hữu, chỉ sau khi mọi thứ đã được kiểm tra xong. Redirect 301 chỉ giúp Googlebot và người dùng VPN, không giúp người dùng ở Việt Nam.

Chi tiết nằm ở các mục 1 đến 6 bên dưới.

Playbook này dành cho admin vận hành website WordPress và dashboard này. Nội dung hướng dẫn từng bước cách chuẩn bị các domain dự phòng trước khi bị chặn và cách chuyển sang chúng sau khi bị chặn.

Giả định: "bị chặn" nghĩa là người dùng ở Việt Nam không truy cập được một domain. Domain WordPress chính và domain embed có thể bị chặn cùng lúc, nên mỗi domain có thể được chuyển riêng.

Mọi nội dung chưa được kiểm chứng với repo này đều được đánh dấu `Verify:`. Nhãn giao diện của Cloudflare, aaPanel, WPCode, WordPress và plugin thay đổi theo phiên bản, nên hãy đối chiếu trên màn hình thật. Không bao giờ dán nội dung `.env`, mật khẩu hay key vào ticket hoặc chat.

## 1. Các host và nơi thay đổi

**Placeholder** (dùng xuyên suốt bên dưới):

| Placeholder | Ý nghĩa |
|---|---|
| `A` | Domain website WordPress chính, ví dụ `wp-site.com` |
| `B` | Domain embed = dashboard Laravel này, ví dụ `mediadomain.com` (route embed `/embed/{id}`) |
| `cdn.B` | Custom domain Cloudflare R2 phục vụ các file HLS (`.m3u8`, `.ts`); là subdomain của `B`, bằng `R2_URL`. Khi `B` bị chặn thì `cdn.B` cũng bị chặn |
| `C` | Domain embed dự phòng (mua sẵn, không dùng `.vn`); `cdn.C` là custom domain R2 của nó |
| `D` | Domain WordPress dự phòng (mua sẵn, không dùng `.vn`) |
| `<project path>` | Thư mục project trên VPS (`<APP_DIR>` trong [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md)) |
| `<PHP>`, `<USER>` | PHP CLI và user chạy dịch vụ, như định nghĩa trong [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md) |
| `<wp path>` | Thư mục WordPress trên server đang chạy website WordPress |
| `<WP_USER>` | User hệ thống sở hữu các file WordPress (user mà WP-CLI phải chạy bằng) |
| `<wp staging path>` | Thư mục WordPress của bản WP Staging |

Hãy thay mọi placeholder (`A`, `B`, `C`, `D`, `cdn.B`, `cdn.C`, `<project path>`, `<wp path>`, `<wp staging path>`, `<WP_USER>`, ...) bằng giá trị thật trước khi chạy bất kỳ lệnh hay truy vấn nào; copy nguyên văn là sai (ví dụ `LIKE '%A%'` sẽ khớp các dòng không liên quan và `https://A` không phải một host thật).

**Thay đổi cái gì ở đâu** (mọi bước bên dưới đều nêu rõ nơi sửa và tuân theo bảng này):

| Cái gì | Nằm ở đâu | Sau khi đổi |
|---|---|---|
| `HLS_EMBED_HOST` (host embed, chỉ `https`, không có path) | WPCode snippet "HLS Embed shortcode" trên website WordPress | Purge TẤT CẢ page cache (plugin cache và Cloudflare) |
| `APP_URL` | `.env` trên VPS của dashboard | `config:clear`, restart các dịch vụ |
| `REVERB_HOST`, `REVERB_PORT`, `REVERB_SCHEME` | `.env` trên VPS của dashboard | `config:clear`, `npm run build` (giá trị được nhúng vào JS lúc build), restart Reverb |
| `REVERB_ALLOWED_ORIGINS` (chỉ hostname, không có scheme) | `.env` trên VPS của dashboard | `config:clear`, restart các dịch vụ |
| `R2_URL` | `.env` trên VPS của dashboard | `config:clear`, restart các dịch vụ |
| `CORS_ALLOWED_ORIGINS` (origin CÓ scheme; mặc định trong code là `https://toicovl.com` nếu không đặt) | `.env` trên VPS của dashboard | `config:clear`, restart các dịch vụ |
| `REPORT_ALLOWED_HOSTS` (host KHÔNG có scheme) | `.env` trên VPS của dashboard | `config:clear`, restart các dịch vụ |
| Embed allowlist (các domain WordPress được phép đặt player trong iframe; gửi đi dưới dạng CSP `frame-ancestors`) | Setting trong database `embed_allowed_domains`, sửa ở trang Settings của Dashboard: Settings > Embed protection > Allowed domains. KHÔNG nằm trong `.env` | Lưu form; trang embed đang được cache có thể mất tới 5 phút mới cập nhật |
| R2 CORS policy, R2 custom domain | Cloudflare dashboard > R2 > bucket > Settings (không nằm trong repo, không nằm trong `.env`) | Test phát video |
| Cache Rule cho `/embed/*`, Redirect Rule, DNS, chế độ SSL, Origin CA certificate | Cloudflare dashboard, trong zone của domain tương ứng | Làm theo [DEPLOYMENT.vi.md mục 9](DEPLOYMENT.vi.md#9-web-server-và-ssl) và [mục 11](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare) |
| Thêm domain vào site hiện có (không bao giờ clone site) | aaPanel > Website > Domain Manager (Hướng A), hoặc `server_name` của Nginx (Hướng B), như trong [DEPLOYMENT.vi.md](DEPLOYMENT.vi.md) | Origin CA certificate phải phủ domain mới; chế độ SSL Full (strict) |
| URL của site WordPress | WordPress Settings > General (WordPress Address và Site Address), hoặc `WP_HOME` / `WP_SITEURL` trong `wp-config.php` | Purge cache |
| URL tuyệt đối lưu trong database WordPress | Database, thông qua WP-CLI search-replace (mục 2.3 và 2.4) | Purge cache |

"Restart các dịch vụ" nghĩa là theo quy tắc chung trong [DEPLOYMENT.vi.md, phần "Cập nhật"](DEPLOYMENT.vi.md#cập-nhật--deploy-lại-khi-có-code-mới): sau mọi thay đổi `.env` phải chạy `config:clear`, rồi restart queue worker, Reverb và scheduler, vì các tiến trình này giữ config trong bộ nhớ. Các lệnh restart chỉ liệt kê một lần, ở mục 2.1 (response, bước 5).

**Vì sao shortcode biến host embed thành thay đổi ở một chỗ duy nhất.** Bài viết chỉ lưu `[hls_embed_vl id="N" ratio="W / H" autoplay="1" muted="1"]`; không bao giờ lưu host embed. PHP snippet WPCode "HLS Embed shortcode" dựng iframe và đọc host từ hằng số duy nhất `HLS_EMBED_HOST`. Đổi một dòng đó, purge cache, mọi bài viết sẽ dùng host mới. Admin lấy shortcode từ nút "Copy shortcode" trong hộp thoại embed ở trang videos của dashboard.

**Giới hạn của redirect (chỉ nêu một lần).** Redirect 301 (Cloudflare Redirect Rule trên zone CŨ, giữ nguyên path và query) KHÔNG giúp được người dùng ở Việt Nam khi nhà mạng cắt kết nối hoặc DNS trước khi tới được HTTP. Nó chỉ giúp Googlebot, người dùng VPN và các mạng khác.

## 2. Playbook theo từng site

### 2.1 Site embed (domain B sang domain dự phòng C)

Vai trò: đây là host của dashboard Laravel và là host của iframe. WordPress hiển thị player trong iframe trỏ tới `https://B/embed/{id}`. Nếu `B` bị chặn, iframe sẽ trống, nên host của iframe phải chuyển sang `C`.

#### Trước khi bị chặn (chuẩn bị)

Làm các bước này khi chưa có gì bị chặn. Không bước nào ở đây làm thay đổi site đang chạy cho tới khi tới các bước response.

1. Nhà đăng ký domain: mua domain dự phòng `C`. Không dùng `.vn`.
2. Cloudflare dashboard: thêm `C` thành một zone mới trên cùng tài khoản Cloudflare với R2 bucket.
3. Cloudflare dashboard, zone `C` > DNS: thêm DNS record loại A cho `C` trỏ tới cùng IP VPS với `B`, **Proxied** (đám mây màu cam). Cùng origin với `B` (xem [DEPLOYMENT.vi.md mục 0](DEPLOYMENT.vi.md#0-chuẩn-bị-và-tài-khoản)).
4. Thêm `C` vào site HIỆN CÓ; không bao giờ clone site hay tạo site thứ hai.
   - aaPanel (Hướng A): Website > site hiện có > Domain Manager > thêm `C`.
   - VPS thuần (Hướng B): thêm `C` vào `server_name` ở cả hai khối `server` trong file Nginx, rồi test và reload.

   Lý do: sửa file site của Nginx (chỉ Hướng B).

   ```bash
   sudo nano /etc/nginx/sites-available/hls-r2-studio
   ```

   Lý do: kiểm tra cú pháp trước khi reload.

   ```bash
   sudo nginx -t
   ```

   Lý do: áp dụng thay đổi.

   ```bash
   sudo systemctl reload nginx
   ```
5. Cloudflare dashboard, zone `C` > SSL/TLS > Origin Server: tạo Origin CA certificate phủ `C` (chỉ thêm `*.C` nếu cần), cài lên origin (aaPanel site > SSL, hoặc các file certificate của Nginx), rồi đặt chế độ SSL **Full (strict)** và **Always Use HTTPS**. Làm theo [DEPLOYMENT.vi.md mục 9](DEPLOYMENT.vi.md#9-web-server-và-ssl) và [mục 11, bước 2](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare). Cài certificate trước khi chuyển sang Full (strict), nếu không sẽ bị lỗi 521/526.
   - Verify: một Origin CA certificate có thể liệt kê hostname thuộc hai zone khác nhau (`B` và `C`) hay không, và aaPanel hoặc Nginx giữ hai certificate cho một site như thế nào. Nếu một certificate không phủ được cả hai, hãy cài certificate riêng cho `C`.
6. Cloudflare dashboard, zone `C`: lặp lại phần còn lại của [DEPLOYMENT.vi.md mục 11](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare) cho zone mới:
   - Bật WebSockets (bước 1).
   - Cache Rule cho trang embed: hostname bằng `C` và URI path bắt đầu bằng `/embed/` (bước 3).
   - WAF Skip rule cho `/embed/`, `/apps/` và `/app/` (bước 5). `/apps/` quan trọng vì sau khi chuyển, VPS publish event của Reverb qua `https://C/apps/...`.
7. Cloudflare dashboard > R2 > bucket > Settings > Custom Domains: thêm `cdn.C` vào CÙNG bucket, bên cạnh `cdn.B`. Sau đó, trong zone `C`, thêm Cache Rule cho `cdn.C` ([mục 11, bước 4](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare)) và hotlink rule ([mục 11, bước 6](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare)). Hotlink rule phải cho phép Referer của host embed thực sự phát video, nên ở zone `C` hãy dùng `C` ở chỗ DEPLOYMENT.vi.md dùng domain embed, và vẫn cho phép Referer rỗng.
   - Verify một lần trên Cloudflare dashboard: một bucket có thể có nhiều custom domain, nên `cdn.C` gắn được bên cạnh `cdn.B`; và zone của `C` phải cùng tài khoản Cloudflare với bucket.
8. Cloudflare dashboard > R2 > bucket > Settings > CORS policy: THÊM `https://C` vào `AllowedOrigins` và giữ `https://B`. Định dạng policy nằm ở [DEPLOYMENT.vi.md mục 11, bước 7](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare); kết quả trông như sau:

   ```json
   [{"AllowedOrigins":["https://B","https://C"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["*"],"MaxAgeSeconds":86400}]
   ```
9. Ghi lại danh sách giá trị dự phòng cho dashboard. Chỉ ghi lại; CHƯA áp dụng. Chúng sẽ được điền vào `.env` trên VPS của dashboard ở response bước 2:

   | Biến | Hiện tại | Giá trị dự phòng |
   |---|---|---|
   | `APP_URL` | `https://B` | `https://C` |
   | `REVERB_HOST` | `B` | `C` |
   | `REVERB_PORT`, `REVERB_SCHEME` | `443`, `https` | giữ nguyên |
   | `REVERB_ALLOWED_ORIGINS` | `B` | `C` (chỉ hostname; phân tách bằng dấu phẩy nếu cần cả hai) |
   | `R2_URL` | `https://cdn.B` | `https://cdn.C` (xem mục 2.2) |

   `CORS_ALLOWED_ORIGINS` và `REPORT_ALLOWED_HOSTS` chứa các domain WordPress, nên không đổi ở mục này (chúng đổi ở mục 2.4).
   - Verify: nơi gọi `POST /api/reports` (báo lỗi phát video) nằm ở đâu. Bên gọi không có trong repo này; nếu có script trên website WordPress gọi `https://B/api/reports` thì phải cập nhật sang `C`.
10. Embed allowlist: giữ nguyên. Nó liệt kê các domain WordPress (Dashboard Settings > Embed protection > Allowed domains), không phải domain embed. Không làm gì ở đây trừ khi domain WordPress đổi (mục 2.4).
11. Test trên WP Staging (không test trên site thật):
    - Trong bản staging của WPCode snippet "HLS Embed shortcode", đặt `HLS_EMBED_HOST` thành `https://C`, purge cache của staging, rồi mở các bài viết có `[hls_embed_vl id="N"]`. Iframe phải load từ `C`.
    - Đồng thời test trực tiếp trang embed khi `APP_URL` vẫn là `B`. Lý do: xác nhận các response header (`content-security-policy: frame-ancestors ...`, `cache-control`):

      ```bash
      curl -sI https://C/embed/ID
      ```

    - Verify: asset của trang embed có phụ thuộc vào `APP_URL` hay không. Trong repo này `resources/views/embed/show.blade.php` load thư viện từ cdnjs và dựng URL playlist từ `R2_URL`, không có lời gọi `asset()`, `route()` hay `@vite`, nhưng chưa test trên trình duyệt. Mở `https://C/embed/ID` với DevTools > Network và tìm request nào đi tới `B` thay vì `C` (hoặc bị lỗi).
    - Việc phát video có thể bị từ chối trong lúc test này: trang load playlist từ `cdn.B` trong khi Referer là `C`, và hotlink rule ở zone `B` chặn việc đó. Nếu thấy 403 trên `cdn.B`, đó là nguyên nhân. Iframe, allowlist và player vẫn được kiểm chứng; phát video đầy đủ được kiểm chứng ở giai đoạn response khi `R2_URL` đã trỏ tới `cdn.C`.

#### Sau khi bị chặn (response)

1. Xác nhận bị chặn: từ một mạng ở Việt Nam (hoặc dịch vụ kiểm tra), `B` và `cdn.B` không load được. Không bắt đầu các bước dưới đây cho domain vẫn còn load được.
2. `.env` trên VPS của dashboard: áp dụng các giá trị dự phòng ở chuẩn bị bước 9. Sửa file (không in ra hay dán nội dung):

   ```bash
   cd <project path>
   ```

   ```bash
   nano .env
   ```

   Vì `B` bị chặn nghĩa là `cdn.B` bị chặn, hãy đặt luôn `R2_URL` trong cùng lần sửa này, rồi làm theo mục 2.2 để kiểm tra. Nếu đặt `R2_URL` ngay bây giờ mà host iframe vẫn là `B`, việc phát video sẽ lỗi cho tới khi xong bước 8, nên hãy làm các bước 2 đến 8 trong cùng một phiên.
3. VPS: nạp lại config.

   ```bash
   <PHP> artisan config:clear
   ```
4. VPS: build lại frontend, vì `REVERB_HOST` đã đổi và giá trị phía trình duyệt được nhúng vào JS (chỉ bỏ qua nếu bạn không đổi bất kỳ giá trị `REVERB_*` nào).

   ```bash
   npm run build
   ```
5. VPS: restart các dịch vụ chạy nền (chúng giữ config cũ trong bộ nhớ). Restart queue sẽ làm gián đoạn video đang transcode, nên hãy restart worker khi không có video nào đang xử lý, hoặc dùng `queue:restart` (graceful) thay thế.

   ```bash
   sudo systemctl restart hls-r2-studio-queue@1 hls-r2-studio-queue@2
   ```

   ```bash
   sudo systemctl restart hls-r2-studio-reverb
   ```

   ```bash
   sudo systemctl restart hls-r2-studio-scheduler
   ```

   Lý do: sửa quyền sở hữu file sau các lệnh artisan chạy bằng root ([DEPLOYMENT.vi.md mục 8](DEPLOYMENT.vi.md#8-quyền-thư-mục)).

   ```bash
   sudo chown -R <USER>:<USER> storage bootstrap/cache
   ```

   ```bash
   sudo chmod -R 775 storage bootstrap/cache
   ```
6. Kiểm tra dashboard trên `C`. Lý do: xác nhận host mới đang phục vụ (mong đợi 200):

   ```bash
   curl -s -o /dev/null -w "%{http_code}\n" https://C/up
   ```

   Sau đó đăng nhập tại `https://C/login` và mở một trang có live progress; trong DevTools của trình duyệt, kết nối `wss://C/app/...` phải có status 101.
7. Embed allowlist: không đổi (nó liệt kê các domain WordPress).
8. WPCode snippet "HLS Embed shortcode" trên website WordPress: đổi đúng một dòng `HLS_EMBED_HOST` thành `https://C` (chỉ https, không có path). Lưu và giữ snippet ở trạng thái Active.
9. Purge TẤT CẢ page cache: plugin cache trên website WordPress, và cache Cloudflare của zone WordPress. Đồng thời purge cache Cloudflare của zone `C` cho `/embed/*` nếu bạn đã mở trang embed ở đó trước khi đổi `R2_URL`, vì các trang đó được cache tới 5 phút và chứa host playlist cũ.
10. Kiểm tra từ một mạng ở Việt Nam: mở các bài viết có video và phát thử. Page source của bài viết phải hiển thị iframe bắt đầu bằng `https://C/embed/`.

    ```bash
    curl -sI https://C/embed/ID
    ```

    Mong đợi `cache-control: public, max-age=60, s-maxage=300` và, ở request thứ hai, `cf-cache-status: HIT`.
11. Cloudflare dashboard, zone `B` > Rules > Redirect Rules: thêm redirect 301 từ `B` sang `https://C`, giữ nguyên path và query. Không áp dụng cho `cdn.B`. Nó không giúp người dùng ở Việt Nam (xem giới hạn ở mục 1). Verify: nhãn dashboard Cloudflare và cú pháp expression chính xác.

### 2.2 Custom domain (R2, `cdn.B` sang `cdn.C`)

Vai trò: `cdn.B` là custom domain Cloudflare R2 phục vụ các file HLS (playlist `.m3u8` và segment `.ts`). Player trên trang embed tải chúng từ đây. Nó là subdomain của `B`, nên `B` bị chặn thì nó cũng bị chặn.

Vì sao chỉ `R2_URL` thay đổi: database chỉ lưu `playlist_path` dạng TƯƠNG ĐỐI. URL đầy đủ được dựng lúc runtime từ `R2_URL` (`config/filesystems.php`, disk `r2`), và playlist ffmpeg dùng tên segment tương đối (`segment_%03d.ts`). Vì vậy đổi host CDN chỉ cần `R2_URL`, R2 custom domain và R2 CORS policy. Không cần upload lại và không cần đổi database.

#### Trước khi bị chặn (chuẩn bị)

1. Cloudflare dashboard > R2 > bucket > Settings > Custom Domains: `cdn.C` phải được gắn vào cùng bucket (mục 2.1, chuẩn bị bước 7).
2. Cloudflare dashboard > R2 > bucket > Settings > CORS policy: `https://C` phải có trong `AllowedOrigins` bên cạnh `https://B` (mục 2.1, chuẩn bị bước 8).
3. Cloudflare dashboard, zone `C`: cache rule cho `cdn.C` và hotlink rule trong [DEPLOYMENT.vi.md mục 11](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare) (bước 4 và 6) đã được tạo. Các lưu ý về TTL ở đó áp dụng nguyên vẹn: Edge TTL 1 ngày, Browser TTL 2 giờ; video đã xóa vẫn có thể được phục vụ từ edge tới hết TTL, và trên gói free thì purge chỉ theo từng URL.
4. Test host dự phòng bằng một file thật. Lấy một đường dẫn playlist thật của một video đã ready: mở trang embed của nó, DevTools > Network, ghi lại path của request `.m3u8` (không gồm host). Lý do: cùng đường dẫn tương đối đó cũng phải chạy được trên `cdn.C`:

   ```bash
   curl -I https://cdn.C/<relative-path-to-playlist>.m3u8
   ```

   Mong đợi `HTTP/2 200`. Verify: cấu trúc thư mục thật của một video trên R2 (từ tab Network) thay vì tự giả định.

#### Sau khi bị chặn (response)

1. `.env` trên VPS của dashboard: đặt `R2_URL=https://cdn.C` (làm trong cùng lần sửa với mục 2.1, response bước 2, khi `B` cũng bị chặn).
2. VPS: `config:clear` và restart các dịch vụ, như mục 2.1 response bước 3 và 5. Không cần `npm run build` nếu chỉ đổi `R2_URL`.
3. Cloudflare dashboard: purge cache của các trang embed nếu chúng đã bị cache với host cũ (mục 2.1, response bước 9). Chỉ purge `cdn.C` nếu trước đó bạn đã upload hoặc thay đổi file ở đó; trên gói free thì purge theo từng URL.
4. Kiểm tra một playlist. Lý do: xác nhận host mới phục vụ playlist:

   ```bash
   curl -I https://cdn.C/<relative-path-to-playlist>.m3u8
   ```

5. Kiểm tra một segment. Lý do: xác nhận segment cũng được phục vụ (lấy tên segment từ playlist; chúng là đường dẫn tương đối, như `segment_000.ts`):

   ```bash
   curl -I https://cdn.C/<relative-path-to-folder>/segment_000.ts
   ```

6. Mở một video trên trình duyệt (trang embed) với DevTools > Console và Network: không được có lỗi CORS, và các request `.m3u8` và `.ts` phải đi tới `cdn.C`. Lỗi CORS nghĩa là `https://C` còn thiếu trong R2 CORS policy.
7. Video cũ vẫn chạy: đường dẫn lưu trong database là tương đối, nên chúng tự trỏ theo `R2_URL` mới mà không cần upload lại.

### 2.3 FIFU (đi theo domain embed / cdn)

Vai trò: plugin FIFU (Featured Image from URL) trên website WordPress hiển thị các ảnh nằm trên `cdn.B`.

**Search-replace dùng để làm gì ở đây.** FIFU lưu URL TUYỆT ĐỐI của mỗi ảnh, ví dụ `https://cdn.B/...`, trong database WordPress. Shortcode không sửa được việc này, vì các URL đó không nằm trong shortcode. Search-replace ghi đè host cũ thành host mới ngay trong database, và phải hỗ trợ serialized data (để các giá trị PHP-serialized không bị hỏng). WP-CLI `wp search-replace` an toàn với serialized và là công cụ duy nhất được dùng trong playbook này cho các thao tác database.

Verify: cấu trúc nội bộ của FIFU (meta key hoặc bảng nào chứa URL) chưa được kiểm tra trong repo này. Hãy xác nhận bằng các lệnh dry run bên dưới trước khi thay đổi bất cứ thứ gì.

#### Trước khi bị chặn (chuẩn bị)

1. Đọc các quy tắc WP-CLI một lần; mục 2.3 và 2.4 đều tuân theo chúng:
   - (a) Kiểm tra WP-CLI đã được cài. Lý do: xác nhận lệnh `wp` tồn tại:

     ```bash
     wp --info
     ```

   - (b) Chạy WP-CLI bằng `<WP_USER>` (user hệ thống sở hữu các file WordPress), không bao giờ chạy bằng root. Nếu bạn đang đăng nhập bằng root, hãy viết `sudo -u <WP_USER> wp <command> --path=<wp path>`. KHÔNG dùng `--allow-root`. Các lệnh bên dưới được viết dưới dạng `wp <command> --path=<wp path>`; thêm tiền tố `sudo -u <WP_USER>` khi bạn là root.
   - (c) WP-CLI đọc thông tin đăng nhập database và table prefix từ `wp-config.php` của chính site đó, nên không phải gõ mật khẩu ở đâu cả. Để làm việc trên staging, trỏ `--path` tới `<wp staging path>`.
   - (d) `--all-tables-with-prefix` giới hạn lệnh trong các bảng của đúng một site đó.
   - (e) Luôn chạy `--dry-run` trước.
   - Verify: các flag dùng trong playbook này có trong phiên bản WP-CLI của bạn (`wp search-replace --help`: `--report-changed-only`, `--skip-columns`, `--include-columns`, `--all-tables-with-prefix`; `wp db tables --help`; `wp db export --help`).
2. Chẩn đoán 1 (chỉ đọc). Lý do: xem FIFU có bảng riêng không:

   ```bash
   wp db tables --all-tables-with-prefix --path=<wp path> | grep -i fifu
   ```

3. Chẩn đoán 2 (dry run, không ghi gì). Lý do: số lượng theo từng bảng và cột cho biết host cdn được lưu Ở ĐÂU:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

   Ghi lại các bảng và cột có kết quả khớp.
4. Chẩn đoán 3 (dry run, không ghi gì). Lý do: xem cột `guid` có chứa host cdn không (lệnh này chỉ kiểm tra cột đó):

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --include-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

5. Quyết định về GUID: để nguyên GUID (giữ `--skip-columns=guid`) trừ khi chẩn đoán 3 cho thấy GUID của attachment chứa URL cdn. Verify: FIFU có lưu URL cdn trong `guid` hay không.
6. Diễn tập trên WP Staging trước. Staging có thư mục WordPress và database riêng, nên hãy trỏ `--path` tới đó. Lý do: kiểm tra số lượng và thumbnail trên staging trước khi đụng vào site thật:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp staging path>
   ```

#### Sau khi bị chặn (response)

Chạy sau khi mục 2.2 đã xong, để host mới `cdn.C` đã phục vụ được các file. Tuân theo các quy tắc WP-CLI ở chuẩn bị bước 1.

1. Backup database trước. Lý do: có đường quay lại nếu replace gặp sự cố; giữ file này cho tới khi mọi thứ được kiểm tra xong:

   ```bash
   wp db export ~/wp-before-cdn-switch.sql --path=<wp path>
   ```

2. Dry run (không ghi thay đổi nào). Lý do: xem trước số lượng trên site thật:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

3. Xem lại số lượng so với dry run ở bước chuẩn bị: phải khớp nhau. Nếu lệch nhiều, dừng lại và kiểm tra lại.
4. Chạy thật (cùng lệnh nhưng không có `--dry-run`). Lý do: ghi đè host cdn cũ thành host mới trong database:

   ```bash
   wp search-replace 'https://cdn.B' 'https://cdn.C' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=<wp path>
   ```

5. Purge cache: plugin cache, Cloudflare (zone WordPress), và mọi tuỳ chọn cache của FIFU trong plugin.
6. Kiểm tra thumbnail ở trang chủ, một trang archive và một bài viết đơn, và kiểm tra ảnh Open Graph (page source, `og:image`) trỏ tới `cdn.C`.
7. Giữ file backup cho tới khi mọi thứ được kiểm tra xong, rồi mới xóa.

- Phương án dự phòng: nếu không cài được WP-CLI trên server, plugin Better Search Replace (cài ngay trong chính site WordPress đó, nó chỉ thay đổi database của site đó) có thể thực hiện cùng phép replace từ WordPress admin: Tools > Better Search Replace, dry run trước, tắt "Replace GUIDs".

### 2.4 Site chính (WordPress, domain A sang domain dự phòng D)

Vai trò: chính website WordPress. Đây là thay đổi nặng nhất và chỉ cần khi chính `A` bị chặn.

**Search-replace dùng để làm gì ở đây.** WordPress lưu URL tuyệt đối của chính domain của nó trong posts, postmeta, options (thường là serialized: widget, theme settings, dữ liệu page builder) và nhiều nơi khác. Đổi domain WordPress nghĩa là ghi đè `https://A` thành `https://D` trong database một cách an toàn, bằng `wp search-replace` của WP-CLI (hỗ trợ serialized; cùng công cụ và cùng quy tắc WP-CLI như mục 2.3, chuẩn bị bước 1).

#### Trước khi bị chặn (chuẩn bị)

1. Nhà đăng ký domain và Cloudflare dashboard: mua domain dự phòng `D` (không dùng `.vn`) và thêm nó thành một zone trên Cloudflare.
2. Google Search Console: đảm bảo cả hai property (`A` và `D`) đã được xác minh. Verify: yêu cầu của công cụ Change of Address về loại property.
3. Xác nhận WP-CLI chạy được trên server WordPress (quy tắc ở mục 2.3, chuẩn bị bước 1). Lý do: xác nhận lệnh `wp` tồn tại:

   ```bash
   wp --info
   ```

4. Ghi lại các giá trị hiện tại. Lý do: Site Address hiện tại (`siteurl`):

   ```bash
   wp option get siteurl --path=<wp path>
   ```

   Lý do: Home address hiện tại (`home`):

   ```bash
   wp option get home --path=<wp path>
   ```

   Lý do: kiểm tra các URL có bị cố định trong code dưới dạng hằng số (`WP_HOME` / `WP_SITEURL`) không; lệnh này không in ra mật khẩu:

   ```bash
   grep -E "WP_HOME|WP_SITEURL" <wp path>/wp-config.php
   ```

5. Liệt kê các nơi chứa URL tuyệt đối của `A`. Lý do: lệnh dry run này không ghi gì, và số lượng theo bảng và cột cho biết `A` được lưu ở đâu (posts, postmeta, options, v.v.):

   ```bash
   wp search-replace 'https://A' 'https://D' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

6. Ghi chú phía dashboard có tham chiếu tới `A`: embed allowlist (Dashboard Settings > Embed protection > Allowed domains), `CORS_ALLOWED_ORIGINS` và `REPORT_ALLOWED_HOSTS` trong `.env` trên VPS.
7. Diễn tập toàn bộ việc chuyển `A` sang `D` trên WP Staging (dùng `--path=<wp staging path>`) và ghi lại thời gian thực hiện.

#### Sau khi bị chặn (response)

1. Xác nhận bị chặn: từ một mạng ở Việt Nam (hoặc dịch vụ kiểm tra), `A` không load được.
2. Thêm `D` vào site WordPress HIỆN CÓ (không bao giờ clone): aaPanel > Website > site WordPress > Domain Manager > thêm `D` (VPS thuần: thêm `D` vào `server_name` của site đó trong Nginx). Sau đó, trên Cloudflare dashboard, zone `D`: DNS record `D` proxied tới cùng origin, Origin CA certificate phủ `D` (và `*.D` nếu cần), chế độ SSL Full (strict). Xem [DEPLOYMENT.vi.md mục 9](DEPLOYMENT.vi.md#9-web-server-và-ssl) và [mục 11](DEPLOYMENT.vi.md#11-cấu-hình-cloudflare).
   - Verify: cho tới khi Site Address được đổi (bước 6), WordPress có thể redirect các request tới `D` về lại `A`.
3. Backup database. Lý do: có đường quay lại nếu replace gặp sự cố:

   ```bash
   wp db export ~/wp-before-domain-switch.sql --path=<wp path>
   ```

4. Replace dạng `https`. Lý do: dry run trước, không ghi thay đổi nào:

   ```bash
   wp search-replace 'https://A' 'https://D' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

   Xem lại số lượng so với dry run ở bước chuẩn bị, rồi chạy thật. Lý do: ghi đè `https://A` thành `https://D` trong database:

   ```bash
   wp search-replace 'https://A' 'https://D' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=<wp path>
   ```

5. Lặp lại cho dạng `http`. Lý do: dry run trước:

   ```bash
   wp search-replace 'http://A' 'http://D' --all-tables-with-prefix --skip-columns=guid --dry-run --report-changed-only --path=<wp path>
   ```

   Lý do: chạy thật:

   ```bash
   wp search-replace 'http://A' 'http://D' --all-tables-with-prefix --skip-columns=guid --report-changed-only --path=<wp path>
   ```

   Nếu site còn dùng dạng `www.` của `A`, chạy cùng bốn lệnh đó cho host này.
6. Site Address: search-replace đã ghi đè `home` và `siteurl` (chúng được lưu trong bảng options). Kiểm tra WordPress admin trên `D` > Settings > General: WordPress Address và Site Address phải là `https://D`. Nếu chưa đúng, hoặc nếu bạn thích cách dùng WP-CLI, hãy đặt chúng. Lý do: đặt Home address:

   ```bash
   wp option update home 'https://D' --path=<wp path>
   ```

   Lý do: đặt Site Address:

   ```bash
   wp option update siteurl 'https://D' --path=<wp path>
   ```

   Nếu chúng bị cố định trong code, hãy đổi `WP_HOME` và `WP_SITEURL` trong `wp-config.php` thay vào đó.
7. Cập nhật dashboard:
   - Trang Settings của Dashboard > Settings > Embed protection > Allowed domains: thêm `D` (setting trong database, không phải `.env`), rồi Save. Giữ `A` cho tới khi bạn bỏ hẳn nó.
   - `.env` trên VPS: đặt `CORS_ALLOWED_ORIGINS` có thêm `https://D` (có scheme) và `REPORT_ALLOWED_HOSTS` có thêm `D` (không scheme), rồi nạp lại:

     ```bash
     <PHP> artisan config:clear
     ```

     Restart các dịch vụ như mục 2.1 response bước 5. Không cần `npm run build` (không đổi `REVERB_*`).
8. Purge TẤT CẢ page cache (plugin cache và Cloudflare cho zone `D`). Các trang embed đang được cache có thể mất tới 5 phút mới phản ánh thay đổi allowlist.
9. Cloudflare dashboard, zone `A` > Rules > Redirect Rules: 301 từ `A` sang `https://D`, giữ nguyên path và query. Nó không giúp người dùng ở Việt Nam (xem giới hạn ở mục 1). Verify: nhãn Cloudflare và cú pháp expression chính xác.
10. Google Search Console: dùng Change of Address từ `A` sang `D`. Giữ redirect ít nhất 1 năm (Google yêu cầu tối thiểu 180 ngày).
11. Kiểm tra trên `D`: mở vài bài viết có video; player phải load và phát được (iframe bị từ chối nghĩa là `D` còn thiếu trong embed allowlist), và thumbnail phải load.

## 3. Thông báo domain mới cho người dùng

Phần này là tuỳ chọn.

- Google Search Console: Change of Address cho website WordPress (mục 2.4, response bước 10).
- Giữ nguyên tên thương hiệu và tiêu đề site, để mọi người tìm ra domain mới bằng cách tìm tên đó trên Google.
- Dùng các kênh bạn sở hữu: fan page, nhóm Telegram hoặc Zalo, danh sách email. Đăng domain mới ở đó.
- Không trông chờ vào redirect cho người dùng bị chặn; họ không tới được domain cũ (xem giới hạn ở mục 1).
- Chỉ thông báo sau khi mọi thứ đã được kiểm tra xong (mục 5).

## 4. Diễn tập và giám sát

- Diễn tập toàn bộ việc chuyển đổi một lần trên WP Staging và ghi lại thời gian. Cập nhật các danh sách dự phòng sau buổi diễn tập.
- Nhờ một người ở Việt Nam, hoặc dùng dịch vụ kiểm tra, test `A`, `B` và `cdn.B` định kỳ.
- Giữ các domain dự phòng `C`, `cdn.C` và `D` ở trạng thái đã cấu hình nhưng chưa dùng (zone, DNS, certificate, R2 custom domain, CORS), để khi chuyển đổi chỉ còn các bước response.
- Giữ một bản sao của WPCode snippet "HLS Embed shortcode" bên ngoài WordPress (password manager hoặc repository riêng tư). Nếu mất snippet, mọi shortcode sẽ hiển thị dưới dạng văn bản thô.

## 5. Runbook một trang (làm theo thứ tự này)

Trong runbook này `B` là domain EMBED và `A` là domain WordPress. Nếu chỉ một số host bị chặn, chỉ chạy các mục tương ứng.

| # | Làm gì | Vì sao theo thứ tự này |
|---|---|---|
| 1 | `B` (host embed): mục 2.1 response. Chuyển `.env` trên VPS, các dịch vụ và `HLS_EMBED_HOST` sang `C` | Video là thứ người dùng xem, và bước này không cần đổi database WordPress |
| 2 | cdn: mục 2.2 response. `R2_URL` sang `cdn.C`, kiểm tra `.m3u8` và `.ts` | `cdn.B` là subdomain của `B` và việc phát video cần nó; dùng chung lần sửa `.env` với mục 1 |
| 3 | FIFU: mục 2.3 response. Search-replace `https://cdn.B` sang `https://cdn.C` | Thumbnail phụ thuộc vào host cdn, nên chạy sau khi cdn đã hoạt động |
| 4 | Site chính `A`: mục 2.4 response. Chuyển WordPress sang `D` | Thay đổi nặng nhất; chỉ cần khi chính `A` bị chặn, nên làm riêng và làm sau cùng |
| 5 | Cache: purge plugin cache và Cloudflare | Lặp lại sau mỗi lần đổi host; trang cũ vẫn giữ host cũ cho tới khi được purge |
| 6 | Thông báo: mục 3 | Cuối cùng, khi mọi thứ đã được kiểm tra xong |

## 6. Tra cứu nhanh

| Triệu chứng | Cần kiểm tra |
|---|---|
| Bài viết hiển thị văn bản thô `[hls_embed_vl ...]` | WPCode snippet không active hoặc bị mất. Mở WPCode, kiểm tra snippet "HLS Embed shortcode" đang Active với location "Run Everywhere"; khôi phục từ bản sao bên ngoài nếu bị mất |
| Page source có `<!-- hls-embed: invalid configuration -->` | `HLS_EMBED_HOST` trong snippet bị thiếu, không phải `https`, hoặc không hợp lệ; hoặc `id` của shortcode không hợp lệ |
| Iframe bị từ chối hoặc trống | Embed allowlist thiếu domain WordPress (Dashboard Settings > Embed protection > Allowed domains); trang embed đang cache có thể mất tới 5 phút mới cập nhật |
| Player load được nhưng video không phát | R2 CORS policy thiếu origin của embed, `R2_URL` sai, `cdn.C` chưa gắn vào bucket, hoặc hotlink rule chặn Referer. Kiểm tra console và tab Network của trình duyệt; xem mục 2.2 |
| Thumbnail bị lỗi | FIFU vẫn trỏ tới host cdn cũ: mục 2.3 |
| Vẫn phục vụ host cũ | Page cache chưa được purge (plugin cache và Cloudflare) |
| Live progress của dashboard dừng sau khi chuyển | Giá trị `REVERB_*` sai, chưa chạy `npm run build`, hoặc chưa restart Reverb; xem [DEPLOYMENT.vi.md, các lỗi thường gặp khi deploy](DEPLOYMENT.vi.md#các-lỗi-thường-gặp-khi-deploy) |
| Cloudflare 521 / 526 trên domain mới | Thiếu Origin certificate hoặc đặt SSL Full (strict) quá sớm: [DEPLOYMENT.vi.md mục 9](DEPLOYMENT.vi.md#9-web-server-và-ssl) |
| Lệnh gọi Report API lỗi CORS | `CORS_ALLOWED_ORIGINS` thiếu origin của WordPress; xem Q&A trong [TROUBLESHOOTING.vi.md](TROUBLESHOOTING.vi.md#lỗi-thường-gặp-cách-xử-lý-và-qa) |
