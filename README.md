# cekLakuVersiHp

Backend API stateless untuk login ke Google Apps Script (GAS) via Playwright, mengambil token URL, lalu membaca data dashboard table menjadi JSON.

## Fitur

- `POST /auth/login` untuk login dan ambil `token`.
- `GET /dashboard?token=...` untuk ambil data dashboard.
- `GET /health` untuk healthcheck.
- Rate limit sederhana untuk login.
- Browser Playwright singleton (lebih efisien dari launch per request).

## Tech Stack

- Node.js (CommonJS)
- Express
- Playwright
- Docker (untuk deploy stabil di Render)

## Persiapan

1. Install dependency:
```bash
npm install
```

2. Siapkan `.env`:
```env
PORT=3000
HEADLESS=true
NAVIGATION_TIMEOUT_MS=60000
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKFY.../exec
LOGIN_RATE_LIMIT_MAX=10
LOGIN_RATE_LIMIT_WINDOW_MS=60000
```

## Menjalankan Server

```bash
npm start
```

Server: `http://localhost:3000`

## Endpoint Ringkas

### 1) Health
- `GET /health`

### 2) Login
- `POST /auth/login`
- Body:
```json
{
  "email": "user@example.com",
  "password": "secret"
}
```

### 3) Dashboard
- `GET /dashboard?token=ISI_TOKEN`

## Script Testing

- `npm run test:gas` -> test flow login + extract dashboard.
- `npm run test:token-shot` -> screenshot halaman tokenized.

Catatan: `test:token-shot` butuh env `TOKENIZED_URL`.

## Deploy (Render)

Project sudah menyertakan `Dockerfile` berbasis image Playwright resmi.  
Panduan detail: `RENDER_DEPLOY.md`.

## Dokumentasi Tambahan

- `API_DOCUMENTATION.md`
- `FRONTEND_QUICKSTART.md`
- `RENDER_DEPLOY.md`

## License

Lihat file `LICENSE`.
