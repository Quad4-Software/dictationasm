/**
 * Moonshine dictation engine backed by transformers.js in a worker.
 * The same worker also hosts Silero VAD so utterance detection and
 * transcription share one onnxruntime instance.
 */

import { MAX_UTTERANCE_SAMPLES, TARGET_SAMPLE_RATE } from './types.js';
import { collapseRepeatLoops } from './text-sanitize.js';

const WORKER_URL = '/js/engine/moonshine-worker.js';

/**
 * @returns {Promise<boolean>}
 */
export async function probeWebGPU() {
  try {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return false;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return false;
    }
    const device = await adapter.requestDevice();
    try {
      device.destroy?.();
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {'webgpu' | 'wasm'} device
 * @returns {import('./types.js').Engine}
 */
export function createMoonshineEngine(device) {
  /** @type {Worker | null} */
  let worker = null;
  let seq = 1;
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, onProgress?: Function }>} */
  const pending = new Map();
  let loadedOnnxId = '';
  let vadReady = false;

  function ensureWorker() {
    if (worker) {
      return worker;
    }
    worker = new Worker(WORKER_URL, { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      const slot = pending.get(msg.id);
      if (!slot) {
        return;
      }
      if (msg.type === 'progress') {
        slot.onProgress?.({ status: msg.status, progress: msg.progress, file: msg.file });
        return;
      }
      pending.delete(msg.id);
      if (msg.type === 'error') {
        slot.reject(new Error(msg.message || 'Dictation failed.'));
        return;
      }
      slot.resolve(msg);
    };
    worker.onerror = (ev) => {
      const err = new Error(ev.message || 'Dictation worker failed.');
      for (const [, slot] of pending) {
        slot.reject(err);
      }
      pending.clear();
      worker = null;
      loadedOnnxId = '';
      vadReady = false;
    };
    return worker;
  }

  /**
   * @param {string} type
   * @param {Record<string, any>} payload
   * @param {(ev: any) => void} [onProgress]
   * @param {Transferable[]} [transfer]
   */
  function call(type, payload, onProgress, transfer = []) {
    const id = seq++;
    const w = ensureWorker();
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, onProgress });
      w.postMessage({ id, type, ...payload }, transfer);
    });
  }

  return {
    id: `moonshine-${device}`,

    getBackend() {
      return device === 'webgpu' ? 'WebGPU' : 'WASM';
    },

    async load(model, onProgress) {
      const onnxId = model.onnx_id;
      if (!onnxId) {
        throw new Error('This model has no ONNX build.');
      }
      if (loadedOnnxId === onnxId) {
        onProgress?.({ status: 'model cached', progress: 1 });
        return;
      }
      onProgress?.({ status: 'loading moonshine', progress: 0.02 });
      await call('load', { onnxId, device }, onProgress);
      loadedOnnxId = onnxId;
      onProgress?.({ status: 'model ready', progress: 1 });
    },

    async loadVad(vad, onProgress) {
      if (vadReady) {
        return;
      }
      onProgress?.({ status: 'loading vad', progress: 0.02 });
      await call('load-vad', { vadId: vad?.onnx_id || 'silero-vad' }, onProgress);
      vadReady = true;
    },

    async vadProbe(pcm, opts = {}) {
      if (!vadReady) {
        throw new Error('Voice detector is not ready.');
      }
      const copy = pcm instanceof Float32Array ? pcm.slice() : new Float32Array(0);
      const stride = typeof opts.stride === 'number' ? opts.stride : 1;
      const msg = await call(
        'vad-probe',
        { pcm: copy, keepState: opts.keepState !== false, stride },
        undefined,
        [copy.buffer],
      );
      return msg.probs instanceof Float32Array ? msg.probs : new Float32Array(0);
    },

    async vadReset() {
      if (!vadReady) {
        return;
      }
      await call('vad-reset', {});
    },

    async dictate(audio, opts = {}) {
      if (!loadedOnnxId) {
        throw new Error('Voice engine is not ready.');
      }
      if (!(audio instanceof Float32Array) || audio.length === 0) {
        throw new Error('No sound found.');
      }
      let pcm = audio;
      if (pcm.length > MAX_UTTERANCE_SAMPLES) {
        pcm = pcm.subarray(0, MAX_UTTERANCE_SAMPLES);
      }
      // Copy so the worker can own the buffer without aliasing UI state.
      const copy = pcm.slice();
      const seconds = copy.length / TARGET_SAMPLE_RATE;
      opts.onProgress?.({ status: 'transcribing', progress: 0.05 });
      const msg = await call('dictate', { pcm: copy }, opts.onProgress, [copy.buffer]);
      const text = collapseRepeatLoops(String(msg.text || '').trim());
      opts.onProgress?.({ status: 'done', progress: 1 });
      if (opts.returnTimestamps === false) {
        return { text };
      }
      return {
        text,
        chunks: text ? [{ text, timestamp: /** @type {[number, number]} */ ([0, seconds]) }] : [],
      };
    },

    dispose() {
      loadedOnnxId = '';
      vadReady = false;
      if (!worker) {
        return;
      }
      try {
        worker.postMessage({ id: seq++, type: 'dispose' });
      } catch {
        /* ignore */
      }
      worker.terminate();
      worker = null;
      pending.clear();
    },
  };
}

/**
 * @returns {import('./types.js').Engine}
 */
export function createMoonshineWebGPUEngine() {
  return createMoonshineEngine('webgpu');
}

/**
 * @returns {import('./types.js').Engine}
 */
export function createMoonshineWasmEngine() {
  return createMoonshineEngine('wasm');
}
