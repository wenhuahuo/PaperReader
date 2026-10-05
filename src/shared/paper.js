export function extractArxivId(value) {
  const input = String(value ?? '').trim();
  const match = input.match(/(?:arxiv\.org\/(?:abs|pdf)\/|^arXiv:)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
  return match?.[1] ?? null;
}

const arxivIdPattern = '([a-z-]+(?:\\.[a-z]{2})?\\/\\d{7}|\\d{4}\\.\\d{4,5})(v\\d+)?';

export function findLocalArxivId(fileName, firstPageText) {
  const fromFileName = String(fileName ?? '').match(new RegExp(`^${arxivIdPattern}\\.pdf$`, 'i'));
  const fromText = String(firstPageText ?? '').match(new RegExp(`arXiv:\\s*${arxivIdPattern}`, 'i'));
  const match = fromFileName || fromText;
  return match ? { arxivId: match[1], version: match[2] ?? null } : null;
}

export function cleanPaperTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}
