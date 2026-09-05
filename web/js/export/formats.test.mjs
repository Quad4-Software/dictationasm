import test from 'node:test';
import assert from 'node:assert/strict';
import { toTxt, toSrt, toVtt, toJson, formatSrtTime, formatVttTime } from './formats.js';

const sample = {
  text: 'hello world more words',
  chunks: [
    { text: 'hello world', timestamp: [0, 1.5] },
    { text: 'more words', timestamp: [1.5, 3] },
  ],
};

test('toTxt with timestamps', () => {
  const out = toTxt(sample, true);
  assert.match(out, /0:00\.0-0:01\.5/);
  assert.match(out, /hello world/);
});

test('toTxt plain', () => {
  assert.equal(toTxt(sample, false), 'hello world more words');
});

test('toSrt cues', () => {
  const srt = toSrt(sample);
  assert.match(srt, /^1\n/);
  assert.match(srt, /00:00:00,000 --> 00:00:01,500/);
  assert.match(srt, /hello world/);
  assert.match(srt, /2\n/);
});

test('toVtt header', () => {
  const vtt = toVtt(sample);
  assert.match(vtt, /^WEBVTT\n/);
  assert.match(vtt, /00:00:01\.500 --> 00:00:03\.000/);
});

test('toJson roundtrip', () => {
  const parsed = JSON.parse(toJson(sample));
  assert.equal(parsed.chunks.length, 2);
});

test('format times', () => {
  assert.equal(formatSrtTime(3661.5), '01:01:01,500');
  assert.equal(formatVttTime(1.25), '00:00:01.250');
});
