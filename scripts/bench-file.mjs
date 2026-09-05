import { chromium } from './screenshot/node_modules/playwright/index.mjs';

const base = process.env.BENCH_URL || 'http://127.0.0.1:8096';

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
});
const context = await browser.newContext();
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    get() {
      return undefined;
    },
  });
});
const page = await context.newPage();
page.on('console', (msg) => console.log('C', msg.type(), msg.text().slice(0, 240)));
page.on('pageerror', (e) => console.log('E', e.message));

await page.goto(`${base}/?nosw=1`, { waitUntil: 'load', timeout: 90000 });
const ready = await page.waitForFunction(() => {
  const s = document.getElementById('status')?.textContent || '';
  const e = document.getElementById('error');
  if (e && !e.hidden && (e.textContent || '').trim()) {
    return `ERR:${e.textContent}`;
  }
  if (/is ready|Still just on this device|Listening/i.test(s)) {
    return `OK:${s}`;
  }
  return null;
}, null, { timeout: 180000 });
console.log('ready', await ready.jsonValue());

const meta = await page.evaluate(async () => {
  const res = await fetch('/samples/jfk.wav');
  const buf = await res.arrayBuffer();
  const file = new File([buf], 'jfk.wav', { type: 'audio/wav' });
  const input = document.getElementById('file');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const m = document.getElementById('meta');
    const err = document.getElementById('error');
    if (err && !err.hidden && (err.textContent || '').trim()) {
      return `ERR ${err.textContent}`;
    }
    if (m && !m.hidden && /audio in/.test(m.textContent || '')) {
      return m.textContent;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return `TIMEOUT ${document.getElementById('status')?.textContent || ''}`;
});
console.log('RESULT', meta);
await browser.close();
