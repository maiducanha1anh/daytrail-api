# Vận hành DayTrail API trên máy local

Tài liệu này tập trung vào khởi động, kiểm tra database và xử lý lỗi. Request/response chi tiết xem tại `C:\daytrail-web\docs\API_CONTRACT.md`.

## Khởi động

Mở PowerShell tại backend:

```powershell
cd C:\daytrail-api
npm run db:verify
npm run dev
```

Trước khi chạy, cần bảo đảm:

1. Node.js là 22.23.3, c-ares là 1.34.8 hoặc phiên bản tương thích mới hơn.
2. Atlas IP Access List có IP hiện tại.
3. Database user có đúng quyền trên `daytrail`.
4. `.env` có `MONGODB_URI` trỏ đến `/daytrail`; không ghi URI thật vào tài liệu hoặc log chia sẻ.

Kết quả mong đợi: `db:verify` ghi/đọc/xóa đúng một document tạm, sau đó `npm run dev` báo MongoDB sẵn sàng và API lắng nghe tại cổng đã cấu hình. API chỉ mở cổng sau khi connect và ping thành công.

Khi khởi động, backend tạo hoặc kiểm tra:

- Unique index: chỉ mục bảo đảm email và hash token không bị trùng.
- Task index: chỉ mục ghép `userId`, `date`, `startTime`, `_id` phục vụ truy vấn theo chủ sở hữu/ngày và sắp xếp ổn định.
- Recurrence indexes: chỉ mục chuỗi theo chủ sở hữu/ngày kết thúc và unique index `(userId, seriesId, originalDate)` chống tạo trùng lần thực hiện.
- Journal index: unique index `(userId, date)` bảo đảm mỗi tài khoản chỉ có một nhật ký mỗi ngày và hỗ trợ truy vấn khoảng ngày.
- TTL index: chỉ mục giúp MongoDB dọn session hết hạn; API vẫn tự kiểm tra `expiresAt` ở mỗi request.
- Graceful shutdown: quy trình đóng HTTP server rồi đóng Mongoose khi nhận `SIGINT` hoặc `SIGTERM`, với timeout 10 giây.

## Endpoint vận hành

- `GET /api/health`: HTTP 200 khi tiến trình API đang chạy.
- `GET /api/ready`: HTTP 200 khi MongoDB ping thành công; HTTP 503 khi database chưa sẵn sàng.
- `POST /api/auth/register`: tạo user, không tự đăng nhập.
- `POST /api/auth/login`: tạo session và cookie `HttpOnly`.
- `GET /api/auth/me`: đọc user của session hiện tại.
- `POST /api/auth/logout`: thu hồi session và xóa cookie; gọi lặp lại vẫn an toàn.
- `POST /api/auth/password-reset/request`: gửi hướng dẫn đặt lại với response trung lập và cooldown theo IP + email.
- `POST /api/auth/password-reset/confirm`: dùng token một lần, đổi mật khẩu và thu hồi mọi session.
- `POST /api/auth/password/change`: kiểm tra mật khẩu hiện tại, đổi mật khẩu và yêu cầu đăng nhập lại.
- `POST /api/auth/email-verification/resend`: gửi lại link xác minh cho session hiện tại.
- `POST /api/auth/email-verification/confirm`: xác minh bằng token một lần; chỉ POST mới tiêu thụ token.
- `POST /api/tasks`: tạo công việc một lần.
- `GET /api/tasks`: danh sách theo một ngày hoặc khoảng ngày có phân trang.
- `GET /api/tasks/summary`: tổng quan một ngày.
- `GET /api/tasks/summaries`: tổng quan theo từng ngày trong khoảng tối đa 366 ngày; không trả nội dung/note.
- `POST /api/tasks/series`: tạo cấu hình chuỗi và các lần thực hiện hữu hạn trong một transaction.
- `GET /api/tasks/series/:seriesId`: đọc metadata chuỗi thuộc user hiện tại cho màn hình chi tiết.
- `POST /api/tasks/series/:seriesId/stop`: dừng chuỗi từ ngày dự kiến, giữ lịch sử có note/đã hoàn thành.
- `GET/PATCH/DELETE /api/tasks/:id`: đọc, sửa và xóa công việc thuộc user hiện tại.
- `PATCH /api/tasks/:id/date`: chuyển ngày mà không reset nội dung/trạng thái.
- `PATCH /api/tasks/:id/completion`: đặt rõ `completed=true/false`.
- `GET /api/journals/:date`: đọc đầy đủ nhật ký một ngày; ngày trống trả `journal: null`.
- `PUT /api/journals/:date`: tạo hoặc cập nhật nhật ký bằng version đã đọc.
- `DELETE /api/journals/:date`: xóa nhật ký bằng version đã đọc.
- `GET /api/journals`: danh sách đoạn trích theo khoảng tối đa 366 ngày, có phân trang.

