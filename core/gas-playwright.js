const { chromium } = require('playwright');

class CoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoreError';
    this.code = code;
  }
}

let sharedBrowser = null;
let sharedBrowserPromise = null;
let sharedBrowserHeadless = null;

async function getSharedBrowser(headless) {
  if (sharedBrowser && sharedBrowser.isConnected() && sharedBrowserHeadless === headless) {
    return sharedBrowser;
  }

  if (sharedBrowser && sharedBrowser.isConnected() && sharedBrowserHeadless !== headless) {
    await sharedBrowser.close().catch(() => {});
    sharedBrowser = null;
    sharedBrowserPromise = null;
    sharedBrowserHeadless = null;
  }

  if (!sharedBrowserPromise) {
    sharedBrowserPromise = chromium
      .launch({ headless })
      .then((browser) => {
        sharedBrowser = browser;
        sharedBrowserHeadless = headless;
        browser.on('disconnected', () => {
          sharedBrowser = null;
          sharedBrowserPromise = null;
          sharedBrowserHeadless = null;
        });
        return browser;
      })
      .catch((error) => {
        sharedBrowser = null;
        sharedBrowserPromise = null;
        sharedBrowserHeadless = null;
        throw error;
      });
  }

  return sharedBrowserPromise;
}

async function closeSharedBrowser() {
  if (!sharedBrowser) return;
  try {
    await sharedBrowser.close();
  } finally {
    sharedBrowser = null;
    sharedBrowserPromise = null;
    sharedBrowserHeadless = null;
  }
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  const lower = String(value).toLowerCase();
  if (lower === 'true' || lower === '1' || lower === 'yes') return true;
  if (lower === 'false' || lower === '0' || lower === 'no') return false;
  return fallback;
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

async function waitForFramePath(page, names, timeoutMs, requireNonBlankUrl = false) {
  const start = Date.now();
  let lastState = '';

  while (Date.now() - start < timeoutMs) {
    const frame = getFrameByPath(page, names);
    const frameUrl = frame ? frame.url() : '(not-found)';
    const ready = requireNonBlankUrl ? frame && frameUrl !== 'about:blank' : !!frame;

    lastState = `path=${names.join(' > ')}, url=${frameUrl}`;
    if (ready) return frame;

    await page.waitForTimeout(300);
  }

  throw new CoreError('TIMEOUT', `Timeout menunggu frame path. ${lastState}`);
}

async function waitForTokenOrLoginError(page, timeoutMs) {
  const start = Date.now();
  let lastUrl = '';

  while (Date.now() - start < timeoutMs) {
    const frame = getFrameByPath(page, ['sandboxFrame', 'userHtmlFrame']);
    if (frame) {
      const url = frame.url();
      lastUrl = url;

      if (url && url.includes('token=')) {
        return frame;
      }

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
        throw new CoreError('LOGIN_INVALID_CREDENTIALS', loginError.text || 'Email atau password salah.');
      }
    }

    await page.waitForTimeout(300);
  }

  throw new CoreError(
    'TIMEOUT',
    `Timeout menunggu URL token pada stack ke-3 atau pesan login error. URL terakhir: ${lastUrl || '(kosong)'}`
  );
}

async function findFrameContainingSelector(rootFrame, selector) {
  const handle = await rootFrame.$(selector);
  if (handle) {
    await handle.dispose();
    return rootFrame;
  }

  for (const child of rootFrame.childFrames()) {
    const found = await findFrameContainingSelector(child, selector);
    if (found) return found;
  }
  return null;
}

