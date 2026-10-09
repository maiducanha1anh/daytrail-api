# DayTrail API

Backend Express + TypeScript của DayTrail. Phần tài khoản, công việc, chuỗi lặp, nhật ký và ảnh riêng tư qua Cloudflare R2 đã hoạt động. Chặng 4C.2 đã được người dùng duyệt trên máy tính; kiểm thử điện thoại thật và chất lượng ảnh chụp điện thoại vẫn là checklist bắt buộc trước phát hành. Album ký ức của Hành trình đã được kiểm chứng và người dùng duyệt trên máy tính.

## Chuẩn bị trên Windows

Mở PowerShell và kiểm tra Node.js:

```powershell
node --version
node -p "process.versions.ares"
node -e "const dns=require('node:dns'); console.log(dns.getServers())"
```

Môi trường đã kiểm chứng dùng Node.js 22.23.3 và c-ares 1.34.8. Kết quả DNS phải là máy chủ DNS thật của máy hoặc mạng, không phải `127.0.0.1` nếu máy không chạy DNS proxy cục bộ.

Sau đó mở PowerShell tại repo backend:

```powershell
cd C:\daytrail-api
npm ci
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Kết quả mong đợi: dependency được cài theo `package-lock.json` và có file `.env` cục bộ để cấu hình. Không commit `.env`.

## Cấu hình môi trường

Mở `C:\daytrail-api\.env` và điền các giá trị thật. `MONGODB_URI` phải trỏ đến `/daytrail`; `MONGODB_TEST_URI` phải trỏ đến `/daytrail_test`.

```dotenv
PORT=4000
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/daytrail?retryWrites=true&w=majority
MONGODB_TEST_URI=mongodb+srv://<test-username>:<test-password>@<cluster-host>/daytrail_test?retryWrites=true&w=majority
MONGODB_CONNECT_TIMEOUT_MS=10000
MONGODB_PING_TIMEOUT_MS=3000
SESSION_TTL_DAYS=7
AUTH_RATE_LIMIT_WINDOW_MS=900000
AUTH_RATE_LIMIT_MAX=10
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

Database user dùng cho test chỉ cần quyền `readWrite` trên `daytrail_test`. Test ảnh chỉ chấp nhận bucket `daytrail-media-test` và không fallback sang khóa/bucket development. Không dùng database `daytrail` hoặc bucket `daytrail-media-dev` để chạy integration test.

## Kiểm tra và chạy

Trong PowerShell tại `C:\daytrail-api`, chạy:

```powershell
npm run typecheck
npm run lint
npm run build
npm run db:verify
npm test
npm run dev
```

Kết quả mong đợi:

- Ba lệnh đầu kết thúc với exit code 0.
- `db:verify` xác nhận ping và ghi/đọc/xóa một document tạm trong `daytrail`.
- `npm test` gồm 54 test: 46 test auth/task/recurrence/journal/database/media và 8 test Album ký ức. Codex đã chạy đủ **54/54 PASS** trên source cuối. Suite xác nhận đúng `daytrail_test` cùng `daytrail-media-test` trước khi ghi và chỉ dọn marker/prefix của lần chạy.
- `npm run dev` chỉ mở cổng sau khi MongoDB kết nối và ping thành công; log báo database `daytrail` và địa chỉ `http://localhost:4000`.

Kiểm tra API từ một PowerShell khác:

```powershell
Invoke-RestMethod http://localhost:4000/api/health
Invoke-RestMethod http://localhost:4000/api/ready
```

`/api/health` phải trả `status=ok` và chỉ xác nhận tiến trình API còn sống; `/api/ready` phải trả `status=ready` mới xác nhận MongoDB hoạt động. Nếu lỗi, xem [hướng dẫn vận hành](docs/OPERATIONS.md) và không đưa URI hoặc mật khẩu vào log chia sẻ.

## Thử API xác thực

PowerShell không tự gửi header `Origin`. Backend cho phép client dòng lệnh không có `Origin` nếu body là JSON. Để mô phỏng trình duyệt, thêm `-Headers @{ Origin = 'http://localhost:5173' }`.

