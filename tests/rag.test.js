import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSectionsFromOcr, cosineSimilarity, normalizeVector } from '../src/server/rag.js';

test('builds one index section per OCR subsection and keeps image metadata', () => {
  const result = buildSectionsFromOcr([
    [
      { native_label: 'doc_title', label: 'text', content: 'Paper title' },
      { native_label: 'paragraph_title', label: 'text', content: '1 Introduction' },
      { label: 'text', content: 'Introduction text' },
      { label: 'image', bbox_2d: [1, 2, 30, 40], content: '' },
    ],
    [
      { native_label: 'paragraph_title', label: 'text', content: '2 Method' },
      { label: 'formula', content: '$x$' },
    ],
  ]);

  assert.deepEqual(result.images, [{ page: 1, label: 'image', bbox: [1, 2, 30, 40], content: '' }]);
  assert.deepEqual(result.sections.map(({ title, pageStart, pageEnd }) => ({ title, pageStart, pageEnd })), [
    { title: '未分节内容', pageStart: 1, pageEnd: 1 },
    { title: '1 Introduction', pageStart: 1, pageEnd: 1 },
    { title: '2 Method', pageStart: 2, pageEnd: 2 },
  ]);
  assert.match(result.sections[1].text, /Introduction text/);
  assert.match(result.sections[2].text, /\$x\$/);
});

test('normalizes vectors and computes cosine similarity', () => {
  const left = normalizeVector([3, 4]);
  const right = normalizeVector([4, 3]);
  assert.equal(left[0], 0.6);
  assert.equal(left[1], 0.8);
  assert.equal(cosineSimilarity(left, right), 0.96);
});
