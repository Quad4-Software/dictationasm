import { TARGET_SAMPLE_RATE } from '../engine/types.js';

/**
 * Linear resample. Reuses out when provided and sized correctly.
 * @param {Float32Array} input
 * @param {number} inputRate
 * @param {number} [outputRate]
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function resampleLinear(input, inputRate, outputRate = TARGET_SAMPLE_RATE, out) {
  if (!input || input.length === 0) {
    return out && out.length === 0 ? out : new Float32Array(0);
  }
  if (inputRate === outputRate) {
    if (out && out.length === input.length) {
      out.set(input);
      return out;
    }
    return input;
  }
  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const dest = out && out.length === outLen ? out : new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const idx = src | 0;
    const frac = src - idx;
    const s0 = input[idx];
    const s1 = input[idx < last ? idx + 1 : last];
    dest[i] = s0 + (s1 - s0) * frac;
  }
  return dest;
}

/**
 * Mix planar AudioBuffer channels into mono without an interleaved temp buffer.
 * @param {AudioBuffer} buffer
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function mixAudioBufferMono(buffer, out) {
  const n = buffer.length;
  const ch = buffer.numberOfChannels;
  const dest = out && out.length === n ? out : new Float32Array(n);
  if (ch === 1) {
    dest.set(buffer.getChannelData(0));
    return dest;
  }
  const chans = new Array(ch);
  for (let c = 0; c < ch; c++) {
    chans[c] = buffer.getChannelData(c);
  }
  const inv = 1 / ch;
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let c = 0; c < ch; c++) {
      sum += chans[c][i];
    }
    dest[i] = sum * inv;
  }
  return dest;
}

/**
 * Downmix interleaved PCM to mono.
 * @param {Float32Array} input
 * @param {number} channels
 * @param {Float32Array} [out]
 * @returns {Float32Array}
 */
export function toMono(input, channels, out) {
  if (channels <= 1) {
    if (out && out.length === input.length) {
      out.set(input);
      return out;
    }
    return input;
  }
  const frames = (input.length / channels) | 0;
  const dest = out && out.length === frames ? out : new Float32Array(frames);
  const inv = 1 / channels;
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const base = i * channels;
    for (let c = 0; c < channels; c++) {
      sum += input[base + c];
    }
    dest[i] = sum * inv;
  }
  return dest;
}
