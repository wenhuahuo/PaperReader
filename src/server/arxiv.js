import { extractArxivId, cleanPaperTitle } from '../shared/paper.js';

const ARXIV_HEADERS = {
  accept: 'application/atom+xml, text/html',
  'user-agent': 'PaperReader/0.1.0',
};

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .trim();
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return decodeXml(match?.[1]);
}

function htmlMetaValues(html, name) {
  const values = [];
  for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = Object.fromEntries(
      [...match[1].matchAll(/([:\w-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
        .map((attribute) => [attribute[1].toLowerCase(), attribute[3]]),
    );
    if (attributes.name?.toLowerCase() === name.toLowerCase()) values.push(decodeXml(attributes.content));
  }
  return values;
}

function metadataFromAbsPage(html, arxivId) {
  const title = cleanPaperTitle(htmlMetaValues(html, 'citation_title')[0]);
  if (!title) throw new Error('arXiv 未返回论文元数据');
  const published = htmlMetaValues(html, 'citation_date')[0] || '';
  const metadataId = htmlMetaValues(html, 'citation_arxiv_id')[0] || arxivId;
  const version = metadataId.match(/(v\d+)$/i)?.[1] ?? 'v1';
  return {
    arxivId,
    title,
    authors: htmlMetaValues(html, 'citation_author'),
    abstract: htmlMetaValues(html, 'citation_abstract')[0] || '',
    year: published.slice(0, 4),
    version,
    sourceUrl: `https://arxiv.org/abs/${arxivId}`,
    pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
  };
}

async function getArxivPaperFromAbsPage(arxivId) {
  const response = await fetch(`https://arxiv.org/abs/${encodeURIComponent(arxivId)}`, {
    headers: { ...ARXIV_HEADERS, accept: 'text/html' },
  });
  if (!response.ok) throw new Error(`arXiv 元数据请求失败：HTTP ${response.status}`);
  return metadataFromAbsPage(await response.text(), arxivId);
}

export async function getArxivPaper(value) {
  const arxivId = extractArxivId(value);
  if (!arxivId) throw new Error('请输入有效的 arXiv abs 或 pdf 链接');

  const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`, {
    headers: ARXIV_HEADERS,
  });
  if (response.status === 429) return getArxivPaperFromAbsPage(arxivId);
  if (!response.ok) throw new Error(`arXiv 元数据请求失败：HTTP ${response.status}`);
  const xml = await response.text();
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/i)?.[1];
  if (!entry) throw new Error('arXiv 未返回论文元数据');

  const title = cleanPaperTitle(tagValue(entry, 'title')) || `arXiv ${arxivId}`;
  const published = tagValue(entry, 'published');
  const versionMatch = xml.match(new RegExp(`arxiv.org/abs/${arxivId.replace('.', '\\.')}(v\\d+)`, 'i'));
  const authors = [...entry.matchAll(/<author>\s*<name>([\s\S]*?)<\/name>/gi)].map((match) => decodeXml(match[1]));
  return {
    arxivId,
    title,
    authors,
    abstract: tagValue(entry, 'summary'),
    year: published.slice(0, 4),
    version: versionMatch?.[1] ?? 'v1',
    sourceUrl: `https://arxiv.org/abs/${arxivId}`,
    pdfUrl: `https://arxiv.org/pdf/${arxivId}.pdf`,
  };
}

export { metadataFromAbsPage };
