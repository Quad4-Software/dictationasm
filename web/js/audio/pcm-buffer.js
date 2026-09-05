/**
 * Growable Float32 buffer for mic capture and VAD with rare reallocs.
 */
export class GrowablePCM {
  /**
   * @param {number} [capacity]
   */
  constructor(capacity = 16000 * 8) {
    const cap = Math.max(1, capacity | 0);
    this.buf = new Float32Array(cap);
    this.length = 0;
    this._minCap = cap;
  }

  /**
   * @param {Float32Array} src
   */
  push(src) {
    if (!src || src.length === 0) {
      return;
    }
    this._ensure(this.length + src.length);
    this.buf.set(src, this.length);
    this.length += src.length;
  }

  /**
   * @param {number} sample
   */
  pushSample(sample) {
    this._ensure(this.length + 1);
    this.buf[this.length++] = sample;
  }

  /**
   * @param {number} need
   */
  _ensure(need) {
    if (need <= this.buf.length) {
      return;
    }
    let cap = this.buf.length || 1;
    while (cap < need) {
      cap *= 2;
    }
    const next = new Float32Array(cap);
    if (this.length > 0) {
      next.set(this.buf.subarray(0, this.length));
    }
    this.buf = next;
  }

  /**
   * Returns a view (no copy). Caller must copy if retention is required past reset.
   * @returns {Float32Array}
   */
  view() {
    return this.buf.subarray(0, this.length);
  }

  /**
   * Copy the first n samples (or all) and reset length.
   * Shrinks an oversized backing store so long sessions do not keep peak capacity forever.
   * @param {number} [n]
   * @returns {Float32Array}
   */
  take(n) {
    const count = n == null ? this.length : Math.min(Math.max(0, n | 0), this.length);
    const out = this.buf.slice(0, count);
    this.length = 0;
    if (this.buf.length > this._minCap * 2) {
      this.buf = new Float32Array(this._minCap);
    }
    return out;
  }

  /**
   * Copy the first n samples out and keep the remainder at the front.
   * @param {number} n
   * @returns {Float32Array}
   */
  shift(n) {
    const count = Math.min(Math.max(0, n | 0), this.length);
    const out = this.buf.slice(0, count);
    const rest = this.length - count;
    if (rest > 0) {
      this.buf.copyWithin(0, count, this.length);
    }
    this.length = rest;
    return out;
  }

  reset() {
    this.length = 0;
  }
}
