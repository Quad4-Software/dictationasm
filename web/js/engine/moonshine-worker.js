/**
 * Web Worker that runs Moonshine ASR and Silero VAD with transformers.js.
 * Both models share one inference chain because transformers.js does not
 * support simultaneous inference on the same backend.
 */

import { AutoModel, Tensor, pipeline, env } from '/vendor/transformers/transformers.min.js';

env.allowLocalModels = true;
env.allowRemoteModels = false;
env.useBrowserCache = true;
env.localModelPath = '/models/onnx/';
env.backends.onnx.wasm.wasmPaths = '/vendor/transformers/';

const SAMPLE_RATE = 16000;
const VAD_FRAME_SAMPLES = 512;
const VAD_STATE_SHAPE = [2, 1, 128];
const VAD_STATE_SIZE = 2 * 1 * 128;

/** Decoder precision per backend. The encoder stays fp32 in both cases. */
const DTYPE_BY_DEVICE = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
};

/** @type {any} */
let asr = null;
/** @type {string} */
let loadedId = '';
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
 * @param {number} id
 * @param {string} onnxId
 * @param {string} device
 */
async function loadASR(id, onnxId, device) {
  if (asr && loadedId === onnxId) {
    post({ id, type: 'loaded', onnxId });
    return;
  }
  post({ id, type: 'progress', status: 'loading moonshine', progress: 0.05 });
  asr = await pipeline('automatic-speech-recognition', onnxId, {
    device,
    dtype: DTYPE_BY_DEVICE[device] || DTYPE_BY_DEVICE.wasm,
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
  post({ id, type: 'progress', status: 'warming up', progress: 0.95 });
  // One pass over silence compiles the WebGPU shaders before the mic opens.
  await asr(new Float32Array(SAMPLE_RATE));
  post({ id, type: 'loaded', onnxId });
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
    // The Silero repo ships no config.json, so hand transformers.js one inline.
    config: { model_type: 'custom' },
    dtype: 'fp32',
  });
  vadSampleRate = new Tensor('int64', [SAMPLE_RATE], []);
  vadState = freshVadState();
  post({ id, type: 'vad-loaded' });
}

/**
 * Score every whole 512-sample frame in pcm and return one probability each.
 * @param {Float32Array} pcm
 * @param {boolean} keepState
 * @returns {Promise<Float32Array>}
 */
async function vadProbabilities(pcm, keepState) {
  const frames = Math.floor(pcm.length / VAD_FRAME_SAMPLES);
  const out = new Float32Array(frames);
  if (frames === 0) {
    return out;
  }
  let state = keepState ? vadState : freshVadState();
  for (let i = 0; i < frames; i++) {
    const frame = pcm.subarray(i * VAD_FRAME_SAMPLES, (i + 1) * VAD_FRAME_SAMPLES);
    const input = new Tensor('float32', frame, [1, frame.length]);
    const { stateN, output } = await sileroVad({ input, sr: vadSampleRate, state });
    state = stateN;
    out[i] = Number(output.data[0]);
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
      const probs = await queued(() => vadProbabilities(pcm, msg.keepState !== false));
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
      const raw = await queued(() => asr(pcm));
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
