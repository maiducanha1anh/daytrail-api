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

Mọi endpoint công việc và nhật ký yêu cầu session. Các thao tác ghi yêu cầu JSON và Origin hợp lệ; mọi truy vấn/sửa/xóa đều kèm `userId` lấy từ session.

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

Bộ test hiện có 38 test (8 auth, 10 công việc, 10 công việc lặp, 9 nhật ký, 1 lỗi database). Kết quả mong đợi là 38 PASS. Nếu thiếu hoặc sai `MONGODB_TEST_URI`, test phải dừng trước khi ghi dữ liệu. Khi lỗi, chỉ gửi phần stack trace đã che thông tin nhạy cảm.

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

## Giới hạn công việc hiện tại

- API một lần `POST /api/tasks` vẫn chỉ nhận `repeat="none"`; chuỗi lặp dùng endpoint `/api/tasks/series` riêng.
- Chuỗi chỉ hỗ trợ `daily`, `weekly`, `monthly`, bắt buộc ngày kết thúc và tối đa 366 ngày. Tháng thiếu ngày tương ứng sẽ được bỏ qua.
- Frontend đã có giao diện tạo/dừng chuỗi và thao tác từng lần. Chưa có sửa hàng loạt quy tắc, ảnh hoặc nhật ký ngày.
- Backend đã có nhật ký văn bản tối đa 20.000 ký tự. Frontend nhật ký thuộc 4B; ảnh nhật ký thuộc 4C và chưa được triển khai.
- Ngày được lưu dưới dạng lịch địa phương `YYYY-MM-DD`, không đổi sang UTC. Giờ bắt đầu/kết thúc phải cùng ngày và `endTime` phải sau `startTime`.

## Transaction của chuỗi lặp

Tạo chuỗi ghi `TaskSeries` và toàn bộ `Task` trong cùng MongoDB transaction: nếu một lần chèn thất bại, cả chuỗi và các lần đã chèn đều rollback. Unique partial index theo chuỗi/ngày dự kiến là lớp bảo vệ thứ hai chống trùng. Đọc lịch hoặc khởi động lại backend không sinh thêm dữ liệu.

Dừng chuỗi cũng dùng transaction. Backend cập nhật `stoppedFromDate` và xóa các lần đủ điều kiện trong cùng một lần ghi nhất quán. Việc lọc dùng `originalDate`, nên công việc đã chuyển ngày vẫn thuộc đúng vị trí lịch gốc khi dừng.

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
