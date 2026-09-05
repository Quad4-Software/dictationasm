import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { resampleLinear, toMono } from './resample.js';
import { GrowablePCM } from './pcm-buffer.js';
import { decodeWavPCM } from './decode.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

test('resample same rate returns same reference', () => {
  const input = new Float32Array([0, 0.5, 1]);
  const out = resampleLinear(input, 16000, 16000);
  assert.equal(out, input);
});

test('resample doubles length for 8k to 16k', () => {
  const input = new Float32Array(8000);
  for (let i = 0; i < input.length; i++) input[i] = i / 8000;
  const out = resampleLinear(input, 8000, 16000);
  assert.equal(out.length, 16000);
  assert.ok(Math.abs(out[0] - input[0]) < 1e-6);
});

test('toMono averages channels without extra copy when mono', () => {
  const input = new Float32Array([1, 2, 3]);
  assert.equal(toMono(input, 1), input);
});

test('GrowablePCM grows and take copies', () => {
  const g = new GrowablePCM(4);
  g.push(new Float32Array([1, 2, 3]));
  g.push(new Float32Array([4, 5]));
  assert.equal(g.length, 5);
  const taken = g.take();
  assert.deepEqual([...taken], [1, 2, 3, 4, 5]);
  assert.equal(g.length, 0);
});

test('GrowablePCM take(n) copies prefix and pushSample works', () => {
  const g = new GrowablePCM(2);
  g.pushSample(1);
  g.pushSample(2);
  g.pushSample(3);
  assert.equal(g.length, 3);
  const part = g.take(2);
  assert.deepEqual([...part], [1, 2]);
  assert.equal(g.length, 0);
});

test('GrowablePCM shift keeps the remainder at the front', () => {
  const g = new GrowablePCM(8);
  g.push(new Float32Array([1, 2, 3, 4, 5]));
  const head = g.shift(2);
  assert.deepEqual([...head], [1, 2]);
  assert.equal(g.length, 3);
  assert.deepEqual([...g.view()], [3, 4, 5]);
  assert.deepEqual([...g.shift(99)], [3, 4, 5]);
  assert.equal(g.length, 0);
});

test('GrowablePCM shrinks oversized buffer after take', () => {
  const g = new GrowablePCM(4);
  const chunk = new Float32Array(64);
  chunk.fill(0.5);
  g.push(chunk);
  assert.ok(g.buf.length > 8);
  g.take();
  assert.equal(g.buf.length, 4);
});

test('decodeWavPCM reads sample jfk wav', () => {
  const bytes = new Uint8Array(readFileSync(join(root, 'web/samples/jfk.wav')));
  const pcm = decodeWavPCM(bytes);
  assert.equal(pcm.length, 176000);
  assert.ok(pcm.some((v) => v !== 0));
});

test('decodeWavPCM reads sample with LIST chunk', () => {
  const bytes = new Uint8Array(readFileSync(join(root, 'web/samples/hello16.wav')));
  const pcm = decodeWavPCM(bytes);
  assert.ok(pcm.length > 1000);
});

test('decodeWavPCM accepts WAVE_FORMAT_EXTENSIBLE PCM', () => {
  const guid = Buffer.from('0100000000001000800000aa00389b71', 'hex');
  const fmt = Buffer.alloc(40);
  fmt.writeUInt16LE(0xfffe, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16000, 4);
  fmt.writeUInt32LE(32000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  fmt.writeUInt16LE(22, 16);
  fmt.writeUInt16LE(16, 18);
  fmt.writeUInt32LE(0, 20);
  guid.copy(fmt, 24);
  const pcmData = Buffer.alloc(320);
  for (let i = 0; i < 160; i++) pcmData.writeInt16LE(i * 20, i * 2);
  const chunks = Buffer.concat([
    Buffer.from('fmt '),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(fmt.length, 0); return b; })(),
    fmt,
    Buffer.from('data'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(pcmData.length, 0); return b; })(),
    pcmData,
  ]);
  const riff = Buffer.concat([
    Buffer.from('RIFF'),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(4 + chunks.length, 0); return b; })(),
    Buffer.from('WAVE'),
    chunks,
  ]);
  const pcm = decodeWavPCM(new Uint8Array(riff));
  assert.equal(pcm.length, 160);
  assert.ok(Math.abs(pcm[10]) > 0);
});
