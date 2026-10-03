# DayTrail API - Van hanh local

## Khoi dong

1. Dung Node.js 22.23.3 (c-ares 1.34.8) da kiem chung tren Windows.
2. Dam bao Atlas IP Access List co IP hien tai va database user co quyen tren `daytrail`.
3. Dat URI that trong `.env`; khong commit hoac dua URI vao log/tai lieu.
4. Chay `npm run db:verify` de ping va kiem chung ghi/doc/xoa mot document tam.
5. Chay `npm run dev`. API chi mo cong sau khi database san sang.

Khong can preload `dns.setServers` hoac hardcode DNS vao source khi Node nhan dung DNS mac dinh.

## Endpoint

- `GET /api/health`: HTTP 200 khi API process dang chay.
- `GET /api/ready`: HTTP 200 khi MongoDB ping thanh cong; HTTP 503 khi database khong san sang.

## Shutdown

`SIGINT` va `SIGTERM` dong HTTP server, sau do dong ket noi Mongoose. Shutdown co timeout 10 giay.

## Xu ly loi

- `ConfigurationError: MONGODB_URI is required`: them URI vao `.env`.
- `DatabaseConnectionError ... ENOTFOUND/ECONNREFUSED`: kiem tra DNS, firewall/VPN va mang may local.
- Neu Windows DNS hoat dong nhung Node 22.23.2/c-ares 1.34.6 tra `127.0.0.1`, nang Node len 22.23.3 hoac moi hon trong cung dong LTS roi mo terminal moi. Xac nhan bang `node --version`, `node -p "process.versions.ares"` va `dns.getServers()`.
- Server selection timeout: kiem tra Atlas IP Access List, cluster va hostname.
- Authentication failed: kiem tra database user/password va URL-encode ky tu dac biet trong password.

Hop dong API chung: `C:\daytrail-web\docs\API_CONTRACT.md`.
