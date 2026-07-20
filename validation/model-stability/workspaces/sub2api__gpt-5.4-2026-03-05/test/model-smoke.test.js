import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeTicker } from '../src/model-smoke.js';

test('normalizeTicker trims whitespace and uppercases the ticker', () => {
  assert.equal(normalizeTicker('  sh600000 '), 'SH600000');
});
