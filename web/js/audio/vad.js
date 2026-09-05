/**
 * Voice-activity detection for 16 kHz mono PCM.
 *
 * createSileroVad is the preferred detector. It owns the utterance state
 * machine and delegates frame scoring to an injected probe, which lets the
 * Silero ONNX model live in the dictation worker and keeps this file testable.
 * createEnergyVad is the dependency-free RMS fallback with the same shape.
 */

import { GrowablePCM } from './pcm-buffer.js';

/** Silero expects exactly 512 samples per frame at 16 kHz. */
export const SILERO_FRAME_SAMPLES = 512;

/** Tuning shared by both detectors, in milliseconds unless noted. */
export const VAD_DEFAULTS = {
  sampleRate: 16000,
  /** Probabilities above this start an utterance. */
  speechThreshold: 0.3,
  /** Once speaking, stay in speech until the probability drops below this. */
  exitThreshold: 0.1,
  /**
   * Silence needed after speech before the utterance is committed. Longer than
   * the usual conversational default so a breath mid-sentence does not split a
   * dictated line.
   */
  minSilenceMs: 700,
  /**
   * Audio kept on each side of the detected speech. Silero reports onset a
   * little late, and without this the first word loses its attack.
   */
  speechPadMs: 200,
  /** Utterances shorter than this are discarded as noise. */
  minSpeechMs: 250,
  /** Hard cut so a single utterance stays inside the Moonshine window. */
  maxUtteranceMs: 28000,
  /** How often a live partial is emitted while speech continues. */
  partialIntervalMs: 500,
  /** Shortest utterance worth transcribing as a partial. */
  minPartialMs: 400,
};

/**
 * @typedef {object} VadHooks
 * @property {(id: number) => void} [onSpeechStart]
 * @property {(pcm: Float32Array, t0: number, t1: number, id: number) => void} [onPartial]
 * @property {(pcm: Float32Array, t0: number, t1: number, id: number) => void} onSpeechEnd
 */

/**
 * @typedef {object} SileroVadOptions
 * @property {(pcm: Float32Array) => Promise<Float32Array>} probeFrames
 * @property {(err: unknown) => void} [onError]
 * @property {number} [sampleRate]
 * @property {number} [speechThreshold]
 * @property {number} [exitThreshold]
 * @property {number} [minSilenceMs]
 * @property {number} [speechPadMs]
 * @property {number} [minSpeechMs]
 * @property {number} [maxUtteranceMs]
 * @property {number} [partialIntervalMs]
 * @property {number} [minPartialMs]
 */

/**
 * Silero-backed detector. push is fire and forget, flush resolves once every
 * queued frame has been scored and any trailing utterance is committed.
 *
 * @param {SileroVadOptions & VadHooks} opts
 */
