/**
 * Ambient waveform canvas for the hero visual.
 */

/** @typedef {'idle' | 'recording' | 'transcribing'} WaveMode */

const PALETTE = {
  idle: {
    ink: 'rgba(244, 239, 230, 0.2)',
    accent: 'rgba(232, 168, 56, 0.42)',
    live: 'rgba(255, 210, 120, 0.95)',
    speed: 0.018,
  },
  recording: {
    ink: 'rgba(255, 200, 180, 0.2)',
    accent: 'rgba(255, 107, 74, 0.55)',
    live: 'rgba(255, 160, 130, 0.95)',
    speed: 0.032,
  },
  transcribing: {
    ink: 'rgba(236, 220, 190, 0.22)',
    accent: 'rgba(232, 168, 56, 0.58)',
    live: 'rgba(255, 220, 150, 0.95)',
    speed: 0.028,
  },
};

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createWaveController(canvas) {
  const ctx = canvas.getContext('2d');
  let raf = 0;
  let phase = 0;
  /** @type {Uint8Array | null} */
  let live = null;
  let reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /** @type {WaveMode} */
  let mode = 'idle';

  function resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || canvas.width;
    const height = Math.max(140, Math.round(width * 0.22));
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  /**
   * @param {Uint8Array | null} data
   */
  function setLiveData(data) {
    live = data;
  }

  /**
   * @param {boolean} on
   */
  function setRecording(on) {
    mode = on ? 'recording' : mode === 'recording' ? 'idle' : mode;
    if (!on) {
      live = null;
    }
  }

  /**
   * @param {WaveMode} next
   */
  function setMode(next) {
    mode = next === 'recording' || next === 'transcribing' ? next : 'idle';
    if (mode !== 'recording') {
      live = null;
    }
  }

  function draw() {
    const w = canvas.clientWidth || canvas.width;
    const h = canvas.height / (Math.min(window.devicePixelRatio || 1, 2));
    ctx.clearRect(0, 0, w, h);

    const mid = h * 0.55;
    const colors = PALETTE[mode] || PALETTE.idle;

    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';

    const amp = mode === 'transcribing' ? 1.15 : 1;
    drawCurve(colors.ink, phase, amp, mid, w, h);
    drawCurve(colors.accent, phase * 1.35 + 1.2, amp * 0.72, mid, w, h);

    if (mode === 'recording' && live && live.length > 0) {
      ctx.beginPath();
      ctx.strokeStyle = colors.live;
      ctx.lineWidth = 2;
      const step = Math.max(1, Math.floor(live.length / w));
      for (let x = 0; x < w; x++) {
        const i = Math.min(live.length - 1, x * step);
        const v = (live[i] - 128) / 128;
        const y = mid + v * h * 0.35;
        if (x === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    } else if (mode === 'transcribing') {
      drawCurve(colors.live, phase * 1.8 + 0.4, 1.05, mid, w, h);
    }

    if (!reduced) {
      phase += colors.speed;
      raf = requestAnimationFrame(draw);
    }
  }

  /**
   * @param {string} color
   * @param {number} p
   * @param {number} amp
   * @param {number} mid
   * @param {number} w
   * @param {number} h
   */
  function drawCurve(color, p, amp, mid, w, h) {
    ctx.beginPath();
    ctx.strokeStyle = color;
    for (let x = 0; x <= w; x += 2) {
      const t = x / w;
      const y =
        mid +
        Math.sin(t * Math.PI * 4 + p) * 18 * amp +
        Math.sin(t * Math.PI * 9 + p * 0.7) * 8 * amp +
        Math.sin(t * Math.PI * 2.2 + p * 1.4) * 12 * amp;
      if (x === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  function start() {
    resize();
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      draw();
    }
  }

  function stop() {
    cancelAnimationFrame(raf);
    raf = 0;
  }

  window.addEventListener('resize', () => {
    resize();
    if (reduced && !document.hidden) {
      draw();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    cancelAnimationFrame(raf);
    draw();
  });

  return { start, stop, setLiveData, setRecording, setMode };
}
