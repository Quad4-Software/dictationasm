/* dictationasm service worker: offline shell, COOP/COEP isolation, auto-update */
const APP = 'dictationasm';
const SHELL_VERSION = 'dev';
const ASSET_VERSION = 'v1';
const SHELL_CACHE = `${APP}-shell-${SHELL_VERSION}`;
const ASSET_CACHE = `${APP}-assets-${ASSET_VERSION}`;

/** Required for shell + WASM. Missing any of these fails install. */
const PRECACHE_REQUIRED = [
  '/',
  '/index.html',
  '/favicon.ico',
  '/manifest.webmanifest',
  '/models.json',
  '/css/app.css',
  '/js/main.js',
  '/js/pwa.js',
  '/js/ui/app.js',
  '/js/ui/wave.js',
  '/js/audio/decode.js',
  '/js/audio/mic.js',
  '/js/audio/resample.js',
  '/js/audio/pcm-buffer.js',
  '/js/audio/vad.js',
  '/js/export/formats.js',
  '/js/engine/registry.js',
  '/js/engine/types.js',
  '/js/engine/text-sanitize.js',
  '/js/engine/moonshine-webgpu.js',
  '/js/engine/moonshine-worker.js',
  '/js/engine/auto.js',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/fonts/syne-700.woff2',
  '/fonts/source-sans-400.woff2',
  '/fonts/source-sans-600.woff2',
];

/** Runtime extras. Skip quietly when not shipped (e.g. before Pages fetch). */
const PRECACHE_OPTIONAL = [
  '/vendor/transformers/transformers.min.js',
  '/vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
  '/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
  '/models/onnx/silero-vad/onnx/model.onnx',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(PRECACHE_REQUIRED);
      await Promise.all(
        PRECACHE_OPTIONAL.map(async (url) => {
          try {
            const res = await fetch(url, { credentials: 'same-origin' });
            if (res.ok) {
              await cache.put(url, res.clone());
            }
          } catch {
            /* optional */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter(isStaleCacheKey).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

/**
 * @param {string} key
 * @returns {boolean}
 */
function isStaleCacheKey(key) {
  if (key === SHELL_CACHE || key === ASSET_CACHE) {
    return false;
  }
  if (key.startsWith(`${APP}-shell-`) || key.startsWith(`${APP}-assets-`)) {
    return true;
  }
  return key.startsWith(`${APP}-v`);
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (data.type === 'GET_VERSION') {
    event.source &&
      event.source.postMessage({
        type: 'SW_VERSION',
        version: SHELL_VERSION,
        shell: SHELL_VERSION,
        assets: ASSET_VERSION,
      });
    return;
  }
  if (data.type === 'CACHE_URLS') {
    const port = event.ports && event.ports[0];
    event.waitUntil(cacheUrls(data.urls || [], port));
  }
});

/**
 * @param {string[]} urls
 * @param {MessagePort | undefined} port
 */
async function cacheUrls(urls, port) {
  try {
    const cache = await caches.open(ASSET_CACHE);
    const list = urls.filter((u) => typeof u === 'string' && u.startsWith('/'));
    for (let i = 0; i < list.length; i++) {
      const url = list[i];
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) {
          continue;
        }
        await cache.put(url, res.clone());
      } catch {
        continue;
      }
      port && port.postMessage({ type: 'CACHE_PROGRESS', done: i + 1, total: list.length });
    }
    port && port.postMessage({ type: 'CACHE_DONE' });
  } catch (err) {
    const msg = err && typeof err === 'object' && 'message' in err
      ? String(/** @type {{ message: string }} */ (err).message)
      : 'Could not cache models.';
    port && port.postMessage({ type: 'CACHE_ERROR', error: msg });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') {
    return;
  }
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') {
    return;
  }

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === '/sw.js' || url.pathname.startsWith('/build/')) {
    event.respondWith(networkOnly(req));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(req, SHELL_CACHE));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, SHELL_CACHE, '/index.html'));
    return;
  }

  if (
    url.pathname.startsWith('/models/') ||
    url.pathname.startsWith('/vendor/') ||
    url.pathname.startsWith('/fonts/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname.startsWith('/samples/')
  ) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  event.respondWith(networkFirst(req, SHELL_CACHE));
});

/**
 * GitHub Pages cannot set COOP/COEP. Inject them so SharedArrayBuffer works.
 * @param {Response} response
 * @returns {Response}
 */
function withIsolationHeaders(response) {
  if (!response || response.status === 0 || response.type === 'opaque') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function networkOnly(req) {
  return fetch(req);
}

async function networkFirst(req, cacheName, fallbackPath) {
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.ok) {
      const cache = await caches.open(cacheName);
      cache.put(req, fresh.clone());
    }
    return withIsolationHeaders(fresh);
  } catch {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    if (cached) {
      return withIsolationHeaders(cached);
    }
    if (fallbackPath) {
      const fallback = await cache.match(fallbackPath);
      if (fallback) {
        return withIsolationHeaders(fallback);
      }
    }
    return withIsolationHeaders(new Response('Offline', { status: 503, statusText: 'Offline' }));
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) {
    return withIsolationHeaders(cached);
  }
  const fresh = await fetch(req);
  if (fresh && fresh.ok) {
    cache.put(req, fresh.clone());
  }
  return withIsolationHeaders(fresh);
}
