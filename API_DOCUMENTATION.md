# GAS Playwright API Documentation

Dokumentasi ini menjelaskan backend stateless untuk:
- Login ke Google Apps Script via Playwright.
- Ambil token URL hasil login.
- Ambil data dashboard table (`#dashboardTableBody`) sebagai JSON.

## 1. Ringkasan Arsitektur

- Backend **tidak menyimpan session/token** di database.
- Frontend menyimpan token sendiri (mis. `localStorage`).
- Backend menerima token dari frontend saat request dashboard.

Alur utama:
1. Frontend kirim email/password ke `POST /auth/login`.
2. Backend login via Playwright, ambil `urlToken` + `token`, set `expiresAt` (3 jam dari waktu login).
3. Frontend simpan token.
4. Frontend panggil `GET /dashboard?token=...`.
5. Backend buka halaman bertoken via Playwright, parse table, return JSON.

## 2. Requirement

- Node.js 18+ (disarankan 20+)
- Dependency:
  - `express`
  - `playwright`
  - `dotenv`

## 3. Environment Variables

Gunakan `.env`:

```env
PORT=3000
HEADLESS=true
NAVIGATION_TIMEOUT_MS=60000
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbx7Yf6D_PX12o2JX_jz6W2DDZrjmwtqo1j0soZRHcAJQTj3ChTz0lzRzFJxP726PTO5gQ/exec
```

Keterangan:
- `PORT`: port server Express.
- `HEADLESS`: mode browser Playwright (`true`/`false`).
- `NAVIGATION_TIMEOUT_MS`: timeout navigasi Playwright.
- `APPS_SCRIPT_URL`: URL dasar GAS (tanpa token).

## 4. Menjalankan Server

Install dependency:

```bash
npm install
```

Jalankan server:

```bash
npm start
```

Server aktif di:

```txt
http://localhost:3000
```

## 5. Endpoint API

### 5.1 GET `/health`

Healthcheck server.

Contoh response:

```json
{
  "success": true,
  "status": "ok",
  "service": "gas-playwright-api",
  "time": "2026-02-16T14:20:14.331Z"
}
```

### 5.2 GET `/session/status`

Cek status dasar mode stateless.

Query:
- `token` (opsional)

Catatan penting:
- Endpoint ini **tidak memverifikasi token ke GAS**.
- Validasi nyata tetap dilakukan di `GET /dashboard`.

Contoh:
- Tanpa token:

```json
{
  "success": true,
  "authenticated": false,
  "reason": "TOKEN_MISSING"
}
```

- Dengan token:

```json
{
  "success": true,
  "authenticated": true,
  "note": "Stateless mode: validasi token final dilakukan saat GET /dashboard."
}
```

### 5.3 POST `/auth/login`

Login menggunakan credential user ke GAS via Playwright.

Request body:

```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

Response sukses:

```json
{
  "success": true,
  "urlToken": "https://script.google.com/macros/s/.../exec?token=...",
  "token": "c25veX...",
  "expiresAt": "2026-02-16T17:20:14.331Z"
}
```

Keterangan:
- `expiresAt` dihitung backend sebagai `now + 3 jam`.
- Backend tidak menyimpan token; frontend yang menyimpan.

Error umum:
- `422 INVALID_CREDENTIALS_INPUT` jika email/password kosong.
- `401 LOGIN_FAILED` jika login gagal atau token tidak terbentuk.

### 5.4 GET `/dashboard`

Mengambil data dashboard dari halaman bertoken.

Query:
- `token` (wajib)
  - boleh token mentah, atau URL lengkap bertoken.

Contoh request:

```txt
GET /dashboard?token=c25veX...
```

Contoh response sukses:

```json
{
  "success": true,
  "source": "table",
  "user": "Nama User",
  "periode": "Februari 2026",
  "totalTransaksi": 123456,
  "rowCount": 15,
  "headers": ["No", "Produk", "Qty", "Total"],
  "data": [
    { "No": "1", "Produk": "Item A", "Qty": "2", "Total": "5000" }
  ]
}
```

Error umum:
- `400 TOKEN_REQUIRED` jika query token kosong.
- `401 TOKEN_INVALID` jika token invalid/expired/table tidak ditemukan.
- `500 DASHBOARD_FETCH_FAILED` untuk error internal lain.

## 6. Format Error Response

Semua error mengikuti format:

```json
{
  "success": false,
  "code": "ERROR_CODE",
  "message": "Penjelasan error"
}
```

## 7. Contoh cURL

### Login

```bash
curl -X POST http://localhost:3000/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"user@example.com\",\"password\":\"secret\"}"
```

### Dashboard dengan token mentah

```bash
curl "http://localhost:3000/dashboard?token=ISI_TOKEN"
```

### Dashboard dengan URL bertoken penuh

```bash
curl "http://localhost:3000/dashboard?token=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2F...%2Fexec%3Ftoken%3D..."
```

## 8. Alur Frontend yang Disarankan

1. Cek token di storage frontend.
2. Jika tidak ada token, tampilkan form login.
3. Submit login ke `POST /auth/login`.
4. Simpan `token` dan `expiresAt`.
5. Sebelum ambil dashboard, cek:
   - token ada
   - `Date.now() < new Date(expiresAt).getTime()`
6. Panggil `GET /dashboard?token=...`.
7. Jika `401 TOKEN_INVALID`, hapus token dan tampilkan login lagi.

## 9. Struktur File Utama

- `server.js`: HTTP API routes.
- `core/gas-playwright.js`: logic Playwright (login + fetch dashboard).
- `scripts/test-gas-playwright.js`: script pengujian flow manual.
- `scripts/test-token-screenshot.js`: script test screenshot URL bertoken.
- `.env.example`: template environment variable.

## 10. Catatan Operasional

- Jalankan backend di environment yang mengizinkan Playwright launch browser.
- Jika muncul error `spawn EPERM`, jalankan command dengan izin yang sesuai environment.
- Untuk production, disarankan tambah:
  - rate limit endpoint login,
  - request logging,
  - circuit breaker/retry kebijakan timeout Playwright.
