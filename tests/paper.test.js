import test from 'node:test';
import assert from 'node:assert/strict';
import { extractArxivId, cleanPaperTitle } from '../src/shared/paper.js';

test('extracts arXiv identifiers from abs, pdf, and arXiv forms', () => {
  assert.equal(extractArxivId('https://arxiv.org/abs/2401.12345'), '2401.12345');
  assert.equal(extractArxivId('https://arxiv.org/pdf/2401.12345v2.pdf'), '2401.12345');
  assert.equal(extractArxivId('arXiv:cs/0701001'), 'cs/0701001');
  assert.equal(extractArxivId('not an arxiv link'), null);
});

test('cleans a paper title for local metadata', () => {
  assert.equal(cleanPaperTitle('  A  /  Study: Test?  '), 'A - Study- Test-');
});
