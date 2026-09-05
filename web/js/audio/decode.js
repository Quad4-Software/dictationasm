import { mixAudioBufferMono, resampleLinear } from './resample.js';
import { MAX_AUDIO_SAMPLES, TARGET_SAMPLE_RATE } from '../engine/types.js';

const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

const GUID_PCM = [0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
const GUID_FLOAT = [0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

/**
 * Decode audio or video File/Blob to 16 kHz mono Float32Array.
 * Fast path: PCM WAV via a zero-dependency decoder.
 * Fallback: Web Audio for compressed audio/video containers.
 * @param {Blob} blob
 * @returns {Promise<Float32Array>}
 */
export async function decodeToDictationPCM(blob) {
  if (!blob || blob.size === 0) {
    throw new Error('empty media blob');
  }
  const ab = await blob.arrayBuffer();
  const bytes = new Uint8Array(ab);
  /** @type {unknown} */
  let wavErr = null;

  if (isRiffWave(bytes)) {
    try {
      return clampPCM(decodeWavPCM(bytes));
    } catch (err) {
      wavErr = err;
    }
  }

  try {
    return await decodeViaWebAudio(ab);
  } catch (err) {
    const wavMsg = wavErr && typeof wavErr === 'object' && 'message' in wavErr
      ? String(/** @type {{ message: string }} */ (wavErr).message)
      : '';
    const webMsg = err && typeof err === 'object' && 'message' in err
      ? String(/** @type {{ message: string }} */ (err).message)
      : String(err);
    throw new Error(
      wavMsg
        ? `Could not decode WAV (${wavMsg}). Web Audio: ${webMsg}`
        : `Could not decode media: ${webMsg}`,
    );
  }
}

/**
 * @param {ArrayBuffer} ab
 * @returns {Promise<Float32Array>}
 */
async function decodeViaWebAudio(ab) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!AC) {
    throw new Error('Web Audio unavailable');
  }
  const ctx = new AC();
  try {
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // continue and still attempt decode
      }
    }
    const copy = ab.slice(0);
    const decoded = await ctx.decodeAudioData(copy);
    const mono = mixAudioBufferMono(decoded);
    const pcm =
      decoded.sampleRate === TARGET_SAMPLE_RATE
        ? mono
        : resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
    return clampPCM(pcm);
  } finally {
    await ctx.close().catch(() => {});
  }
}

/**
 * @param {Uint8Array} bytes
 */
function isRiffWave(bytes) {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  );
}

/**
 * Decode PCM / IEEE-float WAV to 16 kHz mono Float32Array.
 * Supports classic PCM, IEEE float, and WAVE_FORMAT_EXTENSIBLE.
 * @param {Uint8Array} data
 * @returns {Float32Array}
 */
