require('dotenv').config();

const express = require('express');
const {
  parseBoolean,
  loginAndGetToken,
  fetchDashboardByToken,
  closeSharedBrowser,
} = require('./core/gas-playwright');

const app = express();
app.use(express.json({ limit: '100kb' }));

const PORT = Number(process.env.PORT || 3000);
const HEADLESS = parseBoolean(process.env.HEADLESS, true);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);
const LOGIN_RATE_LIMIT_WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 60000);
const LOGIN_RATE_LIMIT_MAX = Number(process.env.LOGIN_RATE_LIMIT_MAX || 10);
const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbx7Yf6D_PX12o2JX_jz6W2DDZrjmwtqo1j0soZRHcAJQTj3ChTz0lzRzFJxP726PTO5gQ/exec';
const loginRateLimitStore = new Map();

function errorJson(res, status, code, message) {
  return res.status(status).json({
    success: false,
    code,
    message,
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function enforceLoginRateLimit(req, res, next) {
  const now = Date.now();
  const ip = getClientIp(req);
  const record = loginRateLimitStore.get(ip);

  if (!record || now >= record.resetAt) {
    loginRateLimitStore.set(ip, { count: 1, resetAt: now + LOGIN_RATE_LIMIT_WINDOW_MS });
    return next();
  }

  if (record.count >= LOGIN_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((record.resetAt - now) / 1000));
    res.set('Retry-After', String(retryAfterSec));
    return errorJson(
      res,
      429,
      'LOGIN_RATE_LIMITED',
      `Terlalu banyak percobaan login. Coba lagi dalam ${retryAfterSec} detik.`
    );
  }

  record.count += 1;
  loginRateLimitStore.set(ip, record);
  return next();
}

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`
    );
  });
  next();
});

app.get('/health', (req, res) => {
  return res.json({
    success: true,
    status: 'ok',
    service: 'gas-playwright-api',
    time: new Date().toISOString(),
  });
});

app.get('/session/status', (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return res.json({
      success: true,
      authenticated: false,
      reason: 'TOKEN_MISSING',
    });
  }

  return res.json({
    success: true,
    authenticated: true,
    note: 'Stateless mode: validasi token final dilakukan saat GET /dashboard.',
  });
});

app.post('/auth/login', enforceLoginRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const trimmedEmail = email.trim();

  if (!trimmedEmail || !password) {
    return errorJson(res, 422, 'INVALID_CREDENTIALS_INPUT', 'Email dan password wajib diisi.');
  }
  if (!isValidEmail(trimmedEmail)) {
    return errorJson(res, 422, 'INVALID_CREDENTIALS_INPUT', 'Format email tidak valid.');
  }
  if (password.length > 256) {
    return errorJson(res, 422, 'INVALID_CREDENTIALS_INPUT', 'Password terlalu panjang.');
  }

  try {
    const result = await loginAndGetToken({
      baseUrl: APPS_SCRIPT_URL,
      email: trimmedEmail,
      password,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
      headless: HEADLESS,
    });

    return res.json({
      success: true,
      urlToken: result.urlToken,
      token: result.token,
      expiresAt: result.expiresAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code === 'LOGIN_INVALID_CREDENTIALS') {
      return errorJson(res, 401, 'LOGIN_FAILED', message);
    }
    if (code === 'TIMEOUT') {
      return errorJson(res, 504, 'LOGIN_TIMEOUT', message);
    }
    console.error(`[${new Date().toISOString()}] LOGIN_FAILED: ${message}`);
    return errorJson(
      res,
      500,
      'LOGIN_FAILED',
      message
    );
  }
});

app.get('/dashboard', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (!token) {
    return errorJson(res, 400, 'TOKEN_REQUIRED', 'Parameter query "token" wajib diisi.');
  }
  if (token.length > 5000) {
    return errorJson(res, 422, 'INVALID_TOKEN_INPUT', 'Parameter token terlalu panjang.');
  }

  try {
    const dashboard = await fetchDashboardByToken({
      baseUrl: APPS_SCRIPT_URL,
      tokenOrUrl: token,
      timeoutMs: NAVIGATION_TIMEOUT_MS,
      headless: HEADLESS,
    });

    return res.json({
      success: true,
      source: dashboard.source,
      user: dashboard.user,
      periode: dashboard.periode,
      totalTransaksi: dashboard.totalTransaksi,
      rowCount: dashboard.rowCount,
      headers: dashboard.headers,
      data: dashboard.data,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (code === 'TOKEN_INVALID') {
      return errorJson(res, 401, 'TOKEN_INVALID', message);
    }
    if (code === 'TIMEOUT') {
      return errorJson(res, 504, 'DASHBOARD_TIMEOUT', message);
    }
    console.error(`[${new Date().toISOString()}] DASHBOARD_FETCH_FAILED: ${message}`);
    return errorJson(res, 500, 'DASHBOARD_FETCH_FAILED', message);
  }
});

app.get('/', (req, res) => {
  return res.json({
    success: true,
    message: 'API aktif. Gunakan POST /auth/login dan GET /dashboard?token=...',
  });
});

const server = app.listen(PORT, () => {
  console.log(`Server jalan di http://localhost:${PORT}`);
});

let isShuttingDown = false;
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[${new Date().toISOString()}] Menerima ${signal}, menutup server...`);
  server.close(async () => {
    try {
      await closeSharedBrowser();
      console.log(`[${new Date().toISOString()}] Shutdown selesai.`);
      process.exit(0);
    } catch (error) {
      console.error(
        `[${new Date().toISOString()}] Gagal close browser saat shutdown: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      process.exit(1);
    }
  });
}

process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});
