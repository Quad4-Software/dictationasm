import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collapseRepeatLoops,
  joinChunkText,
  sanitizeTranscriptChunks,
} from './text-sanitize.js';

test('collapseRepeatLoops collapses foam foam foam', () => {
  const got = collapseRepeatLoops('too full for sound and foam foam foam foam');
  assert.equal(got, 'too full for sound and foam');
});

test('collapseRepeatLoops collapses short phrase loops', () => {
  const got = collapseRepeatLoops('hello world hello world hello world');
  assert.equal(got, 'hello world');
});

test('collapseRepeatLoops leaves normal speech alone', () => {
  const s = 'the rain in Spain falls mainly on the plain';
  assert.equal(collapseRepeatLoops(s), s);
});

test('joinChunkText joins with spaces', () => {
  assert.equal(joinChunkText([{ text: 'a' }, { text: 'b' }]), 'a b');
  assert.equal(joinChunkText([]), '');
});

test('sanitizeTranscriptChunks collapses and keeps timestamps', () => {
  const got = sanitizeTranscriptChunks([
    { text: '  foam foam foam foam  ', timestamp: [0, 1.5] },
    { text: '', timestamp: [1.5, 2] },
    { text: 'ok', timestamp: [2, 3] },
  ]);
  assert.equal(got.text, 'foam ok');
  assert.equal(got.chunks.length, 2);
  assert.deepEqual(got.chunks[0].timestamp, [0, 1.5]);
});

test('sanitizeTranscriptChunks can drop timestamps', () => {
  const got = sanitizeTranscriptChunks([{ text: 'one', timestamp: [0, 1] }], false);
  assert.equal(got.text, 'one');
  assert.equal(got.chunks, undefined);
});