export function createSileroVad(opts) {
  const sampleRate = opts.sampleRate || VAD_DEFAULTS.sampleRate;
  const speechThreshold = opts.speechThreshold ?? VAD_DEFAULTS.speechThreshold;
  const exitThreshold = opts.exitThreshold ?? VAD_DEFAULTS.exitThreshold;
  const ms = (value, fallback) => Math.round(((value ?? fallback) / 1000) * sampleRate);
  const minSilence = ms(opts.minSilenceMs, VAD_DEFAULTS.minSilenceMs);
  const pad = ms(opts.speechPadMs, VAD_DEFAULTS.speechPadMs);
  const minSpeech = ms(opts.minSpeechMs, VAD_DEFAULTS.minSpeechMs);
  const maxUtterance = Math.max(minSpeech, ms(opts.maxUtteranceMs, VAD_DEFAULTS.maxUtteranceMs));
  const partialEvery = ms(opts.partialIntervalMs, VAD_DEFAULTS.partialIntervalMs);
  const minPartial = ms(opts.minPartialMs, VAD_DEFAULTS.minPartialMs);
  const preFrames = Math.max(1, Math.ceil(pad / SILERO_FRAME_SAMPLES));

  const stage = new GrowablePCM(SILERO_FRAME_SAMPLES * 64);
  const utterance = new GrowablePCM(sampleRate * 4);
  /** @type {Float32Array[]} */
  let pre = [];
  let inSpeech = false;
  let silenceRun = 0;
  let absolute = 0;
  let speechStart = 0;
  let sincePartial = 0;
  let utteranceId = 0;
  let disposed = false;
  /** @type {Promise<void>} */
  let pump = Promise.resolve();

  /**
   * @param {Float32Array} frame
   */
  function push(frame) {
    if (disposed || !frame || frame.length === 0) {
      return;
    }
    stage.push(frame);
    if (stage.length >= SILERO_FRAME_SAMPLES) {
      kick();
    }
  }

  function kick() {
    pump = pump.then(drain).catch((err) => {
      opts.onError?.(err);
    });
    return pump;
  }

  async function drain() {
    while (!disposed && stage.length >= SILERO_FRAME_SAMPLES) {
      const whole = Math.floor(stage.length / SILERO_FRAME_SAMPLES) * SILERO_FRAME_SAMPLES;
      const block = stage.shift(whole);
      let probs;
      try {
        probs = await opts.probeFrames(block);
      } catch (err) {
        opts.onError?.(err);
        return;
      }
      const frames = block.length / SILERO_FRAME_SAMPLES;
      for (let i = 0; i < frames; i++) {
        const start = i * SILERO_FRAME_SAMPLES;
        const frame = block.subarray(start, start + SILERO_FRAME_SAMPLES);
        step(frame, probs.length > i ? probs[i] : 0);
      }
    }
  }

  /**
   * @param {Float32Array} frame
   * @param {number} prob
   */
  function step(frame, prob) {
    const voiced = prob > speechThreshold || (inSpeech && prob >= exitThreshold);

    if (!inSpeech) {
      if (!voiced) {
        pre.push(frame);
        if (pre.length > preFrames) {
          pre.shift();
        }
        absolute += frame.length;
        return;
      }
      inSpeech = true;
      silenceRun = 0;
      sincePartial = 0;
      utteranceId += 1;
      utterance.reset();
      let preLen = 0;
      for (const older of pre) {
        utterance.push(older);
        preLen += older.length;
      }
      pre = [];
      speechStart = Math.max(0, absolute - preLen);
      opts.onSpeechStart?.(utteranceId);
    }

    utterance.push(frame);
    absolute += frame.length;
    silenceRun = voiced ? 0 : silenceRun + frame.length;
    sincePartial += frame.length;

    if (silenceRun >= minSilence) {
      commit();
      return;
    }
    if (utterance.length >= maxUtterance) {
      commit();
      return;
    }
    if (voiced && sincePartial >= partialEvery && utterance.length >= minPartial && opts.onPartial) {
      sincePartial = 0;
      const view = utterance.view();
      opts.onPartial(view.slice(), speechStart / sampleRate, (speechStart + view.length) / sampleRate, utteranceId);
    }
  }

  function commit() {
    const spoken = utterance.length - silenceRun;
    const keep = Math.min(utterance.length, Math.max(0, spoken + pad));
    const id = utteranceId;
    const t0 = speechStart / sampleRate;
    const pcm = keep > 0 ? utterance.view().slice(0, keep) : new Float32Array(0);
    reset();
    if (spoken < minSpeech || pcm.length === 0) {
      return;
    }
    opts.onSpeechEnd(pcm, t0, t0 + pcm.length / sampleRate, id);
  }

  function reset() {
    inSpeech = false;
    silenceRun = 0;
    sincePartial = 0;
    utterance.reset();
    pre = [];
  }

  async function flush() {
    if (disposed) {
      return;
    }
    // Zero-pad the tail so the last partial frame still gets scored.
    if (stage.length > 0 && stage.length < SILERO_FRAME_SAMPLES) {
      stage.push(new Float32Array(SILERO_FRAME_SAMPLES - stage.length));
    }
    await kick();
    if (inSpeech) {
      silenceRun = 0;
      commit();
    }
  }

  /**
   * Wait for every staged frame to be scored without committing the
   * utterance in progress. Offline segmentation uses this to feed a long
   * recording in slices instead of one huge probe call.
   */
  async function settle() {
    if (disposed) {
      return;
    }
    await kick();
  }

  function dispose() {
    disposed = true;
    reset();
    stage.reset();
  }

  return { push, settle, flush, dispose };
}

