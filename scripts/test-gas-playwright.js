require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APPS_SCRIPT_URL =
  process.env.APPS_SCRIPT_URL ||
  'https://script.google.com/macros/s/AKfycbx7Yf6D_PX12o2JX_jz6W2DDZrjmwtqo1j0soZRHcAJQTj3ChTz0lzRzFJxP726PTO5gQ/exec';
const HEADLESS = parseBoolean(process.env.HEADLESS, true);
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);
const LOGIN_EMAIL = process.env.LOGIN_EMAIL || '';
const LOGIN_PASSWORD = process.env.LOGIN_PASSWORD || '';

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const lower = String(value).toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return fallback;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function logFrameTree(frame, indent = 0) {
  const pad = ' '.repeat(indent);
  console.log(`${pad}- name="${frame.name() || '(no-name)'}" url="${frame.url()}"`);
  for (const child of frame.childFrames()) {
    logFrameTree(child, indent + 2);
  }
}

function buildFrameTree(frame) {
  return {
    name: frame.name() || '(no-name)',
    url: frame.url(),
    children: frame.childFrames().map((child) => buildFrameTree(child)),
  };
}

function firstChildByName(frame, name) {
  return frame.childFrames().find((f) => f.name() === name) || null;
}

function getFrameByPath(page, names) {
  let current = page.mainFrame();
  for (const name of names) {
    current = firstChildByName(current, name);
    if (!current) return null;
  }
  return current;
}

async function waitForFramePath(page, names, timeoutMs, options = {}) {
  const start = Date.now();
  let lastState = '';

  while (Date.now() - start < timeoutMs) {
    const frame = getFrameByPath(page, names);
    const frameUrl = frame ? frame.url() : '(not-found)';
    const urlReady = options.requireNonBlankUrl ? frame && frameUrl && frameUrl !== 'about:blank' : !!frame;

    lastState = `path=${names.join(' > ')}, url=${frameUrl}`;
    if (frame && urlReady) return frame;

    await page.waitForTimeout(300);
  }

  throw new Error(`Timeout menunggu frame path. ${lastState}`);
}

async function waitForTokenOrLoginError(page, timeoutMs) {
  const start = Date.now();
  let lastUrl = '';

  while (Date.now() - start < timeoutMs) {
    const frame = getFrameByPath(page, ['sandboxFrame', 'userHtmlFrame']);
    if (frame) {
      const url = frame.url();
      lastUrl = url;

      if (url && url.includes('token=')) return frame;

      const loginError = await frame.evaluate(() => {
        const errorEl = document.querySelector('#login-error');
        if (!errorEl) return { visible: false, text: '' };

        const style = window.getComputedStyle(errorEl);
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          errorEl.textContent &&
          errorEl.textContent.trim().length > 0;

        return {
          visible: Boolean(visible),
          text: (errorEl.textContent || '').trim(),
        };
      });

      if (loginError.visible) {
        throw new Error(loginError.text || 'Email atau password salah.');
      }
    }

    await page.waitForTimeout(300);
  }

  throw new Error(
    `Timeout menunggu URL token di stack ke-3 atau pesan login error. URL terakhir: ${lastUrl || '(kosong)'}`
  );
}

