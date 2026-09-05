/**
 * Extension bridge for dictationasm: load Moonshine, record mic, dictate.
 */

import { createAutoEngine } from '/js/engine/auto.js';
import { MicRecorder } from '/js/audio/mic.js';

const statusEl = document.getElementById('status');
const params = new URLSearchParams(location.search);
const extId = params.get('extId') || '';

/** @type {ReturnType<typeof createAutoEngine> | null} */
let engine = null;
/** @type {import('/js/engine/types.js').ModelInfo | null} */
let model = null;
/** @type {MicRecorder | null} */
let mic = null;
let recording = false;

function setStatus(msg) {
  if (statusEl) statusEl.textContent = msg;
}

function extensionRuntime() {
  const root = globalThis.chrome || globalThis.browser;
  return root?.runtime;
}

async function fetchDefaultModel() {
  let catalog;
  try {
    const res = await fetch('/api/models', { credentials: 'omit' });
    if (!res.ok) throw new Error('api');
    catalog = await res.json();
  } catch {
    const res = await fetch('/models.json', { credentials: 'omit' });
    catalog = await res.json();
  }
  const models = catalog.models || catalog || [];
  return models.find((m) => m.default) || models[0];
}

async function resolveModel(modelId) {
  if (modelId) {
    const res = await fetch('/api/models/' + encodeURIComponent(modelId), { credentials: 'omit' }).catch(() => null);
    if (res?.ok) return await res.json();
    const catalog = await (await fetch('/models.json', { credentials: 'omit' })).json();
    const models = catalog.models || catalog || [];
    return models.find((m) => m.id === modelId) || models.find((m) => m.default) || models[0];
  }
  return fetchDefaultModel();
}

async function ensureEngine(modelId) {
  const needSwitch = Boolean(modelId && model && model.id !== modelId);
  if (!model || needSwitch) {
    if (needSwitch && engine) {
      engine.dispose?.();
      engine = null;
    }
    model = await resolveModel(modelId);
  }
  if (!model) throw new Error('no model available');
  if (!engine) {
    engine = createAutoEngine();
    setStatus('Loading Moonshine model…');
    await engine.load(model, (p) => {
      if (p?.status) setStatus(String(p.status));
    });
    setStatus('Model ready (' + (engine.getBackend?.() || 'WASM') + ')');
  }
}

async function startRecord() {
  if (recording) return { ok: true, recording: true };
  await ensureEngine();
  mic = new MicRecorder();
  await mic.start();
  recording = true;
  setStatus('Recording… click Stop in the extension when done.');
  return { ok: true, recording: true };
}

async function stopRecord(opts = {}) {
  if (!mic || !recording) throw new Error('not recording');
  recording = false;
  setStatus('Processing audio…');
  const pcm = await mic.stop();
  mic = null;
  await ensureEngine();
  const result = await engine.dictate(pcm, {
    returnTimestamps: Boolean(opts.timestamps),
  });
  const text = typeof result === 'string' ? result : (result?.text || '');
  setStatus('Ready');
  return { text, backend: engine.getBackend?.() || '' };
}

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') throw new Error('invalid message');
  switch (msg.type) {
    case 'ping':
      return {
        ok: true,
        name: 'dictationasm',
        isolated: Boolean(globalThis.crossOriginIsolated),
        recording,
        ready: Boolean(engine),
      };
    case 'load-model':
      await ensureEngine(msg.modelId);
      return { ok: true, model: model?.id, backend: engine.getBackend?.() };
    case 'start-record':
      return startRecord();
    case 'stop-record':
      return stopRecord({
        timestamps: msg.timestamps,
      });
    case 'cancel-record':
      recording = false;
      mic?.cleanup?.();
      mic = null;
      setStatus('Cancelled');
      return { ok: true };
    case 'list-models': {
      const res = await fetch('/api/models', { credentials: 'omit' }).catch(() => null);
      if (res?.ok) return await res.json();
      return await (await fetch('/models.json', { credentials: 'omit' })).json();
    }
    case 'dispose':
      recording = false;
      mic?.cleanup?.();
      mic = null;
      engine?.dispose?.();
      engine = null;
      return { ok: true };
    default:
      throw new Error('unknown type: ' + msg.type);
  }
}

function connect() {
  const runtime = extensionRuntime();
  if (!runtime || !extId) {
    setStatus('Open this page from the dictationasm extension.');
    return;
  }
  let port;
  try {
    port = runtime.connect(extId, { name: 'dictationasm-bridge' });
  } catch (err) {
    setStatus('Connect failed: ' + err);
    return;
  }
  setStatus('Connected. Keep this tab focused when granting mic access.');
  port.onMessage.addListener((msg) => {
    const id = msg?.id;
    handleMessage(msg)
      .then((result) => port.postMessage({ id, ok: true, result }))
      .catch((err) => port.postMessage({ id, ok: false, error: String(err?.message || err) }));
  });
  port.onDisconnect.addListener(() => {
    setStatus('Extension disconnected.');
  });
  port.postMessage({ type: 'bridge-hello', name: 'dictationasm' });
}

connect();
