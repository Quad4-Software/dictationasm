/**
 * Reusable Playwright screenshot tool for dictationasm.
 *
 * Starts the local binary (or uses SCREENSHOT_BASE_URL), seeds a demo
 * transcript so the UI looks finished, and writes PNGs under docs/screenshots.
 *
 * Usage (from repo root):
 *   make screenshots
 *   node scripts/screenshot/capture.mjs
 *
 * Env:
 *   SCREENSHOT_BASE_URL   skip local server (e.g. https://dictationasm.quad4.io)
 *   SCREENSHOT_OUT        output dir (default: docs/screenshots)
 *   SCREENSHOT_BIN        server binary (default: bin/dictationasm)
 *   SCREENSHOT_LISTEN     bind addr (default: 127.0.0.1:18765)
 *   SCREENSHOT_ONLY       comma list of shot ids
 *   CHROMIUM_PATH         chromium/chrome executable override
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUT = resolve(process.env.SCREENSHOT_OUT || join(ROOT, 'docs/screenshots'));
const BIN = process.env.SCREENSHOT_BIN || join(ROOT, 'bin/dictationasm');
const LISTEN = process.env.SCREENSHOT_LISTEN || '127.0.0.1:18765';
const BASE = process.env.SCREENSHOT_BASE_URL || `http://${LISTEN}`;
const ONLY = new Set(
  (process.env.SCREENSHOT_ONLY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** @typedef {{ id: string, device: 'desktop' | 'mobile' | 'og', viewport: { width: number, height: number }, dpr: number, seed?: boolean }} Shot */

/** @type {Shot[]} */
const SHOTS = [
  {
    id: 'desktop',
    device: 'desktop',
    viewport: { width: 1440, height: 900 },
    dpr: 2,
    seed: true,
  },
  {
    id: 'mobile',
    device: 'mobile',
    viewport: { width: 390, height: 844 },
    dpr: 2,
    seed: true,
  },
  {
    id: 'og',
    device: 'og',
    viewport: { width: 1200, height: 630 },
    dpr: 1,
    seed: true,
  },
];

const DEMO_CHUNKS = [
  { t0: 0.0, t1: 2.4, text: 'Ask not what your country can do for you.' },
  { t0: 2.4, t1: 5.1, text: 'Ask what you can do for your country.' },
];

/**
 * @param {string} path
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} url
 * @param {number} [attempts]
 */
async function waitForReady(url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await sleep(400);
  }
  throw new Error(`server not ready at ${url}`);
}

