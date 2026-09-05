/**
 * Auto engine: Moonshine on WebGPU first, onnxruntime-web WASM fallback.
 */

import { createMoonshineEngine, probeWebGPU } from './moonshine-webgpu.js';

/**
 * @returns {import('./types.js').Engine}
 */
export function createAutoEngine() {
  /** @type {import('./types.js').Engine | null} */
  let active = null;
  /** @type {'WebGPU' | 'WASM' | ''} */
  let backend = '';
  let forcedWasm = false;
  /** @type {import('./types.js').ModelInfo | null} */
  let lastModel = null;
  /** @type {import('./types.js').VadInfo | null} */
  let lastVad = null;

  function disposeActive() {
    if (!active) {
      return;
    }
    try {
      active.dispose();
    } catch {
      /* ignore */
    }
    active = null;
  }

  /**
   * @param {import('./types.js').ModelInfo} model
   * @param {(ev: any) => void} [onProgress]
   * @param {boolean} [permanent]
   */
  async function useWasm(model, onProgress, permanent = false) {
    disposeActive();
    active = createMoonshineEngine('wasm');
    backend = 'WASM';
    if (permanent) {
      forcedWasm = true;
    }
    onProgress?.({ status: 'loading wasm fallback', progress: 0.05 });
    await active.load(model, onProgress);
    if (lastVad) {
      await active.loadVad?.(lastVad, onProgress);
    }
  }

  return {
    id: 'auto',

    getBackend() {
      if (active && typeof active.getBackend === 'function') {
        return active.getBackend();
      }
      return backend || 'WASM';
    },

    async load(model, onProgress) {
      lastModel = model;
      if (forcedWasm || !model.onnx_id) {
        await useWasm(model, onProgress, true);
        return;
      }

      const ok = await probeWebGPU();
      if (!ok) {
        await useWasm(model, onProgress, false);
        return;
      }

      try {
        disposeActive();
        active = createMoonshineEngine('webgpu');
        backend = 'WebGPU';
        onProgress?.({ status: 'loading webgpu', progress: 0.05 });
        await active.load(model, onProgress);
      } catch (err) {
        console.warn('WebGPU load failed, falling back to WASM', err);
        await useWasm(model, onProgress, false);
      }
    },

    async loadVad(vad, onProgress) {
      if (!active) {
        throw new Error('Voice engine is not ready.');
      }
      lastVad = vad;
      await active.loadVad?.(vad, onProgress);
    },

    async vadProbe(pcm) {
      if (!active || !active.vadProbe) {
        throw new Error('Voice detector is not ready.');
      }
      return active.vadProbe(pcm);
    },

    async vadReset() {
      await active?.vadReset?.();
    },

    async dictate(audio, opts = {}) {
      if (!active) {
        throw new Error('Voice engine is not ready.');
      }
      try {
        return await active.dictate(audio, opts);
      } catch (err) {
        if (backend === 'WebGPU' && lastModel) {
          console.warn('WebGPU dictate failed, falling back to WASM', err);
          await useWasm(lastModel, opts.onProgress, false);
          return active.dictate(audio, opts);
        }
        throw err;
      }
    },

    dispose() {
      disposeActive();
      backend = '';
      lastModel = null;
      lastVad = null;
    },
  };
}
