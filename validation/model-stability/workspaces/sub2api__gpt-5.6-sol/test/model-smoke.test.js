import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTicker } from '../src/model-smoke.js';

test('normalizeTicker trims and uppercases a ticker', () => {
  assert.equal(normalizeTicker('  sh600000 '), 'SH600000');
});
