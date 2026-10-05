import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdownSource } from '../src/web/markdown.js';

test('renders inline TeX with dollar and escaped parentheses', () => {
  const dollar = renderMarkdownSource('概率 $p_t^i=\\sigma(x)$ 其中');
  assert.match(dollar, /katex/);
  assert.match(dollar, /p/);
  const paren = renderMarkdownSource('概率 \\(H_t^i\\ge 1-\\epsilon\\) 成立');
  assert.match(paren, /katex/);
});

test('renders bracket and dollar display math inside a sentence', () => {
  const bracket = renderMarkdownSource('最后一步：\\[R_i=1-\\sum_{k=1}^{N_i-1}p_k^i\\] 作为 remainder。');
  assert.match(bracket, /katex/);
  assert.doesNotMatch(bracket, /\\sum/);
  const display = renderMarkdownSource('独立公式：\n\n$$\\tilde h^i=\\sum_{k=1}^{N} p_k^i h_k^i$$\n');
  assert.match(display, /katex-display|math-block/);
});

test('keeps ordinary markdown around math', () => {
  const html = renderMarkdownSource('**ACT** 让每个位置决定迭代：$n_i$。');
  assert.match(html, /<strong>ACT<\/strong>/);
  assert.match(html, /katex/);
});
