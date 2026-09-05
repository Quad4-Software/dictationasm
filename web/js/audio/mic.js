import { GrowablePCM } from './pcm-buffer.js';
import { resampleLinear } from './resample.js';
import { TARGET_SAMPLE_RATE } from '../engine/types.js';

/**
 * Microphone capture via ScriptProcessor (raw PCM) with MediaRecorder fallback.
 */
export class MicRecorder {
  constructor() {
    /** @type {MediaStream | null} */
    this.stream = null;
    /** @type {AudioContext | null} */
    this.audioCtx = null;
    /** @type {ScriptProcessorNode | null} */
    this.processor = null;
    /** @type {MediaStreamAudioSourceNode | null} */
    this.source = null;
    /** @type {AnalyserNode | null} */
    this.analyser = null;
    /** @type {MediaRecorder | null} */
    this.recorder = null;
    /** @type {BlobPart[]} */
    this.chunks = [];
    /** @type {'pcm' | 'mediarecorder' | null} */
    this.mode = null;
    this.pcm = new GrowablePCM(TARGET_SAMPLE_RATE * 16);
    /** @type {Uint8Array} */
    this.waveScratch = new Uint8Array(2048);
    /** @type {((frame: Float32Array) => void) | null} */
    this.onFrame = null;
    /** @type {Float32Array | null} */
    this.frameScratch = null;
  }

  /**
   * @param {{ onFrame?: (frame16k: Float32Array) => void }} [opts]
   * @returns {Promise<void>}
   */
  async start(opts = {}) {
    this.cleanup();
    this.pcm.reset();
    this.chunks = [];
    this.onFrame = opts.onFrame || null;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });

    this.audioCtx = new AudioContext();
    this.source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.source.connect(this.analyser);

    if (typeof this.audioCtx.createScriptProcessor === 'function') {
      this.mode = 'pcm';
      const bufferSize = 4096;
      this.processor = this.audioCtx.createScriptProcessor(bufferSize, 1, 1);
      this.processor.onaudioprocess = (ev) => {
        const input = ev.inputBuffer.getChannelData(0);
        const rate = this.audioCtx ? this.audioCtx.sampleRate : TARGET_SAMPLE_RATE;
        /** @type {Float32Array} */
        let frame;
        if (rate === TARGET_SAMPLE_RATE) {
          frame = input;
        } else {
          frame = resampleLinear(input, rate, TARGET_SAMPLE_RATE, this.frameScratch || undefined);
          if (frame.length && (!this.frameScratch || this.frameScratch.length !== frame.length)) {
            this.frameScratch = frame;
          }
        }
        // Store 16 kHz only so long recordings stay ~3x smaller than native 48 kHz capture.
        this.pcm.push(frame);
        if (this.onFrame) {
          this.onFrame(frame);
        }
      };
      const gain = this.audioCtx.createGain();
      gain.gain.value = 0;
      this.source.connect(this.processor);
      this.processor.connect(gain);
      gain.connect(this.audioCtx.destination);
      return;
    }

    this.mode = 'mediarecorder';
    const mime = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
      }
    };
    this.recorder.start(250);
  }

  /** @returns {Uint8Array} */
  getWaveform() {
    if (!this.analyser) {
      return this.waveScratch.subarray(0, 0);
    }
    if (this.waveScratch.length !== this.analyser.fftSize) {
      this.waveScratch = new Uint8Array(this.analyser.fftSize);
    }
    this.analyser.getByteTimeDomainData(this.waveScratch);
    return this.waveScratch;
  }

  /** @returns {Promise<Float32Array>} */
  async stop() {
    if (this.mode === 'pcm') {
      const raw = this.pcm.take();
      this.cleanup();
      if (!raw.length) {
        throw new Error('no mic samples captured');
      }
      return raw;
    }

    const blob = await new Promise((resolve, reject) => {
      if (!this.recorder) {
        reject(new Error('recorder not started'));
        return;
      }
      this.recorder.onstop = () => {
        resolve(new Blob(this.chunks, { type: this.recorder?.mimeType || 'audio/webm' }));
      };
      this.recorder.onerror = () => reject(new Error('recording failed'));
      if (this.recorder.state !== 'inactive') {
        this.recorder.stop();
      }
    });
    this.cleanup();
    const { decodeToDictationPCM } = await import('./decode.js');
    return decodeToDictationPCM(blob);
  }

  cleanup() {
    this.onFrame = null;
    if (this.processor) {
      try {
        this.processor.onaudioprocess = null;
        this.processor.disconnect();
      } catch {
        /* ignore */
      }
      this.processor = null;
    }
    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        /* ignore */
      }
      this.source = null;
    }
    if (this.recorder && this.recorder.state !== 'inactive') {
      try {
        this.recorder.stop();
      } catch {
        /* ignore */
      }
    }
    this.recorder = null;
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        track.stop();
      }
    }
    this.stream = null;
    if (this.audioCtx) {
      void this.audioCtx.close();
      this.audioCtx = null;
    }
    this.analyser = null;
    this.mode = null;
  }
}

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const type of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return '';
}
