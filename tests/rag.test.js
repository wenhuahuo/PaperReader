import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSectionsFromMarkdown,
  cosineSimilarity,
  normalizeVector,
  splitSectionsForEmbedding,
} from '../src/server/rag.js';

test('builds hierarchical Markdown sections and ignores H1', () => {
  const result = buildSectionsFromMarkdown(`
# Paper title
Authors
## 3 Methods
Method overview.
### 3.1 Framework
Framework details.
### 3.2 Training
Training details.
## 4 Results
Results overview.
`);

  assert.deepEqual(result.map(({ title, level }) => ({ title, level })), [
    { title: '3 Methods', level: 2 },
    { title: '3 Methods / 3.1 Framework', level: 3 },
    { title: '3 Methods / 3.2 Training', level: 3 },
    { title: '4 Results', level: 2 },
  ]);
  assert.match(result[0].text, /^## 3 Methods\n\nMethod overview/);
  assert.match(result[1].text, /^## 3 Methods\n### 3.1 Framework/);
  assert.doesNotMatch(result[0].text, /Paper title|Authors/);
});

test('converts Expert HTML tables to Markdown before embedding', () => {
  const result = buildSectionsFromMarkdown(`## 3 Method

Text before.

<table><tr><td></td><td>\\( M{I}_{0,0} \\)</td></tr><tr><td>DTC</td><td>1.00</td></tr></table>

Text after.`);

  assert.equal(result.length, 1);
  assert.match(result[0].text, /M\{I\}_\{0,0\}/);
  assert.match(result[0].text, /\| --- \| --- \|/);
  assert.match(result[0].text, /\| DTC \| 1\.00 \|/);
  assert.match(result[0].text, /Text after\./);
  assert.doesNotMatch(result[0].text, /<table|<td/);
});

test('splits long chapters while preserving the H2/H3 context', () => {
  const paragraphs = Array.from({ length: 80 }, (_, index) => `Paragraph ${index} ${'retrieval context '.repeat(20)}`).join('\n\n');
  const sections = buildSectionsFromMarkdown(`## 3 Methods\n### 3.2 Framework\n${paragraphs}`);
  const chunks = splitSectionsForEmbedding(sections);

  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((chunk) => chunk.text.length <= 4000));
  assert.ok(chunks.every((chunk) => chunk.title === '3 Methods / 3.2 Framework'));
  assert.ok(chunks.every((chunk) => /^## 3 Methods\n### 3.2 Framework/.test(chunk.text)));
});

test('normalizes vectors and computes cosine similarity', () => {
  const left = normalizeVector([3, 4]);
  const right = normalizeVector([4, 3]);
  assert.equal(left[0], 0.6);
  assert.equal(left[1], 0.8);
  assert.equal(cosineSimilarity(left, right), 0.96);
});
