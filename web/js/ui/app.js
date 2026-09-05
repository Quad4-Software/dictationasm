import { createEngine, registerEngine } from '../engine/registry.js';
import { createMoonshineWebGPUEngine, createMoonshineWasmEngine } from '../engine/moonshine-webgpu.js';
import { createAutoEngine } from '../engine/auto.js';
import { decodeToDictationPCM } from '../audio/decode.js';
import { MicRecorder } from '../audio/mic.js';
import { createEnergyVad, createSileroVad } from '../audio/vad.js';
import { MAX_UTTERANCE_SAMPLES, TARGET_SAMPLE_RATE } from '../engine/types.js';
import { sanitizeTranscriptChunks } from '../engine/text-sanitize.js';
import { toTxt, toSrt, toVtt, toJson } from '../export/formats.js';
import { createWaveController } from './wave.js';
import { cacheModelUrls, getShellVersion, setPWABusy } from '../pwa.js';

registerEngine('moonshine-webgpu', createMoonshineWebGPUEngine);
registerEngine('moonshine-wasm', createMoonshineWasmEngine);
registerEngine('auto', createAutoEngine);

/** Longest utterance handed to Moonshine in one pass. */
const MAX_UTTERANCE_MS = 25000;

/** Slice size used when replaying an uploaded file through the detector. */
const OFFLINE_VAD_SLICE = TARGET_SAMPLE_RATE * 10;

/**
 * Wire the page UI.
 */
