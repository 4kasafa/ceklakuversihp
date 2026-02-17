require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const TOKENIZED_URL =
  process.env.TOKENIZED_URL || '';
const HEADLESS = String(process.env.HEADLESS || 'true').toLowerCase() !== 'false';
const NAVIGATION_TIMEOUT_MS = Number(process.env.NAVIGATION_TIMEOUT_MS || 60000);

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function run() {
  if (!TOKENIZED_URL) {
    throw new Error('TOKENIZED_URL wajib diisi di environment variable.');
  }

  const runId = timestamp();
  const outputDir = path.join(process.cwd(), 'artifacts', runId);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log('=== Tokenized URL Screenshot Test ===');
  console.log(`URL: ${TOKENIZED_URL}`);
  console.log(`HEADLESS: ${HEADLESS}`);
  console.log(`Timeout: ${NAVIGATION_TIMEOUT_MS}ms`);

  const browser = await chromium.launch({ headless: HEADLESS });
  try {
    const page = await browser.newPage();
    await page.goto(TOKENIZED_URL, { waitUntil: 'networkidle', timeout: NAVIGATION_TIMEOUT_MS });

    const screenshotPath = path.join(outputDir, 'tokenized-page.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`Screenshot saved: ${screenshotPath}`);

    const htmlPath = path.join(outputDir, 'tokenized-page.html');
    fs.writeFileSync(htmlPath, await page.content(), 'utf8');
    console.log(`HTML saved: ${htmlPath}`);
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error('Test gagal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
