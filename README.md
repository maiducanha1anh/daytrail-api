# DayTrail API

Backend Express + TypeScript cho DayTrail. Chang 1A them ket noi MongoDB Atlas bang Mongoose; chua co tai khoan hay nghiep vu.

## Cau hinh local tren Windows

Runtime da kiem chung: Node.js 22.23.3 (c-ares 1.34.8). Tren Windows, khong dung Node 22.23.2/c-ares 1.34.6 vi loi DNS co the lam `mongodb+srv` tro nham den `127.0.0.1`.

```powershell
node --version
node -p "process.versions.ares"
node -e "const dns=require('node:dns'); console.log(dns.getServers())"
```

DNS Node phai la DNS that cua may/mang, khong phai `127.0.0.1` khi khong co DNS proxy local.

```powershell
cd C:\daytrail-api
npm ci
Copy-Item .env.example .env
```

Sua `.env` rieng tren may, khong commit file nay. `MONGODB_URI` nen tro den database `/daytrail`.

```dotenv
PORT=4000
FRONTEND_ORIGIN=http://localhost:5173
MONGODB_URI=mongodb+srv://<username>:<password>@<cluster-host>/daytrail?retryWrites=true&w=majority
MONGODB_CONNECT_TIMEOUT_MS=10000
MONGODB_PING_TIMEOUT_MS=3000
```

## Chay va kiem tra

```powershell
npm run typecheck
npm run lint
npm run build
npm run db:verify
npm run dev
```

Server chi lang nghe sau khi MongoDB connect va ping thanh cong. Voi Node 22.23.3 da kiem chung, chay binh thuong khong can `dns.setServers`, preload hay DNS workaround trong source.

```powershell
Invoke-RestMethod http://localhost:4000/api/health
Invoke-RestMethod http://localhost:4000/api/ready
```

- `/api/health`: tien trinh API dang hoat dong.
- `/api/ready`: MongoDB dang ket noi va ping thanh cong.

Frontend chay o terminal khac:

```powershell
cd C:\daytrail-web
npm run dev
```