async function waitForDashboardDataReady(frame, timeoutMs) {
  const start = Date.now();
  let lastState = 'unknown';

  while (Date.now() - start < timeoutMs) {
    const state = await frame.evaluate(() => {
      const tableBody = document.querySelector('#dashboardTableBody');
      if (!tableBody) {
        return { ready: false, state: 'TABLE_BODY_NOT_FOUND' };
      }

      const text = (tableBody.textContent || '').replace(/\s+/g, ' ').trim();
      if (/^memuat data\.{0,3}$/i.test(text)) {
        return { ready: false, state: 'LOADING_PLACEHOLDER' };
      }

      const rows = Array.from(tableBody.querySelectorAll('tr'));
      const dataRows = rows.filter((tr) =>
        Array.from(tr.querySelectorAll('td,th')).some((cell) => (cell.textContent || '').trim().length > 0)
      );

      if (dataRows.length === 0) {
        return { ready: false, state: 'ROWS_EMPTY' };
      }

      return { ready: true, state: 'READY' };
    });

    lastState = state.state;
    if (state.ready) return;

    await frame.page().waitForTimeout(300);
  }

  throw new CoreError('TIMEOUT', `Timeout menunggu data dashboard siap. State terakhir: ${lastState}`);
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

function extractTokenParam(tokenizedUrl) {
  try {
    const parsed = new URL(tokenizedUrl);
    return parsed.searchParams.get('token') || '';
  } catch {
    return '';
  }
}

function buildTokenizedUrl(baseUrl, tokenOrUrl) {
  if (!tokenOrUrl) return '';
  if (tokenOrUrl.startsWith('http://') || tokenOrUrl.startsWith('https://')) {
    return tokenOrUrl;
  }

  const joiner = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${joiner}token=${encodeURIComponent(tokenOrUrl)}`;
}

async function loginAndGetToken({
  baseUrl,
  email,
  password,
  timeoutMs,
  headless,
}) {
  const browser = await getSharedBrowser(headless);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    try {
      await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

      const loginFrame = await waitForFramePath(page, ['sandboxFrame', 'userHtmlFrame'], timeoutMs, true);

      await loginFrame.waitForSelector('input[type="email"]', { timeout: 10000 });
      await loginFrame.waitForSelector('input[type="password"]', { timeout: 10000 });
      await loginFrame.fill('input[type="email"]', email.trim());
      await loginFrame.fill('input[type="password"]', password);

      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: timeoutMs }),
        loginFrame.click('#loginBtn'),
      ]);

      const tokenFrame = await waitForTokenOrLoginError(page, timeoutMs);
      const urlToken = tokenFrame.url();
      const token = extractTokenParam(urlToken);
      if (!token) {
        throw new CoreError('LOGIN_FAILED', 'Login berhasil, tetapi token tidak ditemukan pada URL hasil login.');
      }

      const expiresAt = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString();
      return { urlToken, token, expiresAt };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('timeout')) {
        throw new CoreError('TIMEOUT', message);
      }
      throw new CoreError('LOGIN_FAILED', message);
    }
  } finally {
    await context.close();
  }
}

async function fetchDashboardByToken({
  baseUrl,
  tokenOrUrl,
  timeoutMs,
  headless,
}) {
  const targetUrl = buildTokenizedUrl(baseUrl, tokenOrUrl);
  if (!targetUrl) {
    throw new CoreError('TOKEN_INVALID', 'Token kosong.');
  }

  const browser = await getSharedBrowser(headless);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: timeoutMs });

      const initialFrame = await waitForFramePath(page, ['sandboxFrame', 'userHtmlFrame'], timeoutMs, true);
      let dataFrame = await findFrameContainingSelector(initialFrame, '#dashboardTableBody');
      if (!dataFrame) {
        dataFrame = await findFrameContainingSelector(page.mainFrame(), '#dashboardTableBody');
      }
      if (!dataFrame) {
        throw new CoreError('TOKEN_INVALID', 'Data table (#dashboardTableBody) tidak ditemukan. Token mungkin tidak valid.');
      }

      await waitForDashboardDataReady(dataFrame, timeoutMs);
      const extracted = await extractDashboardFromTable(dataFrame);
      if (!extracted) {
        throw new CoreError('DASHBOARD_PARSE_FAILED', 'Gagal parsing data table dashboard.');
      }

      return {
        source: extracted.source,
        user: extracted.user || '',
        periode: extracted.periode || '',
        totalTransaksi: asNumber(extracted.totalTransaksi),
        rowCount: Array.isArray(extracted.data) ? extracted.data.length : 0,
        headers: Array.isArray(extracted.headers) ? extracted.headers : [],
        data: Array.isArray(extracted.data) ? extracted.data : [],
        tokenizedUrl: targetUrl,
      };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('timeout')) {
        throw new CoreError('TIMEOUT', message);
      }
      throw new CoreError('DASHBOARD_FETCH_FAILED', message);
    }
  } finally {
    await context.close();
  }
}

module.exports = {
  parseBoolean,
  loginAndGetToken,
  fetchDashboardByToken,
  closeSharedBrowser,
};