/**
 * @typedef {object} EnergyVadOptions
 * @property {number} [sampleRate]
 * @property {number} [threshold]
 * @property {number} [hangoverMs]
 * @property {number} [minSpeechMs]
 * @property {number} [maxChunkMs]
 * @property {number} [partialIntervalMs]
 * @property {number} [minPartialMs]
 */

/**
 * RMS fallback detector used when the Silero model cannot load.
 * @param {EnergyVadOptions & VadHooks} opts
 */
export function createEnergyVad(opts) {
  const sampleRate = opts.sampleRate || VAD_DEFAULTS.sampleRate;
  const threshold = opts.threshold ?? 0.015;
  const hangoverSamples = Math.max(1, Math.round(((opts.hangoverMs ?? 500) / 1000) * sampleRate));
  const minSpeechSamples = Math.max(1, Math.round(((opts.minSpeechMs ?? 300) / 1000) * sampleRate));
  const maxChunkSamples = Math.max(minSpeechSamples, Math.round(((opts.maxChunkMs ?? 12000) / 1000) * sampleRate));
  const partialEvery = Math.round(((opts.partialIntervalMs ?? VAD_DEFAULTS.partialIntervalMs) / 1000) * sampleRate);
  const minPartialSamples = Math.round(((opts.minPartialMs ?? VAD_DEFAULTS.minPartialMs) / 1000) * sampleRate);

  const buf = new GrowablePCM(maxChunkSamples);
  let inSpeech = false;
  let silenceRun = 0;
  let absoluteOffset = 0;
  let speechStartAbs = 0;
  let sincePartial = 0;
  let utteranceId = 0;

  /**
   * @param {Float32Array} frame
   */
  function push(frame) {
    if (!frame || frame.length === 0) {
      return;
    }
    for (let i = 0; i < frame.length; i++) {
      const sample = frame[i];
      const voiced = sample >= threshold || sample <= -threshold;

      if (!inSpeech) {
        if (voiced) {
          inSpeech = true;
          silenceRun = 0;
          sincePartial = 0;
          utteranceId += 1;
          speechStartAbs = absoluteOffset + i;
          buf.reset();
          buf.pushSample(sample);
          opts.onSpeechStart?.(utteranceId);
        }
        continue;
      }

      buf.pushSample(sample);
      if (voiced) {
        silenceRun = 0;
      } else {
        silenceRun += 1;
      }
      sincePartial += 1;

      const speechLen = buf.length;
      if (silenceRun >= hangoverSamples && speechLen - hangoverSamples >= minSpeechSamples) {
        emitTrimmed();
        continue;
      }
      if (speechLen >= maxChunkSamples) {
        emitAll();
        continue;
      }
      if (silenceRun === 0 && sincePartial >= partialEvery && speechLen >= minPartialSamples && opts.onPartial) {
        sincePartial = 0;
        const view = buf.view();
        opts.onPartial(
          view.slice(),
          speechStartAbs / sampleRate,
          (speechStartAbs + view.length) / sampleRate,
          utteranceId,
        );
      }
    }
    absoluteOffset += frame.length;
  }

  function flush() {
    if (inSpeech && buf.length >= minSpeechSamples) {
      emitAll();
    }
    resetSpeech();
  }

  function emitTrimmed() {
    const keep = Math.max(0, buf.length - silenceRun);
    if (keep < minSpeechSamples) {
      resetSpeech();
      return;
    }
    const id = utteranceId;
    const pcm = buf.take(keep);
    const t0 = speechStartAbs / sampleRate;
    const t1 = (speechStartAbs + keep) / sampleRate;
    resetSpeech();
    opts.onSpeechEnd(pcm, t0, t1, id);
  }

  function emitAll() {
    if (buf.length < minSpeechSamples) {
      resetSpeech();
      return;
    }
    const id = utteranceId;
    const n = buf.length;
    const pcm = buf.take();
    const t0 = speechStartAbs / sampleRate;
    const t1 = (speechStartAbs + n) / sampleRate;
    resetSpeech();
    opts.onSpeechEnd(pcm, t0, t1, id);
  }

  function resetSpeech() {
    inSpeech = false;
    silenceRun = 0;
    sincePartial = 0;
    buf.reset();
  }

  async function settle() {
    /* the energy detector scores frames inline, nothing to wait for */
  }

  function dispose() {
    resetSpeech();
  }

  return { push, settle, flush, dispose };
}
