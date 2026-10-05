import { marked } from 'marked';
import katex from 'katex';

function toKatex(tex, displayMode) {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    output: 'html',
  });
}

function firstIndex(src, markers) {
  let found = -1;
  for (const marker of markers) {
    const index = src.indexOf(marker);
    if (index !== -1 && (found === -1 || index < found)) found = index;
  }
  return found === -1 ? undefined : found;
}

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    return firstIndex(src, ['$$', '\\[', '\\begin{equation}', '\\begin{align}', '\\begin{align*}']);
  },
  tokenizer(src) {
    const dollar = /^\$\$([\s\S]+?)\$\$(?:\n|$)/.exec(src);
    if (dollar) return { type: 'blockMath', raw: dollar[0], tex: dollar[1].trim() };
    const bracket = /^\\\[([\s\S]+?)\\\](?:\n|$)/.exec(src);
    if (bracket) return { type: 'blockMath', raw: bracket[0], tex: bracket[1].trim() };
    const environment = /^\\begin\{(equation\*?|align\*?)\}([\s\S]+?)\\end\{\1\}(?:\n|$)/.exec(src);
    if (environment) {
      return { type: 'blockMath', raw: environment[0], tex: `\\begin{${environment[1]}}${environment[2]}\\end{${environment[1]}}` };
    }
  },
  renderer(token) {
    return `<p class="math-block">${toKatex(token.tex, true)}</p>\n`;
  },
};

const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    return firstIndex(src, ['$$', '$', '\\(', '\\[']);
  },
  tokenizer(src) {
    const displayDollar = /^\$\$([\s\S]+?)\$\$/.exec(src);
    if (displayDollar) return { type: 'inlineMath', raw: displayDollar[0], tex: displayDollar[1].trim(), display: true };
    if (src.startsWith('$$')) return;
    const dollar = /^\$([^$\n]+?)\$/.exec(src);
    if (dollar) return { type: 'inlineMath', raw: dollar[0], tex: dollar[1].trim(), display: false };
    const paren = /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (paren) return { type: 'inlineMath', raw: paren[0], tex: paren[1].trim(), display: false };
    const bracket = /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (bracket) return { type: 'inlineMath', raw: bracket[0], tex: bracket[1].trim(), display: true };
  },
  renderer(token) {
    return toKatex(token.tex, token.display);
  },
};

marked.use({ extensions: [blockMath, inlineMath] });

export function renderMarkdownSource(text) {
  return marked.parse(text ?? '');
}