export function decodeWavPCM(data) {
  if (data.length < 44) {
    throw new Error('wav too short');
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  /** @type {Uint8Array | null} */
  let pcm = null;

  let offset = 12;
  while (offset + 8 <= data.length) {
    const id0 = data[offset];
    const id1 = data[offset + 1];
    const id2 = data[offset + 2];
    const id3 = data[offset + 3];
    const size = view.getUint32(offset + 4, true);
    offset += 8;
    if (size > data.length - offset) {
      // truncated or mis-sized chunk. Use remaining bytes for data, otherwise stop.
      if (id0 === 0x64 && id1 === 0x61 && id2 === 0x74 && id3 === 0x61) {
        pcm = data.subarray(offset);
      }
      break;
    }
    if (id0 === 0x66 && id1 === 0x6d && id2 === 0x74 && id3 === 0x20) {
      if (size < 16) {
        throw new Error('invalid wav fmt');
      }
      audioFormat = view.getUint16(offset, true);
      channels = view.getUint16(offset + 2, true);
      sampleRate = view.getUint32(offset + 4, true);
      bits = view.getUint16(offset + 14, true);
      if (audioFormat === FORMAT_EXTENSIBLE && size >= 40) {
        const sub = data.subarray(offset + 24, offset + 40);
        if (guidEquals(sub, GUID_PCM)) {
          audioFormat = FORMAT_PCM;
        } else if (guidEquals(sub, GUID_FLOAT)) {
          audioFormat = FORMAT_IEEE_FLOAT;
        }
        const validBits = view.getUint16(offset + 18, true);
        if (validBits > 0) {
          bits = validBits;
        }
      }
    } else if (id0 === 0x64 && id1 === 0x61 && id2 === 0x74 && id3 === 0x61) {
      pcm = data.subarray(offset, offset + size);
    }
    offset += size + (size & 1);
  }

  if (!pcm || !channels || !sampleRate || !bits) {
    throw new Error('incomplete wav');
  }
  if (audioFormat !== FORMAT_PCM && audioFormat !== FORMAT_IEEE_FLOAT) {
    throw new Error(`unsupported wav format ${audioFormat}`);
  }

  const mono = decodePCMFrames(pcm, channels, bits, audioFormat);
  return sampleRate === TARGET_SAMPLE_RATE
    ? mono
    : resampleLinear(mono, sampleRate, TARGET_SAMPLE_RATE);
}

/**
 * @param {Uint8Array} bytes
 * @param {number[]} guid
 */
function guidEquals(bytes, guid) {
  if (bytes.length < 16) {
    return false;
  }
  for (let i = 0; i < 16; i++) {
    if (bytes[i] !== guid[i]) {
      return false;
    }
  }
  return true;
}

/**
 * @param {Uint8Array} data
 * @param {number} channels
 * @param {number} bits
 * @param {number} format
 * @returns {Float32Array}
 */
function decodePCMFrames(data, channels, bits, format) {
  const bps = Math.ceil(bits / 8);
  const frame = bps * channels;
  if (!frame) {
    throw new Error('invalid pcm frame');
  }
  const usable = data.length - (data.length % frame);
  if (usable <= 0) {
    throw new Error('truncated pcm');
  }
  const frames = usable / frame;
  const out = new Float32Array(frames);
  const view = new DataView(data.buffer, data.byteOffset, usable);
  const invCh = 1 / channels;

  if (format === FORMAT_PCM && channels === 1 && bits === 16) {
    for (let i = 0; i < frames; i++) {
      out[i] = view.getInt16(i * 2, true) * (1 / 32768);
    }
    return out;
  }

  for (let i = 0; i < frames; i++) {
    let sum = 0;
    const base = i * frame;
    for (let c = 0; c < channels; c++) {
      sum += sampleAt(view, base + c * bps, bits, format);
    }
    out[i] = sum * invCh;
  }
  return out;
}

/**
 * @param {DataView} view
 * @param {number} off
 * @param {number} bits
 * @param {number} format
 */
function sampleAt(view, off, bits, format) {
  if (format === FORMAT_IEEE_FLOAT && bits === 32) {
    return view.getFloat32(off, true);
  }
  if (format === FORMAT_IEEE_FLOAT && bits === 64) {
    return view.getFloat64(off, true);
  }
  if (format === FORMAT_PCM && bits === 16) {
    return view.getInt16(off, true) / 32768;
  }
  if (format === FORMAT_PCM && bits === 8) {
    return (view.getUint8(off) - 128) / 128;
  }
  if (format === FORMAT_PCM && bits === 24) {
    const b0 = view.getUint8(off);
    const b1 = view.getUint8(off + 1);
    const b2 = view.getUint8(off + 2);
    let v = (b2 << 16) | (b1 << 8) | b0;
    if (v >= 0x800000) {
      v -= 0x1000000;
    }
    return v / 8388608;
  }
  if (format === FORMAT_PCM && bits === 32) {
    return view.getInt32(off, true) / 2147483648;
  }
  throw new Error(`unsupported pcm sample ${format}/${bits}`);
}

/**
 * @param {Float32Array} pcm
 * @returns {Float32Array}
 */
function clampPCM(pcm) {
  if (!pcm.length) {
    throw new Error('decoded media has no samples');
  }
  let out = pcm;
  if (out.length > MAX_AUDIO_SAMPLES) {
    out = out.subarray(0, MAX_AUDIO_SAMPLES);
  }
  return out.byteOffset === 0 && out.buffer.byteLength === out.byteLength
    ? out
    : out.slice();
}
