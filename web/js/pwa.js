/**
 * Register the service worker, enable COOP/COEP isolation, and auto-apply updates when idle.
 */

const UPDATE_TOAST_ID = 'pwa-update-toast';
const COI_RELOAD_KEY = 'dictationasm-coi-reload';

let appBusy = false;
let reloadQueued = false;
let refreshing = false;

/**
 * Mark long-running work so PWA reload waits until idle or the tab is hidden.
 * @param {boolean} busy
 */
export function setPWABusy(busy) {
  appBusy = Boolean(busy);
  if (!appBusy) {
    flushQueuedReload();
  }
}

/**
 * Ask the active service worker for its stamped shell version.
 * @returns {Promise<string>}
 */
export async function getShellVersion() {
  if (!('serviceWorker' in navigator)) {
    return '';
  }
  const reg = await navigator.serviceWorker.ready;
  const worker = reg.active || navigator.serviceWorker.controller;
  if (!worker) {
    return '';
  }
  return new Promise((resolve) => {
    const onMessage = (event) => {
      const data = event.data || {};
      if (data.type !== 'SW_VERSION') {
        return;
      }
      navigator.serviceWorker.removeEventListener('message', onMessage);
      const ver =
        typeof data.shell === 'string'
          ? data.shell
          : typeof data.version === 'string'
            ? data.version
            : '';
      resolve(ver);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    worker.postMessage({ type: 'GET_VERSION' });
    setTimeout(() => {
      navigator.serviceWorker.removeEventListener('message', onMessage);
      resolve('');
    }, 1500);
  });
}

/**
 * @returns {Promise<void>}
 */
export async function registerPWA() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
      updateViaCache: 'none',
    });
    wireAutoUpdate(reg);
    await ensureCrossOriginIsolated();
  } catch (err) {
    console.warn('PWA registration failed', err);
  }
}

/**
 * Ask the service worker to cache model URLs in the asset cache.
 * @param {string[]} urls
 * @param {(done: number, total: number) => void} [onProgress]
 */
export async function cacheModelUrls(urls, onProgress) {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Offline saving needs a service worker.');
  }
  const reg = await navigator.serviceWorker.ready;
  const worker = reg.active || navigator.serviceWorker.controller;
  if (!worker) {
    throw new Error('Service worker is not active yet. Refresh once.');
  }

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (ev) => {
      const data = ev.data || {};
      if (data.type === 'CACHE_PROGRESS') {
        onProgress?.(data.done | 0, data.total | 0);
        return;
      }
      if (data.type === 'CACHE_DONE') {
        resolve(undefined);
        return;
      }
      if (data.type === 'CACHE_ERROR') {
        reject(new Error(data.error || 'Could not cache models.'));
      }
    };
    worker.postMessage({ type: 'CACHE_URLS', urls }, [channel.port2]);
  });
}

/**
 * @param {ServiceWorkerRegistration} reg
 */
function wireAutoUpdate(reg) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    queueReload();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushQueuedReload();
    }
  });

  const askWaiting = () => {
    if (reg.waiting) {
      showUpdateToast('Updating...');
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
  };

  askWaiting();

  reg.addEventListener('updatefound', () => {
    const worker = reg.installing;
    if (!worker) {
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        if (navigator.serviceWorker.controller) {
          showUpdateToast('Updating...');
          (reg.waiting || worker).postMessage({ type: 'SKIP_WAITING' });
        }
      }
    });
  });

  const check = () => {
    if (!navigator.onLine) {
      return;
    }
    reg.update().catch(() => {});
  };

  window.addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      check();
    }
  });
  window.addEventListener('focus', check);
  setInterval(check, 60 * 1000);
  check();
}

function queueReload() {
  reloadQueued = true;
  flushQueuedReload();
}

function flushQueuedReload() {
  if (!reloadQueued || refreshing) {
    return;
  }
  if (appBusy && document.visibilityState === 'visible') {
    showUpdateToast('Update ready...');
    return;
  }
  refreshing = true;
  showUpdateToast('Updating...');
  window.location.reload();
}

/**
 * Pages hosts lack COOP/COEP. After the SW injects them, reload once so the
 * document becomes crossOriginIsolated and SharedArrayBuffer works.
 * @returns {Promise<void>}
 */
async function ensureCrossOriginIsolated() {
  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(COI_RELOAD_KEY);
    return;
  }

  if (!navigator.serviceWorker.controller) {
    await Promise.race([
      new Promise((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      }),
      new Promise((resolve) => {
        setTimeout(resolve, 4000);
      }),
    ]);
  }

  if (globalThis.crossOriginIsolated) {
    sessionStorage.removeItem(COI_RELOAD_KEY);
    return;
  }

  const attempts = Number(sessionStorage.getItem(COI_RELOAD_KEY) || '0');
  if (attempts >= 2) {
    console.warn('cross-origin isolation unavailable after reload');
    return;
  }

  sessionStorage.setItem(COI_RELOAD_KEY, String(attempts + 1));
  showUpdateToast('Updating...');
  window.location.reload();
  await new Promise(() => {});
}

/**
 * @param {string} text
 */
function showUpdateToast(text) {
  let el = document.getElementById(UPDATE_TOAST_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = UPDATE_TOAST_ID;
    el.className = 'pwa-toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.add('is-on');
}
