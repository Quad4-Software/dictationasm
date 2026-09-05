/**
 * Web Worker that runs Moonshine ASR and Silero VAD with transformers.js.
 * Both models share one ORT backend, so calls are serialized per model type.
 */

import { AutoModel, Tensor, pipeline, env } from '/vendor/transformers/transformers.min.js';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = true;
env.localModelPath = '/models/onnx/';
env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';

if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
  const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency
    ? navigator.hardwareConcurrency
    : 4;
  env.backends.onnx.wasm.numThreads = Math.max(2, Math.min(8, cores));
}

const SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 512;
const VAD_STATE_SHAPE = [2, 1, 128];
const VAD_STATE_SIZE = 2 * 1 * 128;
const WARMUP_SAMPLES = Math.round(SAMPLE_RATE * 0.25);

/**
 * Encoder stays fp32: Pages ships only encoder_model.onnx, and q8 encoders
 * are unreliable on the WASM/CPU EP. Decoder is q4 on WebGPU and q8 on WASM
 * (q4 decoder as a last WASM fallback when the quantized file is absent).
 */
const DTYPE_ATTEMPTS = {
  webgpu: [
    { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  ],
  wasm: [
    { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  ],
};

/** @type {any} */
let asr = null;
/** @type {string} */
let loadedId = '';
/** @type {string} */
let loadedDevice = '';
/** @type {any} */
let sileroVad = null;
/** @type {any} */
let vadSampleRate = null;
/** @type {any} */
let vadState = null;

/** Serializes every model call so ORT never sees overlapping runs. */
let chain = Promise.resolve();

/**
 * @param {() => Promise<any>} fn
 * @returns {Promise<any>}
 */
function queued(fn) {
  const next = chain.then(fn);
  chain = next.catch(() => {});
  return next;
}

/**
 * @param {any} data
 * @param {Transferable[]} [transfer]
 */
function post(data, transfer) {
  if (transfer && transfer.length) {
    self.postMessage(data, transfer);
    return;
  }
  self.postMessage(data);
}

function freshVadState() {
  return new Tensor('float32', new Float32Array(VAD_STATE_SIZE), VAD_STATE_SHAPE);
}

/**
 * @param {number} pcmLength
 * @returns {number}
 */
function maxNewTokensFor(pcmLength) {
  const sec = pcmLength / SAMPLE_RATE;
  return Math.max(16, Math.min(224, Math.ceil(sec * 8) + 8));
}

/**
 * @param {number} id
 * @param {string} onnxId
 * @param {string} device
 */
async function loadASR(id, onnxId, device) {
  if (asr && loadedId === onnxId && loadedDevice === device) {
    post({ id, type: 'loaded', onnxId, device });
    return;
  }
  post({ id, type: 'progress', status: 'loading moonshine', progress: 0.05 });
  const attempts = DTYPE_ATTEMPTS[device] || DTYPE_ATTEMPTS.wasm;
  let lastErr = null;
  asr = null;
  for (const dtype of attempts) {
    try {
      asr = await pipeline('automatic-speech-recognition', onnxId, {
        device,
        dtype,
        progress_callback: (p) => {
          const status = p && p.status ? String(p.status) : 'loading';
          let progress;
          if (typeof p?.progress === 'number') {
            progress = Math.min(0.9, p.progress / 100);
          } else if (status === 'done') {
            progress = 0.9;
          } else {
            return;
          }
          if (status === 'progress' && progress < 0.9) {
            return;
          }
          post({ id, type: 'progress', status, progress, file: p?.file });
        },
      });
      loadedId = onnxId;
      loadedDevice = device;
      post({ id, type: 'progress', status: 'warming up', progress: 0.95 });
      await asr(new Float32Array(WARMUP_SAMPLES));
      post({
        id,
        type: 'loaded',
        onnxId,
        device,
        dtype: `${dtype.encoder_model}/${dtype.decoder_model_merged}`,
      });
      return;
    } catch (err) {
      lastErr = err;
      console.warn('moonshine load attempt failed', device, dtype, err);
      asr = null;
      loadedId = '';
      loadedDevice = '';
    }
  }
  throw lastErr || new Error('Could not load Moonshine.');
}

/**
 * @param {number} id
 * @param {string} vadId
 */
async function loadVad(id, vadId) {
  if (sileroVad) {
    post({ id, type: 'vad-loaded' });
    return;
  }
  post({ id, type: 'progress', status: 'loading vad', progress: 0.05 });
  sileroVad = await AutoModel.from_pretrained(vadId, {
    config: { model_type: 'custom' },
    dtype: 'fp32',
  });
  vadSampleRate = new Tensor('int64', [SAMPLE_RATE], []);
  vadState = freshVadState();
  post({ id, type: 'vad-loaded' });
}

/**
 * Score 512-sample frames. stride > 1 reuses the last scored probability for
 * skipped frames so offline segmentation stays cheap without changing the
 * sample-aligned state machine in vad.js.
 * @param {Float32Array} pcm
 * @param {boolean} keepState
 * @param {number} stride
 * @returns {Promise<Float32Array>}
 */
async function vadProbabilities(pcm, keepState, stride) {
  const frames = Math.floor(pcm.length / VAD_FRAME_SAMPLES);
  const out = new Float32Array(frames);
  if (frames === 0) {
    return out;
  }
  const step = Math.max(1, Math.min(4, stride | 0 || 1));
  let state = keepState ? vadState : freshVadState();
  let lastProb = 0;
  for (let i = 0; i < frames; i++) {
    if (i % step === 0) {
      const frame = pcm.subarray(i * VAD_FRAME_SAMPLES, (i + 1) * VAD_FRAME_SAMPLES);
      const input = new Tensor('float32', frame, [1, frame.length]);
      const { stateN, output } = await sileroVad({ input, sr: vadSampleRate, state });
      state = stateN;
      lastProb = Number(output.data[0]);
    }
    out[i] = lastProb;
  }
  if (keepState) {
    vadState = state;
  }
  return out;
}

/**
 * @param {any} raw
 * @returns {string}
 */
function resultText(raw) {
  if (!raw) {
    return '';
  }
  if (typeof raw === 'string') {
    return raw.trim();
  }
  if (Array.isArray(raw)) {
    return raw.map((r) => String(r?.text || '')).join(' ').trim();
  }
  return String(raw.text || '').trim();
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const id = msg.id;
  try {
    if (msg.type === 'load') {
      const onnxId = String(msg.onnxId || '');
      if (!onnxId) {
        throw new Error('Missing ONNX model id.');
      }
      const device = msg.device === 'webgpu' ? 'webgpu' : 'wasm';
      await queued(() => loadASR(id, onnxId, device));
      return;
    }

    if (msg.type === 'load-vad') {
      const vadId = String(msg.vadId || 'silero-vad');
      await queued(() => loadVad(id, vadId));
      return;
    }

    if (msg.type === 'vad-probe') {
      if (!sileroVad) {
        throw new Error('Voice detector is not ready.');
      }
      const pcm = msg.pcm;
      if (!(pcm instanceof Float32Array)) {
        throw new Error('Bad VAD frame.');
      }
      const stride = typeof msg.stride === 'number' ? msg.stride : 1;
      const probs = await queued(() => vadProbabilities(pcm, msg.keepState !== false, stride));
      post({ id, type: 'vad-result', probs }, [probs.buffer]);
      return;
    }

    if (msg.type === 'vad-reset') {
      if (sileroVad) {
        vadState = freshVadState();
      }
      post({ id, type: 'vad-reset' });
      return;
    }

    if (msg.type === 'dictate') {
      if (!asr) {
        throw new Error('Moonshine is not ready.');
      }
      const pcm = msg.pcm;
      if (!(pcm instanceof Float32Array) || pcm.length === 0) {
        throw new Error('No sound found.');
      }
      post({ id, type: 'progress', status: 'transcribing', progress: 0.1 });
      const maxNew = maxNewTokensFor(pcm.length);
      const raw = await queued(() => asr(pcm, {
        max_new_tokens: maxNew,
        return_timestamps: false,
      }));
      post({ id, type: 'progress', status: 'done', progress: 1 });
      post({ id, type: 'result', text: resultText(raw) });
      return;
    }

    if (msg.type === 'dispose') {
      asr = null;
      sileroVad = null;
      vadSampleRate = null;
      vadState = null;
      loadedId = '';
      loadedDevice = '';
      post({ id, type: 'disposed' });
      return;
    }

    throw new Error(`Unknown worker message: ${msg.type}`);
  } catch (err) {
    post({
      id,
      type: 'error',
      message: err && err.message ? String(err.message) : String(err),
    });
  }
};
