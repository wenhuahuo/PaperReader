import { extractArxivId, cleanPaperTitle } from '../shared/paper.js';

function decodeXml(value) {
  return String(value ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return decodeXml(match?.[1]);
}

export async function getArxivPaper(value) {
  const arxivId = extractArxivId(value);
  if (!arxivId) throw new Error('请输入有效的 arXiv abs 或 pdf 链接');

  const response = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(arxivId)}`);
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