async function startServer() {
  if (process.env.SCREENSHOT_BASE_URL) {
    return null;
  }
  if (!(await exists(BIN))) {
    throw new Error(`missing binary ${BIN} (run: make build)`);
  }
  await mkdir(OUT, { recursive: true });
  const logPath = join(OUT, 'server.log');
  const log = createWriteStream(logPath, { flags: 'w' });
  const child = spawn(BIN, ['-web', 'web', '-addr', LISTEN], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  child.on('exit', (code) => {
    if (code && code !== 0) {
      console.error(`server exited ${code}; see ${logPath}`);
    }
  });
  await waitForReady(BASE);
  return child;
}

async function clearOldShots() {
  await mkdir(OUT, { recursive: true });
  const entries = await readdir(OUT);
  for (const name of entries) {
    if (name.endsWith('.png') || name === 'index.json') {
      await unlink(join(OUT, name)).catch(() => {});
    }
  }
}

/**
 * @returns {Promise<string | undefined>}
 */
async function resolveChromium() {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  for (const path of candidates) {
    if (await exists(path)) return path;
  }
  return undefined;
}

/**
 * @param {import('playwright').Browser} browser
 * @param {Shot} shot
 */
async function openPage(browser, shot) {
  const context = await browser.newContext({
    viewport: shot.viewport,
    deviceScaleFactor: shot.dpr,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.addInitScript(() => {
    // Local Go already sends COOP/COEP. Block SW so controllerchange cannot reload mid-shot.
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register = async () => {
        throw new Error('screenshot: service worker disabled');
      };
    }
    const loc = window.location;
    loc.reload = () => {};
  });
  const page = await context.newPage();
  return { context, page };
}

/**
 * @param {import('playwright').Page} page
 */
async function settle(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => document.fonts.ready).catch(() => {});
  await page
    .waitForFunction(
      () => {
        const model = document.getElementById('model');
        const status = document.getElementById('status');
        const hasModels = model instanceof HTMLSelectElement && model.options.length > 0;
        const text = ((status && status.textContent) || '').trim();
        const ready =
          /ready when you are|is ready\.?$/i.test(text) ||
          (/done in /i.test(text) && !/getting ready|warming|loading|almost ready/i.test(text));
        return hasModels && ready;
      },
      { timeout: 90000 },
    )
    .catch(() => {});
  await page.addStyleTag({
    content: `
      #pwa-update-toast { display: none !important; }
    `,
  });
  await sleep(300);
}

/**
 * @param {import('playwright').Page} page
 */
async function seedDemo(page) {
  await page.evaluate((chunks) => {
    const transcript = document.getElementById('transcript');
    const status = document.getElementById('status');
    const meta = document.getElementById('meta');
    const spinner = document.getElementById('spinner');
    const err = document.getElementById('error');
    const progressTrack = document.querySelector('.progress-track');
    const model = document.getElementById('model');
    const btnCopy = document.getElementById('btn-copy');
    const btnExport = document.getElementById('btn-export');
    const btnClear = document.getElementById('btn-clear');

    if (!(transcript instanceof HTMLElement)) return;

    if (model instanceof HTMLSelectElement && model.options.length) {
      const quick = Array.from(model.options).find((o) => /quick/i.test(o.textContent || ''));
      if (quick) model.value = quick.value;
    }

    const frag = document.createDocumentFragment();
    for (const c of chunks) {
      const row = document.createElement('div');
      row.className = 'seg';
      row.dataset.start = String(c.t0);
      row.dataset.end = String(c.t1);
      const time = document.createElement('button');
      time.type = 'button';
      time.className = 'seg-time';
      time.disabled = true;
      const mm = Math.floor(c.t0 / 60);
      const ss = Math.floor(c.t0 % 60);
      time.textContent = `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
      const text = document.createElement('span');
      text.className = 'seg-text';
      text.textContent = c.text;
      row.append(time, text);
      frag.appendChild(row);
    }
    transcript.replaceChildren(frag);

    if (status) status.textContent = 'Done in 1.8s · WebGPU';
    if (meta) {
      meta.hidden = false;
      meta.textContent = 'Quick · 5.1s audio · offline';
    }
    if (spinner) spinner.hidden = true;
    if (err) err.hidden = true;
    if (progressTrack instanceof HTMLElement) progressTrack.hidden = true;
    if (btnCopy instanceof HTMLButtonElement) btnCopy.disabled = false;
    if (btnExport instanceof HTMLButtonElement) btnExport.disabled = false;
    if (btnClear instanceof HTMLButtonElement) btnClear.disabled = false;
  }, DEMO_CHUNKS);
  await sleep(400);
}

/**
 * @returns {Promise<{ file: string, device: string }[]>}
 */
async function capture() {
  await clearOldShots();
  const child = await startServer();
  const executablePath = await resolveChromium();
  const browser = await chromium.launch({
    headless: true,
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });

  /** @type {{ file: string, device: string }[]} */
  const index = [];

  try {
    const shots = ONLY.size ? SHOTS.filter((s) => ONLY.has(s.id)) : SHOTS;
    if (!shots.length) {
      throw new Error(`no shots matched SCREENSHOT_ONLY=${[...ONLY].join(',')}`);
    }

    for (const shot of shots) {
      const { context, page } = await openPage(browser, shot);
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page);
      if (shot.seed !== false) {
        await seedDemo(page);
      }

      const file = `${shot.id}.png`;
      await page.screenshot({
        path: join(OUT, file),
        fullPage: false,
        type: 'png',
      });
      index.push({ file, device: shot.device });
      console.log(`wrote ${join(OUT, file)}`);
      await context.close();
    }

    await writeFile(
      join(OUT, 'index.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          base: BASE,
          shots: index,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await browser.close();
    if (child) {
      child.kill('SIGTERM');
      await sleep(400);
      if (!child.killed) child.kill('SIGKILL');
    }
  }

  return index;
}

capture().catch((err) => {
  console.error(err);
  process.exit(1);
});
