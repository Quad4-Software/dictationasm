import test from 'node:test';
import assert from 'node:assert/strict';
import { createEnergyVad, createSileroVad, SILERO_FRAME_SAMPLES } from './vad.js';

/**
 * Fake Silero probe. Frames whose first sample is non-zero score as speech.
 * @param {Float32Array} pcm
 * @returns {Promise<Float32Array>}
 */
async function loudnessProbe(pcm) {
  const frames = pcm.length / SILERO_FRAME_SAMPLES;
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.abs(pcm[i * SILERO_FRAME_SAMPLES]) > 0.01 ? 0.9 : 0.01;
  }
  return out;
}

/**
 * @param {number} frames
 * @param {number} value
 */
function block(frames, value) {
  const pcm = new Float32Array(frames * SILERO_FRAME_SAMPLES);
  pcm.fill(value);
  return pcm;
}

test('silero vad ignores silence', async () => {
  const ends = [];
  const vad = createSileroVad({
    probeFrames: loudnessProbe,
    onSpeechEnd: (pcm) => ends.push(pcm),
  });
  vad.push(block(20, 0));
  await vad.flush();
  assert.equal(ends.length, 0);
});

test('silero vad commits an utterance on speech end', async () => {
  const ends = [];
  const starts = [];
  const vad = createSileroVad({
    probeFrames: loudnessProbe,
    minSilenceMs: 100,
    minSpeechMs: 100,
    onSpeechStart: (id) => starts.push(id),
    onSpeechEnd: (pcm, t0, t1, id) => ends.push({ len: pcm.length, t0, t1, id }),
  });
  vad.push(block(40, 0.4));
  vad.push(block(20, 0));
  await vad.flush();
  assert.equal(starts.length, 1);
  assert.equal(ends.length, 1);
  assert.equal(ends[0].id, 1);
  assert.ok(ends[0].len >= 40 * SILERO_FRAME_SAMPLES);
  assert.ok(ends[0].t1 > ends[0].t0);
});

test('silero vad discards utterances under the minimum', async () => {
  const ends = [];
  const vad = createSileroVad({
    probeFrames: loudnessProbe,
    minSilenceMs: 100,
    minSpeechMs: 1000,
    onSpeechEnd: (pcm) => ends.push(pcm),
  });
  vad.push(block(4, 0.4));
  vad.push(block(20, 0));
  await vad.flush();
  assert.equal(ends.length, 0);
});

test('silero vad emits partials while speech continues', async () => {
  const partials = [];
  const ends = [];
  const vad = createSileroVad({
    probeFrames: loudnessProbe,
    minSilenceMs: 100,
    minSpeechMs: 100,
    partialIntervalMs: 100,
    minPartialMs: 100,
    onPartial: (pcm, t0, t1, id) => partials.push({ len: pcm.length, t0, t1, id }),
    onSpeechEnd: (pcm) => ends.push(pcm),
  });
  vad.push(block(60, 0.4));
  vad.push(block(20, 0));
  await vad.flush();
  assert.ok(partials.length >= 3, `expected several partials, got ${partials.length}`);
  assert.ok(partials[1].len > partials[0].len);
  assert.equal(partials[0].id, 1);
  assert.equal(ends.length, 1);
});

test('silero vad cuts overlong speech into separate utterances', async () => {
  const ends = [];
  const vad = createSileroVad({
    probeFrames: loudnessProbe,
    minSilenceMs: 100,
    minSpeechMs: 50,
    maxUtteranceMs: 200,
    onSpeechEnd: (pcm, t0, t1, id) => ends.push({ len: pcm.length, id }),
  });
  vad.push(block(60, 0.4));
  await vad.flush();
  assert.ok(ends.length >= 3, `expected several cuts, got ${ends.length}`);
});

test('silero vad flushes trailing speech', async () => {
  const ends = [];
  const vad = createSileroVad({
    probeFrames: loudnessProbe,
    minSilenceMs: 400,
    minSpeechMs: 100,
    onSpeechEnd: (pcm) => ends.push(pcm),
  });
  vad.push(block(30, 0.4));
  await vad.flush();
  assert.equal(ends.length, 1);
  assert.ok(ends[0] instanceof Float32Array);
  assert.equal(ends[0].byteOffset, 0);
});

test('silero vad reports probe failures without throwing', async () => {
  const errors = [];
  const vad = createSileroVad({
    probeFrames: async () => {
      throw new Error('probe down');
    },
    onError: (err) => errors.push(String(err.message || err)),
    onSpeechEnd: () => {},
  });
  vad.push(block(4, 0.4));
  await vad.flush();
  assert.deepEqual(errors, ['probe down']);
});

test('energy vad ignores silence', () => {
  /** @type {Float32Array[]} */
  const ends = [];
  const vad = createEnergyVad({
    onSpeechEnd: (pcm) => ends.push(pcm),
    threshold: 0.02,
    hangoverMs: 100,
    minSpeechMs: 50,
    maxChunkMs: 2000,
  });
  vad.push(new Float32Array(1600));
  vad.flush();
  assert.equal(ends.length, 0);
});

test('energy vad emits speech then silence', () => {
  /** @type {Array<{ len: number, t0: number, t1: number }>} */
  const ends = [];
  const vad = createEnergyVad({
    onSpeechEnd: (pcm, t0, t1) => ends.push({ len: pcm.length, t0, t1 }),
    threshold: 0.02,
    hangoverMs: 100,
    minSpeechMs: 50,
    maxChunkMs: 5000,
    sampleRate: 16000,
  });
  const speech = new Float32Array(1600);
  speech.fill(0.2);
  vad.push(speech);
  const silence = new Float32Array(2000);
  vad.push(silence);
  assert.equal(ends.length, 1);
  assert.ok(ends[0].len >= 800);
  assert.ok(ends[0].t1 > ends[0].t0);
});

test('energy vad max chunk splits long speech', () => {
  /** @type {number[]} */
  const lens = [];
  const vad = createEnergyVad({
    onSpeechEnd: (pcm) => lens.push(pcm.length),
    threshold: 0.01,
    hangoverMs: 50,
    minSpeechMs: 20,
    maxChunkMs: 100,
    sampleRate: 16000,
  });
  const long = new Float32Array(4800);
  long.fill(0.3);
  vad.push(long);
  assert.ok(lens.length >= 2);
});

test('energy vad emit returns standalone Float32Array', () => {
  /** @type {Float32Array[]} */
  const ends = [];
  const vad = createEnergyVad({
    onSpeechEnd: (pcm) => ends.push(pcm),
    threshold: 0.02,
    hangoverMs: 50,
    minSpeechMs: 20,
    maxChunkMs: 5000,
    sampleRate: 16000,
  });
  const speech = new Float32Array(800);
  speech.fill(0.25);
  vad.push(speech);
  vad.flush();
  assert.equal(ends.length, 1);
  assert.ok(ends[0] instanceof Float32Array);
  assert.equal(ends[0].byteOffset, 0);
  assert.equal(ends[0].buffer.byteLength, ends[0].byteLength);
});

test('energy vad emits partials during speech', () => {
  const partials = [];
  const vad = createEnergyVad({
    onSpeechEnd: () => {},
    onPartial: (pcm) => partials.push(pcm.length),
    threshold: 0.02,
    hangoverMs: 500,
    minSpeechMs: 50,
    maxChunkMs: 5000,
    partialIntervalMs: 50,
    minPartialMs: 50,
    sampleRate: 16000,
  });
  const speech = new Float32Array(16000);
  speech.fill(0.3);
  vad.push(speech);
  assert.ok(partials.length >= 5, `expected partials, got ${partials.length}`);
});
