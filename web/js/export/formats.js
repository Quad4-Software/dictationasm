/**
 * Transcript export helpers (TXT, SRT, VTT, JSON).
 */

/**
 * @param {import('../engine/types.js').TranscriptResult | null | undefined} result
 * @param {boolean} withTimestamps
 * @returns {string}
 */
export function toTxt(result, withTimestamps) {
  if (!result) {
    return '';
  }
  if (withTimestamps && result.chunks && result.chunks.length) {
    const lines = [];
    for (const c of result.chunks) {
      const text = (c.text || '').trim();
      if (!text) {
        continue;
      }
      const ts = formatRange(c.timestamp);
      lines.push(ts ? `${ts}\n${text}` : text);
    }
    return lines.join('\n\n');
  }
  return (result.text || '').trim();
}

/**
 * @param {import('../engine/types.js').TranscriptResult | null | undefined} result
 * @returns {string}
 */
export function toSrt(result) {
  const cues = cueList(result);
  if (cues.length === 0) {
    return '';
  }
  const parts = [];
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i];
    parts.push(String(i + 1));
    parts.push(`${formatSrtTime(c.t0)} --> ${formatSrtTime(c.t1)}`);
    parts.push(c.text);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * @param {import('../engine/types.js').TranscriptResult | null | undefined} result
 * @returns {string}
 */
export function toVtt(result) {
  const cues = cueList(result);
  const lines = ['WEBVTT', ''];
  for (const c of cues) {
    lines.push(`${formatVttTime(c.t0)} --> ${formatVttTime(c.t1)}`);
    lines.push(c.text);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * @param {import('../engine/types.js').TranscriptResult | null | undefined} result
 * @returns {string}
 */
export function toJson(result) {
  const payload = result || { text: '', chunks: [] };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/**
 * @param {import('../engine/types.js').TranscriptResult | null | undefined} result
 * @returns {Array<{ t0: number, t1: number, text: string }>}
 */
function cueList(result) {
  if (!result || !result.chunks || result.chunks.length === 0) {
    const text = (result && result.text ? result.text : '').trim();
    if (!text) {
      return [];
    }
    return [{ t0: 0, t1: Math.max(1, text.split(/\s+/).length * 0.4), text }];
  }
  /** @type {Array<{ t0: number, t1: number, text: string }>} */
  const out = [];
  for (const c of result.chunks) {
    const text = (c.text || '').trim();
    if (!text) {
      continue;
    }
    const t0 = c.timestamp && c.timestamp[0] != null ? Number(c.timestamp[0]) : 0;
    let t1 = c.timestamp && c.timestamp[1] != null ? Number(c.timestamp[1]) : t0 + 1;
    if (!(t1 > t0)) {
      t1 = t0 + 0.5;
    }
    out.push({ t0, t1, text });
  }
  return out;
}

/**
 * @param {[number|null, number|null] | undefined} ts
 */
function formatRange(ts) {
  if (!ts || ts[0] == null) {
    return '';
  }
  const start = formatPlain(ts[0]);
  const end = ts[1] == null ? '' : formatPlain(ts[1]);
  return end ? `${start}-${end}` : start;
}

/**
 * @param {number} sec
 */
function formatPlain(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(1).padStart(4, '0')}`;
}

/**
 * @param {number} sec
 */
export function formatSrtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${pad3(frac)}`;
}

/**
 * @param {number} sec
 */
export function formatVttTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const frac = ms % 1000;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}.${pad3(frac)}`;
}

/**
 * @param {number} n
 */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * @param {number} n
 */
function pad3(n) {
  return String(n).padStart(3, '0');
}
