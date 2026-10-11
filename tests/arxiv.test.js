import test from 'node:test';
import assert from 'node:assert/strict';
import { getArxivPaper } from '../src/server/arxiv.js';

const absPage = `
<meta name="citation_title" content="CANTO: CAD-Native Transformer Operators for AI-Aided Engineering" />
<meta name="citation_author" content="Leibovici, Daniel" />
<meta name="citation_author" content="Kovachki, Nikola Borislavov" />
<meta name="citation_date" content="2026/09/29" />
<meta name="citation_arxiv_id" content="2609.36806" />
<meta name="citation_abstract" content="A &amp; B for CAD." />
`;

test('falls back to arXiv abstract metadata when the API is rate limited', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (calls.length === 1) return new Response('Too Many Requests', { status: 429 });
    return new Response(absPage, { status: 200 });
  };
  try {
    const result = await getArxivPaper('https://arxiv.org/pdf/2609.36806');
    assert.equal(result.arxivId, '2609.36806');
    assert.equal(result.title, 'CANTO: CAD-Native Transformer Operators for AI-Aided Engineering');
    assert.deepEqual(result.authors, ['Leibovici, Daniel', 'Kovachki, Nikola Borislavov']);
    assert.equal(result.abstract, 'A & B for CAD.');
    assert.equal(result.year, '2026');
    assert.equal(calls[0].url, 'https://export.arxiv.org/api/query?id_list=2609.36806');
    assert.equal(calls[1].url, 'https://arxiv.org/abs/2609.36806');
    assert.equal(calls[1].init.headers.accept, 'text/html');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
