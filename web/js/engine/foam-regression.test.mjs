import test from 'node:test';
import assert from 'node:assert/strict';
import { collapseRepeatLoops } from './text-sanitize.js';

test('foam poem regression string collapses', () => {
  const raw = 'too full for sound and foam, foam foam foam foam foam';
  const got = collapseRepeatLoops(raw);
  assert.match(got, /foam/);
  assert.doesNotMatch(got, /foam foam foam foam/);
});