```powershell
$body = @{ displayName = 'Người dùng thử'; email = 'user@example.com'; password = '<mat-khau-hop-le>' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/auth/register -ContentType 'application/json' -Body $body

$login = @{ email = 'user@example.com'; password = '<mat-khau-hop-le>' } | ConvertTo-Json
Invoke-WebRequest -Method Post -Uri http://localhost:4000/api/auth/login -ContentType 'application/json' -Body $login -SessionVariable DayTrailSession
Invoke-RestMethod -Uri http://localhost:4000/api/auth/me -WebSession $DayTrailSession
Invoke-WebRequest -Method Post -Uri http://localhost:4000/api/auth/logout -ContentType 'application/json' -Body '{}' -WebSession $DayTrailSession
```

Kết quả mong đợi: đăng ký trả HTTP 201, đăng nhập và `/me` trả HTTP 200, đăng xuất trả HTTP 204. Chi tiết request, response và mã lỗi nằm trong [hợp đồng API](C:\daytrail-web\docs\API_CONTRACT.md).

## Thử API công việc

Đăng nhập trước để có `$DayTrailSession` như ví dụ trên. Sau đó chạy trong cùng cửa sổ PowerShell:

```powershell
$taskBody = @{
  date = '2026-10-04'
  name = 'Lập kế hoạch ngày'
  startTime = '09:00'
  endTime = '10:00'
  priority = 'normal'
  repeat = 'none'
} | ConvertTo-Json

$created = Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/tasks -ContentType 'application/json' -Body $taskBody -WebSession $DayTrailSession
Invoke-RestMethod -Uri 'http://localhost:4000/api/tasks?date=2026-10-04' -WebSession $DayTrailSession
Invoke-RestMethod -Uri 'http://localhost:4000/api/tasks/summaries?from=2026-01-01&to=2026-12-31' -WebSession $DayTrailSession

$completion = @{ completed = $true } | ConvertTo-Json
Invoke-RestMethod -Method Patch -Uri "http://localhost:4000/api/tasks/$($created.task.id)/completion" -ContentType 'application/json' -Body $completion -WebSession $DayTrailSession
```

Kết quả mong đợi: tạo trả HTTP 201; danh sách, tổng quan khoảng và cập nhật hoàn thành trả HTTP 200. Tổng quan khoảng chỉ trả số liệu theo ngày, không trả note. Nếu nhận 401, đăng nhập lại; nếu nhận 400, đối chiếu ngày `YYYY-MM-DD`, giờ `HH:mm` và [hợp đồng API](C:\daytrail-web\docs\API_CONTRACT.md).

## Thử API công việc lặp

Đăng nhập trước để có `$DayTrailSession`, sau đó tạo chuỗi hằng tuần hữu hạn:

```powershell
$seriesBody = @{
  date = '2026-10-05'
  name = 'Tập thể dục'
  startTime = '06:30'
  endTime = '07:00'
  repeat = @{
    frequency = 'weekly'
    weekdays = @(1, 3, 5)
    endDate = '2026-12-31'
  }
} | ConvertTo-Json -Depth 3

$series = Invoke-RestMethod -Method Post -Uri http://localhost:4000/api/tasks/series -ContentType 'application/json' -Body $seriesBody -WebSession $DayTrailSession
Invoke-RestMethod -Uri "http://localhost:4000/api/tasks/series/$($series.series.id)" -WebSession $DayTrailSession
$stopBody = @{ fromDate = '2026-12-01' } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/tasks/series/$($series.series.id)/stop" -ContentType 'application/json' -Body $stopBody -WebSession $DayTrailSession
```

Kết quả mong đợi: tạo trả HTTP 201 cùng `createdCount`; dừng trả số lần đã xóa và giữ lại. Ngày kết thúc được tính trong khoảng. Dừng chuỗi chỉ xóa lần chưa hoàn thành và chưa có note từ `fromDate` theo ngày dự kiến ban đầu.

## Chạy cùng frontend

Giữ backend chạy và mở terminal PowerShell thứ hai:

```powershell
cd C:\daytrail-web
npm run dev
```

Mở `http://localhost:5173`. Giao diện tài khoản, Hôm nay, bốn chế độ Lịch, công việc lặp hữu hạn, nhật ký, ảnh private và Album ký ức đã có. Người dùng đã thử và duyệt Chặng 5 trên máy tính; điện thoại thật vẫn thuộc checklist trước phát hành.

## API Hành trình