export async function bootApp() {
  const els = {
    model: /** @type {HTMLSelectElement} */ (document.getElementById('model')),
    timestamps: /** @type {HTMLInputElement} */ (document.getElementById('timestamps')),
    btnMic: /** @type {HTMLButtonElement} */ (document.getElementById('btn-mic')),
    btnCopy: /** @type {HTMLButtonElement} */ (document.getElementById('btn-copy')),
    btnExport: /** @type {HTMLButtonElement} */ (document.getElementById('btn-export')),
    exportMenu: /** @type {HTMLElement} */ (document.getElementById('export-menu')),
    btnClear: /** @type {HTMLButtonElement} */ (document.getElementById('btn-clear')),
    file: /** @type {HTMLInputElement} */ (document.getElementById('file')),
    status: /** @type {HTMLElement} */ (document.getElementById('status')),
    spinner: /** @type {HTMLElement} */ (document.getElementById('spinner')),
    livePill: /** @type {HTMLElement} */ (document.getElementById('live-pill')),
    progress: /** @type {HTMLElement} */ (document.getElementById('progress')),
    progressTrack: /** @type {HTMLElement} */ (document.querySelector('.progress-track')),
    error: /** @type {HTMLElement} */ (document.getElementById('error')),
    transcript: /** @type {HTMLElement} */ (document.getElementById('transcript')),
    meta: /** @type {HTMLElement} */ (document.getElementById('meta')),
    wave: /** @type {HTMLCanvasElement} */ (document.getElementById('wave')),
    recLabel: /** @type {HTMLElement} */ (document.querySelector('.rec-label')),
    recTimer: /** @type {HTMLElement} */ (document.getElementById('rec-timer')),
    dropOverlay: /** @type {HTMLElement} */ (document.getElementById('drop-overlay')),
    stage: /** @type {HTMLElement} */ (document.querySelector('.stage')),
  };

  const wave = createWaveController(els.wave);
  wave.start();

  /** @type {import('../engine/types.js').ModelInfo[]} */
  let models = [];
  /** @type {import('../engine/types.js').VadInfo | null} */
  let vadInfo = null;
  /** @type {import('../engine/types.js').Engine | null} */
  let engine = null;
  /** @type {string} */
  let loadedModelId = '';
  let vadReady = false;
  /** @type {MicRecorder | null} */
  let mic = null;
  let busy = false;
  let recording = false;
  let micWatch = 0;
  let timerWatch = 0;
  let recordStartedAt = 0;
  /** @type {Promise<void> | null} */
  let warmup = null;
  /** @type {import('../engine/types.js').TranscriptResult | null} */
  let lastResult = null;
  /** @type {Float32Array | null} */
  let lastPCM = null;
  /** @type {AudioContext | null} */
  let playCtx = null;
  /** @type {AudioBufferSourceNode | null} */
  let playSource = null;
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let playWatch = 0;
  /** @type {HTMLElement | null} */
  let activeSeg = null;
  let paintedSegs = 0;
  let dragDepth = 0;

  /** @type {{ push: Function, settle: Function, flush: Function, dispose: Function } | null} */
  let liveVad = null;
  /** @type {Array<{ text: string, timestamp: [number, number] }>} */
  let committed = [];
  /** @type {Array<{ pcm: Float32Array, t0: number, t1: number }>} */
  let commitQueue = [];
  let commitRunning = false;
  /** Utterance the VAD is currently inside. Stale partials are dropped. */
  let openUtterance = 0;
  /** @type {{ pcm: Float32Array, id: number } | null} */
  let pendingPartial = null;
  let partialRunning = false;
  /** @type {HTMLElement | null} */
  let partialEl = null;
  let sessionStart = 0;

  els.transcript.addEventListener('click', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    const btn = target.closest('.seg-time');
    if (!btn || !(btn instanceof HTMLButtonElement) || btn.disabled) {
      return;
    }
    const row = btn.closest('.seg');
    if (!(row instanceof HTMLElement)) {
      return;
    }
    const start = Number(row.dataset.start);
    if (!Number.isFinite(start)) {
      return;
    }
    const endRaw = row.dataset.end;
    const end = endRaw != null && endRaw !== '' ? Number(endRaw) : null;
    void playFrom(start, Number.isFinite(end) ? end : null, row);
  });

  void loadAppVersion();

  setBusy(true, 'Getting ready...');
  try {
    const catalog = await loadCatalog();
    models = catalog.models;
    vadInfo = catalog.vad;
    fillModels(els.model, models);
    clearError();
    setStatus('Warming up...');
    warmup = ensureModel()
      .then(() => {
        setBusy(false, 'Ready when you are.');
        els.status.classList.add('is-ok');
      })
      .catch((err) => {
        setBusy(false, 'Could not finish setup.');
        showError(friendlyError(err));
      });
  } catch (err) {
    setBusy(false, 'Something went wrong.');
    showError(friendlyError(err));
  }

  els.btnMic.addEventListener('click', () => {
    if (recording) {
      void stopMic();
    } else {
      void startMic();
    }
  });
  els.file.addEventListener('change', () => void onFile());
  els.btnCopy.addEventListener('click', () => void copyTranscript());
  els.btnExport.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleExportMenu();
  });
  els.exportMenu.addEventListener('click', (ev) => {
    const btn = /** @type {HTMLElement} */ (ev.target).closest('[data-format]');
    if (!btn) {
      return;
    }
    const format = btn.getAttribute('data-format') || 'txt';
    closeExportMenu();
    exportTranscript(format);
  });
  document.addEventListener('click', () => closeExportMenu());
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      closeExportMenu();
    }
  });
  els.btnClear.addEventListener('click', () => clearTranscript());
  els.model.addEventListener('change', () => {
    loadedModelId = '';
    clearError();
    const model = selectedModel();
    const sizeNote = model && model.optional ? ` (~${model.size_hint_mb} MB)` : '';
    setBusy(true, `Switching voice style${sizeNote}...`);
    warmup = ensureModel()
      .then(() => {
        setBusy(false, 'Ready when you are.');
        els.status.classList.add('is-ok');
      })
      .catch((err) => {
        setBusy(false, 'Could not load that style.');
        showError(friendlyError(err));
      });
  });
  els.timestamps.addEventListener('change', () => {
    paintedSegs = 0;
    if (lastResult) {
      renderTranscript(lastResult, els.timestamps.checked, false);
    }
  });

  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.repeat) {
      return;
    }
    const tag = (ev.target && /** @type {HTMLElement} */ (ev.target).tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON') {
      return;
    }
    ev.preventDefault();
    if (recording) {
      void stopMic();
    } else if (!busy) {
      void startMic();
    }
  });

  wireDragAndDrop();
  window.addEventListener('paste', (ev) => void onPaste(ev));

  /**
   * @returns {import('../engine/types.js').ModelInfo | null}
   */
  function selectedModel() {
    return models.find((m) => m.id === els.model.value) || null;
  }

  async function ensureModel() {
    const model = selectedModel();
    if (!model) {
      throw new Error('Pick a voice style first.');
    }
    if (engine && loadedModelId === model.id) {
      return model;
    }
    if (engine) {
      engine.dispose();
      engine = null;
      vadReady = false;
    }
    engine = createEngine(model.engine);
    setStatus(`Loading ${model.label}...`);
    showProgress(0);
    await engine.load(model, (p) => onLoadProgress(model, p));
    loadedModelId = model.id;
    await ensureVad();
    hideProgress();
    void cacheModelsQuietly(collectCachePaths(model));
    return model;
  }

  /**
   * Silero is optional. Without it the energy detector still commits speech.
   */
  async function ensureVad() {
    vadReady = false;
    if (!engine || !engine.loadVad || !vadInfo) {
      return;
    }
    try {
      setStatus('Setting up voice detection...');
      await engine.loadVad(vadInfo, (p) => {
        if (typeof p.progress === 'number') {
          showProgress(Math.round(p.progress * 100));
        }
      });
      vadReady = true;
    } catch (err) {
      console.warn('Silero VAD unavailable, falling back to energy detection', err);
    }
  }

  /**
   * @param {import('../engine/types.js').ModelInfo} model
   * @param {import('../engine/types.js').ProgressEvent} p
   */
  function onLoadProgress(model, p) {
    if (typeof p.progress === 'number') {
      showProgress(Math.round(p.progress * 100));
    }
    if (p.status === 'loading moonshine' || p.status === 'loading webgpu') {
      setStatus(`Loading ${model.label}...`);
    } else if (p.status === 'warming up' || p.status === 'loading wasm fallback') {
      setStatus('Almost ready...');
    } else if (p.status === 'model ready' || p.status === 'model cached') {
      setStatus(`${model.label} is ready.`);
    }
  }

  /**
   * @param {import('../engine/types.js').ModelInfo} model
   * @returns {string[]}
   */
  function collectCachePaths(model) {
    /** @type {string[]} */
    const paths = [];
    const addModel = (m) => {
      if (!m || !m.path) {
        return;
      }
      paths.push(
        `${m.path}/config.json`,
        `${m.path}/tokenizer.json`,
        `${m.path}/tokenizer_config.json`,
        `${m.path}/preprocessor_config.json`,
        `${m.path}/onnx/encoder_model.onnx`,
        `${m.path}/onnx/decoder_model_merged_q4.onnx`,
      );
    };
    addModel(model);
    for (const m of models) {
      if (!m.optional) {
        addModel(m);
      }
    }
    if (vadInfo && vadInfo.path) {
      paths.push(`${vadInfo.path}/onnx/model.onnx`);
    }
    return paths;
  }

  /**
   * Cache model URLs in the SW asset cache without blocking the UI.
   * @param {string[]} paths
   */
  async function cacheModelsQuietly(paths) {
    const urls = [...new Set(paths.filter(Boolean))];
    if (urls.length === 0) {
      return;
    }
    try {
      await cacheModelUrls(urls);
    } catch {
      /* offline save is best-effort */
    }
  }

  /**
   * @returns {Promise<{ push: Function, settle: Function, flush: Function, dispose: Function }>}
   */
  async function createLiveVad() {
    const hooks = {
      onSpeechStart: handleSpeechStart,
      onPartial: handlePartial,
      onSpeechEnd: handleSpeechEnd,
    };
    if (vadReady && engine && engine.vadProbe) {
      await engine.vadReset?.();
      return createSileroVad({
        ...hooks,
        probeFrames: (block) => /** @type {any} */ (engine).vadProbe(block),
        maxUtteranceMs: MAX_UTTERANCE_MS,
        onError: (err) => console.warn('Voice detection frame failed', err),
      });
    }
    return createEnergyVad({ ...hooks, maxChunkMs: MAX_UTTERANCE_MS });
  }

  /**
   * @param {number} id
   */
  function handleSpeechStart(id) {
    openUtterance = id;
    pendingPartial = null;
    clearPartial();
    if (recording && commitQueue.length === 0) {
      setStatus('Listening...');
    }
  }

  /**
   * Keep only the newest partial. Moonshine runs re-read the whole utterance,
   * so an older snapshot is always redundant.
   * @param {Float32Array} pcm
   * @param {number} _t0
   * @param {number} _t1
   * @param {number} id
   */
  function handlePartial(pcm, _t0, _t1, id) {
    if (!recording || id !== openUtterance) {
      return;
    }
    pendingPartial = { pcm, id };
    void pumpPartials();
  }

  /**
   * @param {Float32Array} pcm
   * @param {number} t0
   * @param {number} t1
   * @param {number} id
   */
  function handleSpeechEnd(pcm, t0, t1, id) {
    if (id === openUtterance) {
      openUtterance = 0;
      pendingPartial = null;
    }
    commitQueue.push({ pcm, t0, t1 });
    if (recording) {
      setStatus(commitQueue.length > 1 ? 'Catching up...' : 'Listening...');
    }
    void pumpCommits();
  }

  async function pumpPartials() {
    if (partialRunning) {
      return;
    }
    partialRunning = true;
    try {
      while (pendingPartial && recording) {
        const job = pendingPartial;
        pendingPartial = null;
        if (job.id !== openUtterance || !engine) {
          continue;
        }
        const result = await engine.dictate(job.pcm, { returnTimestamps: false });
        if (job.id !== openUtterance || !recording) {
          continue;
        }
        showPartial(result.text || '');
      }
    } catch (err) {
      // Partials are a preview. A failure here must not stop the session.
      console.warn('Partial dictation failed', err);
    } finally {
      partialRunning = false;
      if (pendingPartial && recording) {
        void pumpPartials();
      }
    }
  }

  async function pumpCommits() {
    if (commitRunning) {
      return;
    }
    commitRunning = true;
    try {
      while (commitQueue.length > 0) {
        const job = commitQueue.shift();
        if (!job) {
          break;
        }
        await ensureModel();
        if (!engine) {
          throw new Error('Voice engine is not ready.');
        }
        const result = await engine.dictate(job.pcm, { returnTimestamps: false });
        const text = (result.text || '').trim();
        clearPartial();
        if (text) {
          committed.push({ text, timestamp: [job.t0, job.t1] });
          lastResult = sanitizeTranscriptChunks(committed, true);
          renderTranscript(lastResult, els.timestamps.checked, true);
          updateActions(true);
        }
        if (recording && commitQueue.length === 0) {
          setStatus('Listening...');
        }
      }
    } catch (err) {
      showError(friendlyError(err));
    } finally {
      commitRunning = false;
      if (commitQueue.length > 0) {
        void pumpCommits();
      }
    }
  }

  async function drainCommits() {
    while (commitRunning || commitQueue.length > 0) {
      await pumpCommits();
      if (!commitRunning && commitQueue.length === 0) {
        break;
      }
      await sleep(24);
    }
  }

  async function startMic() {
    if (busy || recording) {
      return;
    }
    clearError();
    els.status.classList.remove('is-ok');
    try {
      if (warmup) {
        await warmup;
      }
      await ensureModel();
      recording = true;
      syncPWAWork();
      setRecordingUI(true);
      setControls(true);
      els.btnMic.disabled = false;
      commitQueue = [];
      committed = [];
      commitRunning = false;
      partialRunning = false;
      pendingPartial = null;
      openUtterance = 0;
      lastResult = { text: '', chunks: [] };
      lastPCM = null;
      paintedSegs = 0;
      partialEl = null;
      els.transcript.replaceChildren();
      els.transcript.classList.add('is-live');
      updateActions(false);
      sessionStart = performance.now();
      liveVad = await createLiveVad();
      mic = new MicRecorder();
      await mic.start({
        onFrame: (frame) => {
          liveVad?.push(frame);
        },
      });
      setStatus(listeningHint());
      setLive(true);
      wave.setMode('recording');
      wave.setRecording(true);
      recordStartedAt = Date.now();
      els.recTimer.hidden = false;
      tickTimer();
      timerWatch = window.setInterval(tickTimer, 250);
      micWatch = window.setInterval(() => {
        wave.setLiveData(mic ? mic.getWaveform() : null);
      }, 40);
    } catch (err) {
      recording = false;
      syncPWAWork();
      setRecordingUI(false);
      setControls(false);
      wave.setRecording(false);
      wave.setMode('idle');
      setLive(false);
      els.transcript.classList.remove('is-live');
      setStatus('Could not reach the mic.');
      showError(friendlyError(err));
      cleanupMic();
      liveVad?.dispose();
      liveVad = null;
    }
  }

  async function stopMic() {
    if (!mic || !recording) {
      return;
    }
    busy = true;
    syncPWAWork();
    els.btnMic.disabled = true;
    try {
      setStatus('Wrapping up...');
      setLoading(true);
      const vad = liveVad;
      liveVad = null;
      const pcm = await mic.stop();
      cleanupMic();
      wave.setRecording(false);
      wave.setMode('transcribing');
      if (vad) {
        await vad.flush();
        vad.dispose();
      }
      recording = false;
      setRecordingUI(false);
      clearPartial();
      await drainCommits();
      lastPCM = pcm;
      finalizeSession(pcm.length / TARGET_SAMPLE_RATE);
    } catch (err) {
      setStatus('That recording did not work.');
      showError(friendlyError(err));
    } finally {
      cleanupMic();
      liveVad?.dispose();
      liveVad = null;
      recording = false;
      setRecordingUI(false);
      wave.setRecording(false);
      wave.setMode('idle');
      setControls(false);
      setLoading(false);
      setLive(false);
      busy = false;
      syncPWAWork();
    }
  }

  /**
   * @param {number} seconds
   */
  function finalizeSession(seconds) {
    const ms = Math.round(performance.now() - sessionStart);
    const rtf = seconds > 0 ? ms / 1000 / seconds : 0;
    paintedSegs = 0;
    lastResult = sanitizeTranscriptChunks(committed, true);
    renderTranscript(lastResult, els.timestamps.checked, false);
    els.transcript.classList.remove('is-live');
    hideProgress();
    els.meta.hidden = false;
    els.meta.textContent = `${seconds.toFixed(1)}s audio in ${(ms / 1000).toFixed(1)}s (${rtf.toFixed(2)}x) using ${formatModelMeta(selectedModel())}`;
    setStatus('Done. Still just on this device.');
    els.status.classList.add('is-ok');
    updateActions(!!(lastResult && lastResult.text));
  }

  /**
   * @param {import('../engine/types.js').ModelInfo | null | undefined} model
   */
  function formatModelMeta(model) {
    const parts = [model?.label || 'model'];
    const backend = engine && typeof engine.getBackend === 'function' ? engine.getBackend() : '';
    if (backend) {
      parts.push(backend);
    }
    parts.push(vadReady ? 'Silero VAD' : 'energy VAD');
    return parts.join(' \u00b7 ');
  }

  async function onFile() {
    const file = els.file.files && els.file.files[0];
    els.file.value = '';
    if (!file) {
      return;
    }
    await ingestFile(file);
  }

  /**
   * @param {File} file
   */
  async function ingestFile(file) {
    if (!file || busy || recording) {
      return;
    }
    if (!isAllowedMediaFile(file)) {
      showError('Choose an audio or video file.');
      setStatus('That file type is not supported.');
      return;
    }
    busy = true;
    syncPWAWork();
    clearError();
    els.status.classList.remove('is-ok');
    setControls(true);
    setLoading(true);
    try {
      if (warmup) {
        await warmup;
      }
      setStatus(`Opening ${file.name}...`);
      const pcm = await decodeToDictationPCM(file);
      wave.setMode('transcribing');
      await runFileDictation(pcm);
    } catch (err) {
      setStatus('Could not read that file.');
      showError(friendlyError(err));
    } finally {
      wave.setMode('idle');
      setControls(false);
      setLoading(false);
      setLive(false);
      busy = false;
      syncPWAWork();
    }
  }

  /**
   * Segment an uploaded clip the same way live speech is segmented, then
   * dictate one utterance at a time so text lands progressively.
   * @param {Float32Array} pcm
   */
  async function runFileDictation(pcm) {
    if (!pcm || pcm.length === 0) {
      setStatus('No sound found.');
      showError('Try again with a clearer recording or another file.');
      return;
    }
    await ensureModel();
    if (!engine) {
      throw new Error('Voice engine is not ready.');
    }
    const seconds = pcm.length / TARGET_SAMPLE_RATE;
    const started = performance.now();
    sessionStart = started;
    lastPCM = pcm;
    stopPlayback();
    wave.setLiveData(null);
    wave.setRecording(false);
    committed = [];
    paintedSegs = 0;
    partialEl = null;
    els.transcript.replaceChildren();
    els.transcript.classList.add('is-live');
    setLive(true);
    setStatus('Finding speech...');
    showProgress(4);

    const segments = await segmentPCM(pcm);
    setStatus('Transcribing...');
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const result = await engine.dictate(seg.pcm, { returnTimestamps: false });
      const text = (result.text || '').trim();
      if (text) {
        committed.push({ text, timestamp: [seg.t0, seg.t1] });
        lastResult = sanitizeTranscriptChunks(committed, true);
        renderTranscript(lastResult, els.timestamps.checked, true);
        updateActions(true);
      }
      showProgress(Math.max(8, Math.round(((i + 1) / segments.length) * 100)));
    }

    setLive(false);
    finalizeSession(seconds);
  }

  /**
   * @param {Float32Array} pcm
   * @returns {Promise<Array<{ pcm: Float32Array, t0: number, t1: number }>>}
   */
  async function segmentPCM(pcm) {
    /** @type {Array<{ pcm: Float32Array, t0: number, t1: number }>} */
    const out = [];
    if (vadReady && engine && engine.vadProbe) {
      try {
        await engine.vadReset?.();
        const vad = createSileroVad({
          probeFrames: (block) => /** @type {any} */ (engine).vadProbe(block),
          minSilenceMs: 500,
          maxUtteranceMs: MAX_UTTERANCE_MS,
          onSpeechEnd: (seg, t0, t1) => out.push({ pcm: seg, t0, t1 }),
          onError: (err) => console.warn('Voice detection frame failed', err),
        });
        for (let off = 0; off < pcm.length; off += OFFLINE_VAD_SLICE) {
          vad.push(pcm.subarray(off, Math.min(pcm.length, off + OFFLINE_VAD_SLICE)));
          await vad.settle();
          showProgress(Math.max(4, Math.round((off / pcm.length) * 40)));
        }
        await vad.flush();
        vad.dispose();
        await engine.vadReset?.();
      } catch (err) {
        console.warn('Voice detection segmentation failed', err);
      }
    }
    if (out.length > 0) {
      return out;
    }
    return fixedWindows(pcm);
  }

  function wireDragAndDrop() {
    const onDragEnter = (ev) => {
      if (!hasFiles(ev)) {
        return;
      }
      ev.preventDefault();
      dragDepth += 1;
      els.dropOverlay.hidden = false;
      els.dropOverlay.classList.add('is-on');
    };
    const onDragLeave = (ev) => {
      if (!hasFiles(ev)) {
        return;
      }
      ev.preventDefault();
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        els.dropOverlay.hidden = true;
        els.dropOverlay.classList.remove('is-on');
      }
    };
    const onDragOver = (ev) => {
      if (!hasFiles(ev)) {
        return;
      }
      ev.preventDefault();
      if (ev.dataTransfer) {
        ev.dataTransfer.dropEffect = 'copy';
      }
    };
    const onDrop = (ev) => {
      if (!hasFiles(ev)) {
        return;
      }
      ev.preventDefault();
      dragDepth = 0;
      els.dropOverlay.hidden = true;
      els.dropOverlay.classList.remove('is-on');
      if (busy || recording) {
        showError('Finish the current job before dropping another file.');
        return;
      }
      const file = pickMediaFile(ev.dataTransfer?.files);
      if (!file) {
        showError('Drop an audio or video file.');
        return;
      }
      void ingestFile(file);
    };
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
  }

  /**
   * @param {ClipboardEvent} ev
   */
  async function onPaste(ev) {
    if (busy || recording) {
      return;
    }
    const tag = (ev.target && /** @type {HTMLElement} */ (ev.target).tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      return;
    }
    const file = fileFromClipboard(ev.clipboardData);
    if (!file) {
      return;
    }
    ev.preventDefault();
    await ingestFile(file);
  }

  function cleanupMic() {
    window.clearInterval(micWatch);
    window.clearInterval(timerWatch);
    wave.setLiveData(null);
    if (mic) {
      mic.cleanup();
      mic = null;
    }
    els.recTimer.hidden = true;
    els.recTimer.textContent = '0:00';
  }

  function tickTimer() {
    const sec = Math.max(0, Math.floor((Date.now() - recordStartedAt) / 1000));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    els.recTimer.textContent = `${m}:${s}`;
  }

  /**
   * @param {boolean} on
   */
  function setRecordingUI(on) {
    els.btnMic.classList.toggle('is-recording', on);
    els.btnMic.setAttribute('aria-pressed', on ? 'true' : 'false');
    els.recLabel.textContent = on ? 'Stop' : 'Record';
    els.btnMic.disabled = false;
  }

  /**
   * @param {boolean} locked
   */
  function setControls(locked) {
    els.btnMic.disabled = locked;
    els.file.disabled = locked;
    els.model.disabled = locked;
    els.timestamps.disabled = locked;
  }

  function syncPWAWork() {
    setPWABusy(busy || recording);
  }

  /**
   * @param {boolean} on
   * @param {string} [msg]
   */
  function setBusy(on, msg) {
    busy = on;
    setControls(on);
    setLoading(on);
    if (msg) {
      setStatus(msg);
    }
    syncPWAWork();
  }

  /**
   * @param {boolean} on
   */
  function setLoading(on) {
    els.spinner.hidden = !on;
  }

  /**
   * @param {boolean} on
   */
  function setLive(on) {
    els.livePill.classList.toggle('is-on', on);
  }

  /**
   * @param {string} text
   */
  function setStatus(text) {
    els.status.textContent = text;
  }

  function listeningHint() {
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    return coarse
      ? 'Listening... tap Stop when done'
      : 'Listening... press Space or Stop when done';
  }

  /**
   * @param {number} pct
   */
  function showProgress(pct) {
    els.progressTrack.hidden = false;
    els.progress.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }

  function hideProgress() {
    els.progressTrack.hidden = true;
    els.progress.style.width = '0%';
  }

  /**
   * @param {string} msg
   */
  function showError(msg) {
    els.error.hidden = false;
    els.error.textContent = msg;
  }

  function clearError() {
    els.error.hidden = true;
    els.error.textContent = '';
  }

  /**
   * @param {boolean} hasText
   */
  function updateActions(hasText) {
    els.btnCopy.disabled = !hasText;
    els.btnExport.disabled = !hasText;
    els.btnClear.disabled = !hasText;
  }

  function toggleExportMenu() {
    if (els.btnExport.disabled) {
      return;
    }
    const open = !els.exportMenu.classList.contains('is-open');
    els.exportMenu.classList.toggle('is-open', open);
    els.exportMenu.hidden = !open;
    els.btnExport.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function closeExportMenu() {
    els.exportMenu.classList.remove('is-open');
    els.exportMenu.hidden = true;
    els.btnExport.setAttribute('aria-expanded', 'false');
  }

  /**
   * Live preview of the utterance still being spoken. Never part of exports.
   * @param {string} text
   */
  function showPartial(text) {
    const clean = (text || '').trim();
    if (!clean) {
      clearPartial();
      return;
    }
    if (!partialEl || !partialEl.isConnected) {
      partialEl = document.createElement('div');
      partialEl.className = 'seg seg-partial';
      const span = document.createElement('span');
      span.className = 'seg-text';
      partialEl.appendChild(span);
      els.transcript.appendChild(partialEl);
    }
    const span = partialEl.firstElementChild;
    if (span) {
      span.textContent = clean;
    }
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  function clearPartial() {
    if (partialEl && partialEl.isConnected) {
      partialEl.remove();
    }
    partialEl = null;
  }

  /**
   * @param {import('../engine/types.js').TranscriptResult} result
   * @param {boolean} withTimestamps
   * @param {boolean} [appendOnly]
   */
  function renderTranscript(result, withTimestamps, appendOnly = false) {
    clearPartial();
    if (withTimestamps && result.chunks && result.chunks.length) {
      const chunks = result.chunks;
      if (!appendOnly || paintedSegs === 0 || paintedSegs > chunks.length) {
        els.transcript.replaceChildren();
        paintedSegs = 0;
      }
      if (paintedSegs >= chunks.length) {
        return;
      }
      const frag = document.createDocumentFragment();
      const canPlay = !!lastPCM;
      for (let i = paintedSegs; i < chunks.length; i++) {
        const c = chunks[i];
        const row = document.createElement('div');
        row.className = 'seg';
        const start = c.timestamp && c.timestamp[0] != null ? Number(c.timestamp[0]) : null;
        const end = c.timestamp && c.timestamp[1] != null ? Number(c.timestamp[1]) : null;
        if (start != null) {
          row.dataset.start = String(start);
          if (end != null) {
            row.dataset.end = String(end);
          }
        }
        const ts = formatTimestamp(c.timestamp);
        if (ts) {
          const time = document.createElement('button');
          time.type = 'button';
          time.className = 'seg-time';
          time.textContent = ts;
          time.title = start != null ? `Play from ${formatTime(start)}` : '';
          time.setAttribute('aria-label', start != null ? `Play from ${formatTime(start)}` : 'Timestamp');
          time.disabled = start == null || !canPlay;
          row.appendChild(time);
        }
        const text = document.createElement('span');
        text.className = 'seg-text';
        text.textContent = (c.text || '').trim();
        row.appendChild(text);
        frag.appendChild(row);
      }
      els.transcript.appendChild(frag);
      paintedSegs = chunks.length;
      els.transcript.scrollTop = els.transcript.scrollHeight;
      return;
    }
    paintedSegs = 0;
    els.transcript.textContent = (result.text || '').trim();
  }

  /**
   * @param {number} startSec
   * @param {number | null} [endSec]
   * @param {HTMLElement} [segEl]
   */
  async function playFrom(startSec, endSec, segEl) {
    if (!lastPCM || lastPCM.length === 0) {
      return;
    }
    stopPlayback();
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AC) {
      showError('Playback is not available in this browser.');
      return;
    }
    if (!playCtx) {
      playCtx = new AC();
    }
    if (playCtx.state === 'suspended') {
      await playCtx.resume();
    }

    const startSample = Math.max(0, Math.min(lastPCM.length - 1, Math.floor(startSec * TARGET_SAMPLE_RATE)));
    let endSample = lastPCM.length;
    if (typeof endSec === 'number' && Number.isFinite(endSec) && endSec > startSec) {
      endSample = Math.max(startSample + 1, Math.min(lastPCM.length, Math.ceil(endSec * TARGET_SAMPLE_RATE)));
    }
    const slice = lastPCM.subarray(startSample, endSample);
    if (!slice.length) {
      return;
    }

    const buf = playCtx.createBuffer(1, slice.length, TARGET_SAMPLE_RATE);
    buf.copyToChannel(slice, 0);

    const src = playCtx.createBufferSource();
    src.buffer = buf;
    src.connect(playCtx.destination);
    playSource = src;

    if (segEl) {
      activeSeg = segEl;
      segEl.classList.add('is-active');
      segEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    const durationMs = (slice.length / TARGET_SAMPLE_RATE) * 1000;
    src.onended = () => {
      if (playSource === src) {
        clearActiveSeg();
        playSource = null;
      }
    };
    src.start();
    playWatch = window.setTimeout(() => {
      if (playSource === src) {
        clearActiveSeg();
      }
    }, durationMs + 40);
    setStatus(`Playing from ${formatTime(startSec)}`);
  }

  function stopPlayback() {
    window.clearTimeout(playWatch);
    playWatch = 0;
    if (playSource) {
      try {
        playSource.stop();
      } catch {
        /* already stopped */
      }
      playSource.disconnect();
      playSource = null;
    }
    clearActiveSeg();
  }

  function clearActiveSeg() {
    if (activeSeg) {
      activeSeg.classList.remove('is-active');
      activeSeg = null;
    }
  }

  function transcriptPlain() {
    return toTxt(lastResult, els.timestamps.checked) || (els.transcript.innerText || '').trim();
  }

  async function copyTranscript() {
    const text = transcriptPlain();
    if (!text) {
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Copied.');
      els.status.classList.add('is-ok');
    } catch {
      showError('Could not copy. Select the text and copy it yourself.');
    }
  }

  /**
   * @param {string} format
   */
  function exportTranscript(format) {
    if (!lastResult) {
      return;
    }
    let body = '';
    let mime = 'text/plain;charset=utf-8';
    let ext = 'txt';
    if (format === 'srt') {
      body = toSrt(lastResult);
      mime = 'application/x-subrip;charset=utf-8';
      ext = 'srt';
    } else if (format === 'vtt') {
      body = toVtt(lastResult);
      mime = 'text/vtt;charset=utf-8';
      ext = 'vtt';
    } else if (format === 'json') {
      body = toJson(lastResult);
      mime = 'application/json;charset=utf-8';
      ext = 'json';
    } else {
      body = toTxt(lastResult, els.timestamps.checked);
      if (body && !body.endsWith('\n')) {
        body += '\n';
      }
    }
    if (!body) {
      return;
    }
    const blob = new Blob([body], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dictationasm-${Date.now()}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${ext.toUpperCase()}.`);
    els.status.classList.add('is-ok');
  }

  function clearTranscript() {
    stopPlayback();
    clearPartial();
    lastResult = null;
    lastPCM = null;
    paintedSegs = 0;
    committed = [];
    els.transcript.replaceChildren();
    els.transcript.classList.remove('is-live');
    els.meta.hidden = true;
    els.meta.textContent = '';
    updateActions(false);
    setStatus('Cleared. Ready when you are.');
    els.status.classList.add('is-ok');
  }
}

/**
 * Split audio into Moonshine-sized windows when no speech was detected.
 * @param {Float32Array} pcm
 * @returns {Array<{ pcm: Float32Array, t0: number, t1: number }>}
 */
function fixedWindows(pcm) {
  const size = Math.min(MAX_UTTERANCE_SAMPLES, Math.round((MAX_UTTERANCE_MS / 1000) * TARGET_SAMPLE_RATE));
  /** @type {Array<{ pcm: Float32Array, t0: number, t1: number }>} */
  const out = [];
  for (let off = 0; off < pcm.length; off += size) {
    const end = Math.min(pcm.length, off + size);
    out.push({
      pcm: pcm.slice(off, end),
      t0: off / TARGET_SAMPLE_RATE,
      t1: end / TARGET_SAMPLE_RATE,
    });
  }
  return out;
}

/**
 * @param {number} ms
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {DragEvent} ev
 */
function hasFiles(ev) {
  const types = ev.dataTransfer && ev.dataTransfer.types;
  if (!types) {
    return false;
  }
  return Array.from(types).includes('Files');
}

/**
 * @param {FileList | null | undefined} files
 * @returns {File | null}
 */
function pickMediaFile(files) {
  if (!files || files.length === 0) {
    return null;
  }
  for (let i = 0; i < files.length; i++) {
    if (isAllowedMediaFile(files[i])) {
      return files[i];
    }
  }
  return null;
}

/**
 * @param {DataTransfer | null} data
 * @returns {File | null}
 */
function fileFromClipboard(data) {
  if (!data) {
    return null;
  }
  const fromFiles = pickMediaFile(data.files);
  if (fromFiles) {
    return fromFiles;
  }
  for (const item of Array.from(data.items || [])) {
    if (item.kind !== 'file') {
      continue;
    }
    const file = item.getAsFile();
    if (file && isAllowedMediaFile(file)) {
      return file;
    }
  }
  return null;
}

/**
 * @param {HTMLSelectElement} select
 * @param {import('../engine/types.js').ModelInfo[]} models
 */
function fillModels(select, models) {
  select.innerHTML = '';
  const core = models.filter((m) => !m.optional);
  const optional = models.filter((m) => m.optional);
  appendModelOptions(select, core);
  if (optional.length) {
    const group = document.createElement('optgroup');
    group.label = 'More styles';
    appendModelOptions(group, optional);
    select.appendChild(group);
  }
}

/**
 * @param {HTMLSelectElement | HTMLOptGroupElement} parent
 * @param {import('../engine/types.js').ModelInfo[]} models
 */
function appendModelOptions(parent, models) {
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.optional ? `${m.label} (~${m.size_hint_mb} MB)` : m.label;
    if (m.default) {
      opt.selected = true;
    }
    parent.appendChild(opt);
  }
}

/**
 * Show build version from the Go API when available.
 * @returns {Promise<void>}
 */
async function loadAppVersion() {
  const el = document.getElementById('app-version');
  if (!(el instanceof HTMLElement)) {
    return;
  }
  try {
    const data = await fetchJSON('/api/version');
    const ver = data && typeof data.version === 'string' ? data.version.trim() : '';
    if (ver) {
      el.textContent = `v${ver}`;
      el.hidden = false;
      return;
    }
  } catch {
    /* try shell version below */
  }
  try {
    const shell = await getShellVersion();
    if (!shell || shell === 'dev') {
      return;
    }
    el.textContent = `v${shell}`;
    el.hidden = false;
  } catch {
    /* Static hosts without a SW version omit the label. */
  }
}

/**
 * Prefer the static catalog for Pages, then the Go API.
 * @returns {Promise<{ models: import('../engine/types.js').ModelInfo[], vad: import('../engine/types.js').VadInfo | null }>}
 */
async function loadCatalog() {
  const urls = ['/models.json', '/api/models'];
  let lastErr = /** @type {unknown} */ (null);
  for (const url of urls) {
    try {
      const catalog = await fetchJSON(url);
      const list = catalog && Array.isArray(catalog.models) ? catalog.models : [];
      if (list.length > 0) {
        return { models: list, vad: catalog.vad || null };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not load voice styles.');
}

const MEDIA_EXTENSIONS = new Set([
  '.wav', '.wave', '.mp3', '.ogg', '.oga', '.opus', '.flac', '.m4a', '.aac',
  '.webm', '.mp4', '.m4v', '.mkv', '.mov', '.avi', '.mpeg', '.mpg', '.3gp',
]);

/**
 * @param {File} file
 */
function isAllowedMediaFile(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    return true;
  }
  if (
    mime === '' ||
    mime === 'application/octet-stream' ||
    mime === 'binary/octet-stream'
  ) {
    const name = file.name || '';
    const dot = name.lastIndexOf('.');
    if (dot >= 0 && MEDIA_EXTENSIONS.has(name.slice(dot).toLowerCase())) {
      return true;
    }
  }
  const name = file.name || '';
  const dot = name.lastIndexOf('.');
  if (dot < 0) {
    return false;
  }
  return MEDIA_EXTENSIONS.has(name.slice(dot).toLowerCase());
}

/**
 * @param {string} url
 */
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Could not reach the app.');
  }
  return res.json();
}

/**
 * @param {unknown} err
 */
function friendlyError(err) {
  const msg = err && typeof err === 'object' && 'message' in err
    ? String(/** @type {{ message: string }} */ (err).message)
    : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes('permission') || lower.includes('notallowed') || lower.includes('denied')) {
    return 'Microphone access was blocked. Allow it in your browser settings, then try again.';
  }
  if (lower.includes('decode') || lower.includes('wav') || lower.includes('media') || lower.includes('encoding')) {
    return 'That audio could not be decoded. Try a standard WAV, MP3, M4A, or WebM file.';
  }
  if (lower.includes('refresh') || lower.includes('isolated') || lower.includes('cross-origin')) {
    return 'This browser tab needs a refresh to enable local voice processing.';
  }
  if (lower.includes('memory') || lower.includes('init') || lower.includes('start the voice')) {
    return 'This device ran out of room for the voice model. Close other tabs and retry with Quick.';
  }
  if (lower.includes('too long') || lower.includes('timed out')) {
    return 'That took too long. Try a shorter clip or the Quick voice style.';
  }
  return msg || 'Something unexpected happened.';
}

/**
 * @param {[number|null, number|null] | undefined} ts
 */
function formatTimestamp(ts) {
  if (!ts || ts[0] == null) {
    return '';
  }
  const start = formatTime(ts[0]);
  const end = ts[1] == null ? '' : formatTime(ts[1]);
  return end ? `${start}-${end}` : start;
}

/**
 * @param {number} sec
 */
function formatTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}