Mọi endpoint công việc và nhật ký yêu cầu session. Các thao tác ghi hiện có yêu cầu JSON và Origin hợp lệ; mọi truy vấn/sửa/xóa đều kèm `userId` lấy từ session.

Nếu MongoDB mất kết nối sau khi API đã mở cổng, endpoint cần database trả HTTP 503 với `code="DATABASE_UNAVAILABLE"` và `Retry-After: 5`. Đây là lỗi dịch vụ, không phải phiên hết hạn: backend không trả 401 và không xóa cookie. `/api/health` chỉ xác nhận tiến trình Express còn sống; luôn dùng `/api/ready` để kết luận database có sẵn sàng hay không.

## Database kiểm thử

Integration test là kiểm thử nhiều thành phần cùng lúc: route, middleware, MongoDB và cookie.

- Test chỉ chấp nhận `MONGODB_TEST_URI` có pathname `/daytrail_test`; không fallback sang `MONGODB_URI`.
- Database user test chỉ cần `readWrite` trên `daytrail_test`.
- Test không drop database hoặc collection. Mỗi lần chạy dùng domain email ngẫu nhiên rồi chỉ xóa journal, task, chuỗi lặp, session và user của lần đó theo đúng `userId`.

Mở PowerShell tại backend và chạy:

```powershell
cd C:\daytrail-api
npm test
```

Bộ test hiện có 69 test: 59 test auth/task/recurrence/journal/database/media/Album/hồ sơ và 10 test vòng đời tài khoản. Kết quả mong đợi là 69 PASS khi Atlas và R2 test đều sẵn sàng. Nếu thiếu/sai `MONGODB_TEST_URI` hoặc bộ biến `R2_TEST_*`, test phải dừng trước khi ghi dữ liệu. Khi lỗi, chỉ gửi phần stack trace đã che thông tin nhạy cảm.

Kết quả nghiệm thu:

