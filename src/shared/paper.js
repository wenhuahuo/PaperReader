export function extractArxivId(value) {
  const input = String(value ?? '').trim();
  const match = input.match(/(?:arxiv\.org\/(?:abs|pdf)\/|^arXiv:)([a-z-]+\/\d{7}|\d{4}\.\d{4,5})(?:v\d+)?/i);
  return match?.[1] ?? null;
}

export function cleanPaperTitle(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '-')
    .trim()
    .slice(0, 180);
}

export function normalizeText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').trim();
}
