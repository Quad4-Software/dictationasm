/**
 * Shared transcript text cleanup used by the dictation engines and the UI.
 */

/**
 * Collapse runaway "word word word" loops from stuck greedy decode.
 * @param {string} text
 * @returns {string}
 */
export function collapseRepeatLoops(text) {
  if (!text) {
    return text;
  }
  let out = text;
  out = out.replace(/\b([\w']+)(?:\s+\1){3,}\b/gi, '$1');
  out = out.replace(/\b((?:[\w']+\s+){0,3}[\w']+)(?:\s+\1){2,}\b/gi, '$1');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * @param {Array<{ text: string }>} chunks
 * @returns {string}
 */
export function joinChunkText(chunks) {
  if (!chunks || chunks.length === 0) {
    return '';
  }
  let out = chunks[0].text;
  for (let i = 1; i < chunks.length; i++) {
    out += ' ' + chunks[i].text;
  }
  return out;
}

/**
 * Normalize pipeline or WASM segments into TranscriptResult chunks.
 * @param {Array<{ text?: string, timestamp?: [number|null, number|null] }> | undefined} raw
 * @param {boolean} withTimestamps
 * @returns {import('./types.js').TranscriptResult}
 */
export function sanitizeTranscriptChunks(raw, withTimestamps = true) {
  if (!raw || raw.length === 0) {
    return withTimestamps ? { text: '', chunks: [] } : { text: '' };
  }
  /** @type {Array<{ text: string, timestamp?: [number, number] }>} */
  const chunks = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const text = collapseRepeatLoops(String(c.text || '').trim());
    if (!text) {
      continue;
    }
    if (withTimestamps) {
      const t0 = c.timestamp && c.timestamp[0] != null ? Number(c.timestamp[0]) : 0;
      const t1 = c.timestamp && c.timestamp[1] != null ? Number(c.timestamp[1]) : t0;
      chunks.push({
        text,
        timestamp: [Number.isFinite(t0) ? t0 : 0, Number.isFinite(t1) ? t1 : 0],
      });
    } else {
      chunks.push({ text });
    }
  }
  const text = joinChunkText(chunks);
  if (!withTimestamps) {
    return { text };
  }
  return { text, chunks };
}