async function waitForLoginInputs(frame) {
  try {
    await frame.waitForSelector('input[type="email"]', { timeout: 10000 });
    await frame.waitForSelector('input[type="password"]', { timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const cleaned = value.split(',').join('').trim();
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

async function extractDashboardFromTable(frame) {
  return frame.evaluate(() => {
    const tableBody = document.querySelector('#dashboardTableBody');
    if (!tableBody) return null;

    const table = tableBody.closest('table');
    const headers = table
      ? Array.from(table.querySelectorAll('thead th'))
          .map((th) => (th.textContent || '').trim())
          .filter((h) => h.length > 0)
      : [];

    const rows = Array.from(tableBody.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.querySelectorAll('td,th')).map((cell) => (cell.textContent || '').trim())
    );

    const data = rows
      .filter((cells) => cells.some((c) => c.length > 0))
      .map((cells) => {
        if (headers.length > 0 && headers.length === cells.length) {
          const record = {};
          headers.forEach((header, idx) => {
            record[header] = cells[idx] || '';
          });
          return record;
        }
        return cells;
      });

    const pageText = (document.body?.innerText || '').replace(/\s+/g, ' ');
    const findField = (regex) => {
      const match = pageText.match(regex);
      return match ? match[1].trim() : '';
    };

    return {
      source: 'table',
      user: findField(/user\s*[:\-]\s*([^\n\r]+)/i),
      periode: findField(/periode\s*[:\-]\s*([^\n\r]+)/i),
      totalTransaksi: findField(/total\s*transaksi\s*[:\-]\s*([0-9.,]+)/i),
      headers,
      data,
    };
  });
}

async function run() {
  const runId = timestamp();
  const outputDir = path.join(process.cwd(), 'artifacts', runId);
  ensureDir(outputDir);

  console.log('=== Playwright GAS Check ===');
  console.log(`URL: ${APPS_SCRIPT_URL}`);
  console.log(`HEADLESS: ${HEADLESS}`);
  console.log(`Timeout: ${NAVIGATION_TIMEOUT_MS}ms`);

  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);

    await page.goto(APPS_SCRIPT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: NAVIGATION_TIMEOUT_MS,
    });

    console.log('Frame tree after initial load:');
    logFrameTree(page.mainFrame());
    fs.writeFileSync(path.join(outputDir, 'frame-tree-initial.json'), JSON.stringify(buildFrameTree(page.mainFrame()), null, 2), 'utf8');

    const userHtmlFrame = await waitForFramePath(page, ['sandboxFrame', 'userHtmlFrame'], NAVIGATION_TIMEOUT_MS, {
      requireNonBlankUrl: true,
    });

    console.log('userHtmlFrame ditemukan. Mengecek apakah ada form login...');
    const hasLoginInputs = await waitForLoginInputs(userHtmlFrame);
    console.log(`Login form terdeteksi: ${hasLoginInputs}`);

    if (!hasLoginInputs) {
      const htmlPath = path.join(outputDir, 'user-frame-no-login.html');
      fs.writeFileSync(htmlPath, await userHtmlFrame.content(), 'utf8');
      console.log(`Saved HTML: ${htmlPath}`);
      return;
    }

    if (!LOGIN_EMAIL || !LOGIN_PASSWORD) {
      throw new Error('LOGIN_EMAIL / LOGIN_PASSWORD wajib diisi untuk login test.');
    }

    await userHtmlFrame.fill('input[type="email"]', LOGIN_EMAIL);
    await userHtmlFrame.fill('input[type="password"]', LOGIN_PASSWORD);

    const submitSelector = '#loginBtn';
    const hasSubmitButton = await userHtmlFrame.locator(submitSelector).count();
    if (!hasSubmitButton) {
      console.log('Tombol submit #loginBtn tidak ditemukan.');
      const htmlPath = path.join(outputDir, 'login-form-no-button.html');
      fs.writeFileSync(htmlPath, await userHtmlFrame.content(), 'utf8');
      console.log(`Saved HTML: ${htmlPath}`);
      return;
    }

    console.log('Kredensial terisi. Submit login...');
    await Promise.all([page.waitForLoadState('networkidle', { timeout: NAVIGATION_TIMEOUT_MS }), userHtmlFrame.click(submitSelector)]);

    console.log(`Current page URL: ${page.url()}`);
    console.log('Frame tree after submit:');
    logFrameTree(page.mainFrame());
    fs.writeFileSync(path.join(outputDir, 'frame-tree-after-submit.json'), JSON.stringify(buildFrameTree(page.mainFrame()), null, 2), 'utf8');

    // Step 2: ambil URL bertoken dari stack ke-3 setelah login.
    const stack3UserFrame = await waitForTokenOrLoginError(page, NAVIGATION_TIMEOUT_MS);
    const tokenizedUrl = stack3UserFrame.url();

    const tokenizedUrlPath = path.join(outputDir, 'tokenized-url.txt');
    fs.writeFileSync(tokenizedUrlPath, `${tokenizedUrl}\n`, 'utf8');
    console.log(`Tokenized URL (stack-3): ${tokenizedUrl}`);
    console.log(`Saved tokenized URL: ${tokenizedUrlPath}`);

    // Step 3: buka URL token dan tunggu halaman ganti.
    await page.goto(tokenizedUrl, {
      waitUntil: 'networkidle',
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    console.log(`Navigated to tokenized URL. Current page URL: ${page.url()}`);

    console.log('Frame tree on tokenized page:');
    logFrameTree(page.mainFrame());
    fs.writeFileSync(path.join(outputDir, 'frame-tree-token-page.json'), JSON.stringify(buildFrameTree(page.mainFrame()), null, 2), 'utf8');

    // Step 4: ambil data dari iframe stack ke-3 pada halaman tokenized.
    const tokenPageStack3User = await waitForFramePath(page, ['sandboxFrame', 'userHtmlFrame'], NAVIGATION_TIMEOUT_MS, {
      requireNonBlankUrl: true,
    });

    try {
      await tokenPageStack3User.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS });
    } catch {
      // Continue with best-effort content extraction.
    }

    const stack3HtmlPath = path.join(outputDir, 'token-page-stack-3-userHtmlFrame.html');
    fs.writeFileSync(stack3HtmlPath, await tokenPageStack3User.content(), 'utf8');
    console.log(`Saved HTML (token page stack-3): ${stack3HtmlPath}`);

    const tableExtracted = await extractDashboardFromTable(tokenPageStack3User);
    if (!tableExtracted) {
      throw new Error('Data table (#dashboardTableBody) tidak ditemukan pada iframe stack ke-3 di halaman tokenized.');
    }

    const headers = Array.isArray(tableExtracted.headers) ? tableExtracted.headers : [];
    const normalized = {
      user: typeof tableExtracted.user === 'string' ? tableExtracted.user : '',
      periode: typeof tableExtracted.periode === 'string' ? tableExtracted.periode : '',
      totalTransaksi: asNumber(tableExtracted.totalTransaksi),
      data: Array.isArray(tableExtracted.data) ? tableExtracted.data : [],
    };

    const jsonPath = path.join(outputDir, 'dashboard-data.json');
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          source: 'table',
          user: normalized.user,
          periode: normalized.periode,
          totalTransaksi: normalized.totalTransaksi,
          rowCount: normalized.data.length,
          headers,
          data: normalized.data,
        },
        null,
        2
      ),
      'utf8'
    );
    console.log(`Dashboard data saved: ${jsonPath}`);
    console.log(
      `Ringkasan: source=table, user="${normalized.user}", periode="${normalized.periode}", totalTransaksi=${normalized.totalTransaksi}, rows=${normalized.data.length}`
    );
    return;
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error('Test gagal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
