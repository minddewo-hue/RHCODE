import test from 'node:test';
import assert from 'node:assert';
import { normalizeTicker } from '../src/model-smoke.js';

test('normalizeTicker trims and uppercases', () => {
  assert.strictEqual(normalizeTicker('  sh600000 '), 'SH600000');
});
