# DayTrail API

Backend Express + TypeScript của DayTrail. Chặng 1B.1 đã hoàn thành phần đăng ký, đăng nhập và phiên đăng nhập lưu trong MongoDB. Giao diện xác thực và các tính năng nghiệp vụ chưa được triển khai.

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
- `npm test` chạy trên `daytrail_test`. Theo kết quả người dùng cung cấp khi nghiệm thu chặng 1B.1: 8 test PASS, 0 test lỗi hoặc bị bỏ qua.
- `npm run dev` chỉ mở cổng sau khi MongoDB kết nối và ping thành công; log báo database `daytrail` và địa chỉ `http://localhost:4000`.

Kiểm tra API từ một PowerShell khác:

```powershell
Invoke-RestMethod http://localhost:4000/api/health
Invoke-RestMethod http://localhost:4000/api/ready
```

`/api/health` phải trả `status=ok`; `/api/ready` phải trả `status=ready`. Nếu lỗi, xem [hướng dẫn vận hành](docs/OPERATIONS.md) và không đưa URI hoặc mật khẩu vào log chia sẻ.

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

## Chạy cùng frontend

Giữ backend chạy và mở terminal PowerShell thứ hai:

```powershell
cd C:\daytrail-web
npm run dev
```

Mở `http://localhost:5173`. Frontend hiện chỉ kiểm tra kết nối backend; giao diện đăng ký/đăng nhập chưa được làm.
