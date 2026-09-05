/**
 * Shared dictation types.
 */

/**
 * @typedef {object} ModelInfo
 * @property {string} id
 * @property {string} label
 * @property {string} engine
 * @property {string} onnx_id
 * @property {string} path
 * @property {string} language
 * @property {number} size_hint_mb
 * @property {string} [notes]
 * @property {boolean} [default]
 * @property {boolean} [optional]
 * @property {number} [speed_rank]
 * @property {number} [accuracy_rank]
 */

/**
 * @typedef {object} VadInfo
 * @property {string} id
 * @property {string} onnx_id
 * @property {string} path
 * @property {number} [size_hint_mb]
 */

/** @typedef {{ text: string, chunks?: Array<{ text: string, timestamp?: [number|null, number|null] }> }} TranscriptResult */

/** @typedef {{ status?: string, progress?: number, file?: string }} ProgressEvent */

/**
 * @typedef {object} DictateOptions
 * @property {boolean} [returnTimestamps]
 * @property {(ev: ProgressEvent) => void} [onProgress]
 * @property {(partial: TranscriptResult) => void} [onPartial]
 */

/**
 * Engine is the swappable dictation backend contract.
 * loadVad, vadProbe and vadReset are only present on backends that can also
 * run voice-activity detection, callers must feature-detect them.
 *
 * @typedef {object} Engine
 * @property {string} id
 * @property {() => string} [getBackend]
 * @property {(model: ModelInfo, onProgress?: (ev: ProgressEvent) => void) => Promise<void>} load
 * @property {(audio: Float32Array, opts?: DictateOptions) => Promise<TranscriptResult>} dictate
 * @property {(vad: VadInfo, onProgress?: (ev: ProgressEvent) => void) => Promise<void>} [loadVad]
 * @property {(pcm: Float32Array) => Promise<Float32Array>} [vadProbe]
 * @property {() => Promise<void>} [vadReset]
 * @property {() => void} dispose
 */

export const TARGET_SAMPLE_RATE = 16000;

/** Hard cap on a single uploaded file, 30 minutes of 16 kHz mono. */
export const MAX_AUDIO_SAMPLES = TARGET_SAMPLE_RATE * 30 * 60;

/** Moonshine degrades past 30 s, so utterances are cut before that. */
export const MAX_UTTERANCE_SAMPLES = TARGET_SAMPLE_RATE * 30;