- Người dùng chạy `npm test` trên database thực tế `daytrail_test`: 8 PASS, 0 fail/cancelled/skipped/todo.
- Codex kiểm tra session qua hai tiến trình backend riêng: cookie tạo ở tiến trình đầu vẫn dùng được sau khi khởi động tiến trình thứ hai.
- Codex kiểm tra cleanup: không còn user mang marker của bộ test; phép kiểm chứng restart còn 0 user và 0 session tạm.
- Chặng 2A: Codex chạy toàn bộ 17 test trên `daytrail_test`; cleanup của test công việc xác nhận còn 0 task, 0 session và 0 user thuộc run.
- Nghiệm thu chặng 2B: sau khi người dùng thêm IP công cộng hiện tại vào Atlas IP Access List với trạng thái Active, Codex chạy lại 18/18 test PASS. Kiểm tra sau cleanup xác nhận còn 0 user, session và task mang marker test.
- Kiểm chứng chặng 3A: Codex chạy 19/19 test PASS trên `daytrail_test`. Test tổng quan khoảng xác nhận cách ly tài khoản, ngày trống, giới hạn 366 ngày và tổng số đúng với 105 công việc — nhiều hơn một trang API.
- Kiểm chứng chặng 3B.1: Codex chạy 29/29 test PASS trên `daytrail_test`. Suite recurrence kiểm tra ngày/tuần/tháng, 29/30/31, năm nhuận, giao năm, giới hạn 366 ngày, độc lập từng lần, dừng chuỗi, cách ly tài khoản, không đếm đôi và rollback transaction.
- Kiểm chứng chặng 3B.2: Codex chạy lại 29/29 test PASS; test đọc metadata chuỗi xác nhận đúng chủ sở hữu. Browser test riêng dùng 4015/5176 và `daytrail_test`; dữ liệu test được xóa theo đúng user marker.
- Kiểm chứng chặng 4A: Codex chạy 38/38 test PASS trên `daytrail_test`. Suite nhật ký 9/9 PASS, gồm tạo/đọc/sửa/xóa, xung đột version, hai request tạo đồng thời, phân trang, đoạn trích, cách ly tài khoản và cleanup theo user marker.
- Kiểm chứng kỹ thuật chặng 5 Album ký ức: Codex chạy toàn bộ **54/54 test PASS** bằng DNS mặc định trên `daytrail_test` và `daytrail-media-test`; riêng suite Album 8/8 PASS. Test bao phủ loại trừ task/ảnh task, chọn 6 ngày ổn định, bìa thủ công/tự động và fallback, phân trang, cách ly tài khoản, giai đoạn dài hơn 366 ngày và dọn tham chiếu khi nguồn bị xóa.
- Lượt đồng bộ giao diện tham chiếu và **Góc của mình**: Codex chạy toàn bộ **59/59 test PASS**; riêng suite hồ sơ 5/5 PASS trên `daytrail_test` và `daytrail-media-test`. Suite kiểm tra quyền riêng tư, idempotency upload, xử lý orientation/EXIF, cách ly hai tài khoản, xung đột version, giới hạn bốn ảnh trang trí và cleanup ảnh tạm/thay thế.
- Lượt tích hợp trước deploy ngày 11/10/2026: Codex chạy lại frontend/backend `typecheck`, `lint`, `build` và toàn bộ backend **59/59 test PASS**. Browser thật dùng backend/frontend riêng `4101`/`5183`, MongoDB `daytrail_test`, R2 `daytrail-media-test` và hai context tách cookie; cleanup xác nhận còn 0 bản ghi/object của marker. Kiểm thử điện thoại thật, backup/restore và production smoke test vẫn chưa thực hiện.
- Chặng 6C ngày 12/10/2026: Codex chạy toàn bộ **69/69 test PASS**; riêng suite vòng đời tài khoản 10/10 PASS trên `daytrail_test`. Browser test dùng email capture nội bộ, không phải SMTP ngoài. Cleanup domain marker xác nhận còn 0 user/session/token/profile.
- Nghiệm thu người dùng ngày 12/10/2026: ba luồng đăng ký/xác minh email, quên/đặt lại mật khẩu và đổi mật khẩu/đăng nhập lại đều đạt với backend thật, `daytrail_test` và Mailpit chỉ lắng nghe localhost. Cleanup marker `dtacct-20261012-a7f3c2-*` xóa đúng 3 user và 3 bản ghi liên quan; không có object R2 thuộc marker và kiểm tra sau dọn còn 0 user/bản ghi/object. Các cổng SMTP/UI/backend/frontend nghiệm thu đã đóng; script và Mailpit tái sử dụng được giữ ngoài repo. SMTP Internet và production vẫn chưa kiểm chứng.
- Chuẩn bị Gmail API ngày 12–13/10/2026: backend `typecheck`, `lint`, `build` PASS; unit test provider email **8/8 PASS** và toàn bộ backend **77/77 test PASS** trên `daytrail_test`/`daytrail-media-test`. Test mới giải mã MIME và so sánh nguyên văn tiếng Việt của subject, text và HTML cho cả thư xác minh lẫn đặt lại mật khẩu.
- Email Internet đầu tiên đến được hộp thư nhưng tiếng Việt thành dấu `?`. Bằng chứng xác nhận nguyên nhân nằm ở lệnh thử dùng Windows PowerShell 5.1: `$OutputEncoding` là `us-ascii`, nên source JavaScript chứa tiếng Việt bị đổi trước khi Node/provider nhận dữ liệu. MIME do provider tạo trực tiếp vẫn có `charset=utf-8`, quoted-printable và subject RFC 2047 đúng. Lượt thử sau dùng dữ liệu Unicode không đi qua pipeline ASCII; Gmail API chấp nhận đúng một request, không retry. Người dùng xác nhận thư mới vào Inbox và hiển thị đúng dấu.

## Email tài khoản

