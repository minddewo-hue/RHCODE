import { normalizeTicker } from '../src/model-smoke.js';
import { test } from 'node:test';
import assert from 'node:assert';

test('normalizeTicker trims and converts to uppercase', () => {
  assert.strictEqual(normalizeTicker('  sh600000 '), 'SH600000');
});