- `GET /api/journey/year/:year` và `GET /api/journey/month/:year/:month` trả tổng quan album gọn, chỉ từ journal và ảnh journal.
- `GET /api/journey/days` trả ngày theo trang; `GET /api/journey/days/:date` trả nhật ký/ảnh đầy đủ của một ngày; khoảng danh sách tối đa 366 ngày.
- `PUT /api/journey/albums/:year/:month` lưu tiêu đề/bìa tháng; `GET /api/journey/covers` trả bộ chọn bìa journal phân trang.
- `POST/DELETE /api/journey/highlights` chỉ đánh dấu hoặc bỏ đánh dấu journal thuộc tài khoản hiện tại.
- `GET/POST/PATCH/DELETE /api/journey/phases` quản lý giai đoạn cá nhân; `GET /api/journey/phases/:phaseId/days` phân trang nội dung, kể cả giai đoạn dài hơn 366 ngày. Bìa chỉ tham chiếu ảnh journal trong khoảng; xóa giai đoạn không xóa dữ liệu gốc.

Mọi endpoint yêu cầu phiên đăng nhập. Thao tác ghi yêu cầu JSON và Origin hợp lệ. Contract đầy đủ và mã lỗi nằm tại `C:\daytrail-web\docs\API_CONTRACT.md`.

## Backend ảnh riêng tư

- Mỗi task hoặc journal có tối đa 12 ảnh; input tối đa 8 MiB; chỉ nhận JPEG, PNG và WebP tĩnh.
- Backend kiểm tra bytes/giải mã, xoay orientation, bỏ metadata, tạo WebP full tối đa 2.560 px và thumbnail tối đa 480 px. Bucket R2 luôn private; client chỉ đọc qua endpoint có session.
- Thiếu cấu hình R2 không làm hỏng auth/task/journal. Chỉ endpoint ảnh trả HTTP 503 với mã `MEDIA_STORAGE_UNAVAILABLE`.
- Biến `R2_*` chỉ đặt trong backend. Không đưa access key/secret vào frontend, tài liệu, log hay Git.
- Contract upload/list/read/caption/delete nằm tại `C:\daytrail-web\docs\API_CONTRACT.md`; cách kiểm tra và cleanup nằm trong [OPERATIONS](docs/OPERATIONS.md).
- Trên hotspot đã kiểm tra, DNS mặc định của Node còn trả `EBADRESP`; `npm run dev` bình thường chưa được xác nhận. DNS công cộng chỉ được nạp tạm trong tiến trình test, không nằm trong source.
- Chất lượng cảm quan với ảnh chụp điện thoại thật và thao tác trên điện thoại thật chưa được kiểm chứng; đây là checklist bắt buộc trước phát hành.

## Thử API nhật ký

Đăng nhập trước để có `$DayTrailSession`. Tạo mới phải gửi `version = $null`; cập nhật và xóa phải gửi version mới nhất đã đọc:

```powershell
$date = '2026-10-04'
$createBody = @{ content = "Một ngày đáng nhớ.`nGiữ nguyên dòng mới."; version = $null } | ConvertTo-Json
$created = Invoke-RestMethod -Method Put -Uri "http://localhost:4000/api/journals/$date" -ContentType 'application/json' -Body $createBody -WebSession $DayTrailSession

Invoke-RestMethod -Uri "http://localhost:4000/api/journals/$date" -WebSession $DayTrailSession
Invoke-RestMethod -Uri 'http://localhost:4000/api/journals?from=2026-10-01&to=2026-10-31&page=1&limit=20' -WebSession $DayTrailSession

$updateBody = @{ content = 'Nội dung đã sửa'; version = $created.journal.version } | ConvertTo-Json
$updated = Invoke-RestMethod -Method Put -Uri "http://localhost:4000/api/journals/$date" -ContentType 'application/json' -Body $updateBody -WebSession $DayTrailSession

$deleteBody = @{ version = $updated.journal.version } | ConvertTo-Json
Invoke-WebRequest -Method Delete -Uri "http://localhost:4000/api/journals/$date" -ContentType 'application/json' -Body $deleteBody -WebSession $DayTrailSession
```

Kết quả mong đợi: tạo trả HTTP 201, đọc/cập nhật trả HTTP 200 và xóa trả HTTP 204. HTTP 409 nghĩa dữ liệu đã thay đổi ở tab khác; đọc lại nhật ký trước khi quyết định lưu lại. Contract đầy đủ nằm tại `C:\daytrail-web\docs\API_CONTRACT.md`.