- Link đặt lại mật khẩu có hiệu lực 30 phút; link xác minh có hiệu lực 24 giờ. MongoDB chỉ giữ hash token và TTL index hỗ trợ dọn token hết hạn.
- `EMAIL_PROVIDER` chọn rõ `disabled`, `smtp` hoặc `gmail_api`; không có fallback tự động. `EMAIL_COOLDOWN_SECONDS` mặc định 60.
- SMTP/Mailpit vẫn dùng cho local với timeout hữu hạn và TLS đúng môi trường. Gmail API dùng OAuth2 để refresh access token rồi gọi `users.messages.send` qua HTTPS; MIME có text/HTML, UTF-8 và From cố định.
- Gmail API không retry tự động. Timeout/lỗi mạng sau khi request bắt đầu có thể có kết quả chưa rõ, vì vậy không tự gửi lại để tránh thư trùng. Google trả thành công chỉ nghĩa là API chấp nhận request, không chứng minh email đã vào inbox.
- Log chỉ ghi mã an toàn: `GMAIL_INVALID_GRANT`, `GMAIL_AUTH`, `GMAIL_PERMISSION_DENIED`, `GMAIL_QUOTA`, `GMAIL_NETWORK`, `GMAIL_SERVER`, `GMAIL_TIMEOUT` hoặc `GMAIL_UNKNOWN`; không ghi response OAuth thô hay token.

### Gmail API và OAuth Desktop

