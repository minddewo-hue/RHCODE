import { normalizeTicker } from '../src/model-smoke.js';
import { test } from 'node:test';

test('normalizeTicker trims and uppercases', () => {
  const result = normalizeTicker('  sh600000 ');
  if (result !== 'SH600000') {
    throw new Error(`Expected 'SH600000' but got '${result}'`);
  }
});
