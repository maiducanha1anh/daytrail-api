# DayTrail API

Backend Express + TypeScript của DayTrail. Phần tài khoản, phiên và API công việc một lần theo ngày đã hoàn thành. Chặng 3A bổ sung tổng quan công việc theo khoảng ngày cho bốn chế độ Lịch; công việc lặp, ảnh và nhật ký ngày chưa được triển khai.

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
```

Database user dùng cho test chỉ cần quyền `readWrite` trên `daytrail_test`. Không dùng database `daytrail` để chạy integration test (kiểm thử tích hợp qua API và database thật).

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
- `npm test` chạy trên `daytrail_test`. Bộ test hiện có 19 test: 8 auth, 10 công việc và 1 test xác nhận lỗi database trả 503 thay vì 401. Codex chạy trong chặng 3A: 19 PASS, 0 fail/cancelled/skipped/todo.
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

## Chạy cùng frontend

Giữ backend chạy và mở terminal PowerShell thứ hai:

```powershell
cd C:\daytrail-web
npm run dev
```

Mở `http://localhost:5173`. Giao diện tài khoản, danh sách Hôm nay và bốn chế độ Lịch Năm/Tháng/Tuần/Ngày đã có; nhật ký, ảnh và lịch lặp vẫn chưa triển khai.