- Công cụ `npm run gmail:authorize` dùng callback loopback `127.0.0.1`, state, PKCE S256, `access_type=offline` và chỉ scope `https://www.googleapis.com/auth/gmail.send`.
- File OAuth client đầu vào và authorized-user đầu ra phải ở ngoài repo. Công cụ không ghi đè output có sẵn; nếu không có refresh token thì không lưu file mới.
- External app ở trạng thái Testing có refresh token giới hạn khoảng 7 ngày với scope Gmail. Khi token hết hạn hoặc bị thu hồi, cấp quyền lại; không thay đổi Branding/publishing status bằng source code.
- Render dùng `GMAIL_AUTHORIZED_USER_FILE` qua Secret File hoặc ba environment secret trực tiếp. `GMAIL_SENDER_EMAIL`, `FRONTEND_BASE_URL` và `FRONTEND_ORIGIN` phải khớp môi trường; production phải dùng HTTPS.
- Tài liệu chính thức: [OAuth Desktop/loopback và PKCE](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail API gửi MIME](https://developers.google.com/workspace/gmail/api/guides/sending), [thời hạn refresh token ở Testing](https://developers.google.com/identity/protocols/oauth2) và [mã lỗi Gmail API](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

Nghiệm thu Gmail thật ngày 13/10/2026 dùng backend `127.0.0.1:4016`, frontend `127.0.0.1:5186`, `daytrail_test`, `daytrail-media-test` và chỉ provider `gmail_api`. Người dùng xác nhận đăng ký/xác minh email, quên/đặt lại mật khẩu, đổi mật khẩu, đăng nhập lại và liên kết dùng một lần đều hoạt động. Cleanup đối chiếu đúng user ID đã ghi nhận: xóa 1 user, 1 bản ghi liên quan, 0 object; kiểm tra sau dọn còn 0 user, 0 bản ghi và 0 object. Hai tiến trình nghiệm thu, state, record và log đã được dọn; script tái sử dụng cùng file OAuth ngoài repo được giữ nguyên. Không có thư Gmail nào bị truy cập hoặc xóa bởi cleanup.

## Giới hạn công việc hiện tại

- API một lần `POST /api/tasks` vẫn chỉ nhận `repeat="none"`; chuỗi lặp dùng endpoint `/api/tasks/series` riêng.
- Chuỗi chỉ hỗ trợ `daily`, `weekly`, `monthly`, bắt buộc ngày kết thúc và tối đa 366 ngày. Tháng thiếu ngày tương ứng sẽ được bỏ qua.
- Frontend đã có giao diện tạo/dừng chuỗi và thao tác từng lần. Chưa có sửa hàng loạt quy tắc chuỗi.
- Ảnh private cho task/journal và giao diện 4C.2 đã nghiệm thu trên máy tính; điện thoại thật và chất lượng ảnh điện thoại vẫn phải kiểm tra trước phát hành.
- Hành trình đã được thiết kế lại thành Album ký ức Năm/Tháng/Tuần/Ngày chỉ dùng journal/ảnh journal, có highlight, tiêu đề/bìa tháng và giai đoạn. Hồ sơ riêng tư **Góc của mình** đã được bổ sung; video, chia sẻ và AI chưa triển khai.
- Ngày được lưu dưới dạng lịch địa phương `YYYY-MM-DD`, không đổi sang UTC. Giờ bắt đầu/kết thúc phải cùng ngày và `endTime` phải sau `startTime`.

## Chuẩn bị phát hành V1

Checklist trung tâm nằm tại `C:\daytrail-web\docs\RELEASE_CHECKLIST.md`. Trước production phải chạy `typecheck`, `lint`, `build`, toàn bộ `npm test`, kiểm tra `/api/health` và `/api/ready`, rồi diễn tập backup/restore trong môi trường tách biệt.

Chưa có quyết định về phạm vi thùng rác, thời gian giữ, RPO/RTO, hạ tầng/domain hoặc proxy production. Không tự deploy hoặc đặt `NODE_ENV=production` khi chưa có HTTPS, `FRONTEND_ORIGIN` chính xác và cơ chế quản lý secret. Không dùng database/bucket development để diễn tập restore.

## Lưu trữ ảnh riêng tư 4C.1

Backend dùng Cloudflare R2 bucket riêng tư: MongoDB chỉ giữ metadata và hàng đợi cleanup; backend xác thực session/chủ sở hữu rồi stream ảnh. Không dùng object public, base64 trong MongoDB, local disk khi deploy hoặc biến `VITE_*`.

Cấu hình thật nằm trong `C:\daytrail-api\.env`; không in hoặc commit file này. Development và test dùng bộ khóa/bucket riêng:

```dotenv
R2_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<development-access-key-id>
R2_SECRET_ACCESS_KEY=<development-secret-access-key>
R2_BUCKET=daytrail-media-dev
R2_TEST_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
R2_TEST_ACCESS_KEY_ID=<test-access-key-id>
R2_TEST_SECRET_ACCESS_KEY=<test-secret-access-key>
R2_TEST_BUCKET=daytrail-media-test
R2_TIMEOUT_MS=20000
MEDIA_UPLOAD_CONCURRENCY=2
```

`R2_TEST_BUCKET` bắt buộc đúng `daytrail-media-test`; thiếu một biến test phải dừng, không fallback sang development. Mỗi run dùng prefix `daytrail/test/<run-id>` và chỉ xóa object dưới prefix đó.

Worker cleanup chạy một lượt lúc backend khởi động rồi mỗi 30 giây. Mỗi lượt xử lý tối đa 20 asset đến hạn; lỗi R2 được lưu bằng mã đã che thông tin và retry với backoff. Xóa ảnh/task/journal có thể trả HTTP 202 cùng `cleanupStatus=pending`: dữ liệu đã bị ẩn khỏi API nhưng object đang chờ dọn. Không chạy lệnh xóa toàn bucket.

Ảnh hồ sơ dùng cùng R2 private bucket nhưng có model/prefix riêng, không xuất hiện trong task, journal hoặc Album ký ức. Ảnh vừa upload là ảnh tạm trong tối đa một giờ; lưu hồ sơ sẽ gắn ảnh, còn hủy chỉnh sửa gọi endpoint discard. Worker profile chạy lúc khởi động và theo chu kỳ để retry ảnh tạm/quá hạn hoặc object chưa dọn được. Không xóa object thủ công theo prefix chung.

Nếu thiếu cấu hình R2 development, auth/task/journal vẫn hoạt động; endpoint ảnh trả HTTP 503. Nếu R2 gián đoạn, không tăng timeout hoặc tắt TLS để che lỗi. Kiểm tra biến có tồn tại mà không in giá trị, quyền token trên đúng bucket, rồi thử lại.

### Kiểm thử ảnh

Mở PowerShell tại `C:\daytrail-api` và chạy `npm test`. Trước khi ghi, suite media xác nhận database `daytrail_test`, bucket `daytrail-media-test` và prefix ngẫu nhiên. Suite có test R2 thật cho upload/read/delete và test mô phỏng riêng cho partial upload, delete retry và xóa task trong lúc upload.

Lần kiểm tra 4C.1 hiện tại:

- `typecheck`, `lint` và `build`: PASS.
- Probe R2 thật upload → read → delete: PASS; prefix probe còn 0 object.
- Suite media trên `daytrail_test` + `daytrail-media-test`: 8/8 PASS.
- Toàn bộ backend: 46/46 PASS; con số đúng là 46 tổng và 8 media.
- Cleanup: 0 user/media marker 4C.1 và 0 object dưới `daytrail/test/`.
- Các lệnh test trên dùng `NODE_OPTIONS` để nạp `dns.setServers` với resolver công cộng chỉ trong tiến trình. Không đổi DNS Windows, source, URI hoặc TLS. `npm run dev` bình thường trên hotspot chưa được xác nhận hoạt động.
- Người dùng đã duyệt 4C.1 về backend dựa trên kết quả trên. Chất lượng cảm quan với ảnh chụp điện thoại thật chưa được kiểm chứng và sẽ được thử ở 4C.2; toàn bộ chặng 4C chưa hoàn tất.

Nếu DNS mặc định hotspot vẫn trả `EBADRESP`, chuyển sang mạng có resolver hoạt động hoặc sửa DNS ở cấp mạng theo quyết định của người dùng trước khi chạy development bình thường. Không hardcode resolver vào source.

## Transaction của chuỗi lặp

Tạo chuỗi ghi `TaskSeries` và toàn bộ `Task` trong cùng MongoDB transaction: nếu một lần chèn thất bại, cả chuỗi và các lần đã chèn đều rollback. Unique partial index theo chuỗi/ngày dự kiến là lớp bảo vệ thứ hai chống trùng. Đọc lịch hoặc khởi động lại backend không sinh thêm dữ liệu.

Dừng chuỗi cũng dùng transaction. Backend cập nhật `stoppedFromDate` và xóa các lần đủ điều kiện trong cùng một lần ghi nhất quán. Việc lọc dùng `originalDate`, nên công việc đã chuyển ngày vẫn thuộc đúng vị trí lịch gốc khi dừng. Lần có asset ảnh đang hoạt động được giữ lại giống lần có note hoặc đã hoàn thành.

## Bảo mật phiên đăng nhập

- Mật khẩu dùng bcrypt với salt và 12 rounds; response và log không chứa mật khẩu hoặc `passwordHash`.
- Session token ngẫu nhiên 256-bit; MongoDB chỉ lưu SHA-256 của token.
- Cookie dùng `HttpOnly`, `SameSite=Lax`; có `Secure` trong production HTTPS và không có `Secure` khi chạy development qua localhost HTTP.
- Các request `POST /api/auth/*` phải là JSON và phải qua kiểm tra `Origin`. Client CLI không có `Origin` được phép; browser cross-site không có `Origin` bị chặn qua `Sec-Fetch-Site`.
- Register và login có rate limit (giới hạn số request) theo `AUTH_RATE_LIMIT_WINDOW_MS` và `AUTH_RATE_LIMIT_MAX`.

## Xử lý lỗi

| Dấu hiệu | Kiểm tra và cách xử lý |
|---|---|
| `ConfigurationError: MONGODB_URI is required` | Mở `C:\daytrail-api\.env`, bổ sung biến còn thiếu rồi khởi động lại backend. |
| `ENOTFOUND` hoặc `ECONNREFUSED` | Kiểm tra DNS, firewall/VPN và mạng. Chạy lại ba lệnh kiểm tra Node/DNS trong README. |
| Node 22.23.2/c-ares 1.34.6 trả DNS `127.0.0.1` | Nâng lên Node 22.23.3 hoặc bản tương thích mới hơn, mở terminal mới rồi kiểm tra lại `node --version` và `dns.getServers()`. |
| Server selection timeout | Kiểm tra Atlas IP Access List, trạng thái cluster và hostname. |
| Authentication failed | Kiểm tra database user, quyền, mật khẩu và URL-encode ký tự đặc biệt; không gửi URI thật khi nhờ hỗ trợ. |
| `/api/ready` trả 503 | Xem log backend đã che bí mật và kiểm tra kết nối Atlas; `/api/health` vẫn có thể trả 200. |
| `ERR_SSL_TLSV1_ALERT_INTERNAL_ERROR` trên mọi node Atlas | Kiểm tra IP công cộng hiện tại có đúng một entry `/32` trạng thái Active trong Atlas **Security → Network Access**. Không dùng `0.0.0.0/0`. Nếu IP đã đúng, kiểm tra VPN/proxy/antivirus có can thiệp TLS và thử lại từ mạng tin cậy. |
| `/api/auth/me` trả 500 rồi mọi request bị `ERR_CONNECTION_REFUSED` | Lỗi 500 xảy ra khi server cũ còn chạy nhưng truy vấn MongoDB thất bại. Sau một lần reload/restart, backend không mở cổng nếu connect/ping startup thất bại, nên trình duyệt nhận connection refused. Khôi phục Atlas trước rồi khởi động lại backend. |

Không cần preload `dns.setServers`, hardcode DNS, tắt TLS hoặc tắt kiểm tra chứng chỉ trong source.
