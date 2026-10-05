export function relevantText(text, question, maxChars = 24000) {
  const paragraphs = String(text ?? '')
    .split(/\n\s*\n/)
    .map((value) => value.trim())
    .filter(Boolean);
  if (paragraphs.join('\n\n').length <= maxChars) return paragraphs.join('\n\n');

  const terms = String(question ?? '').toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const ranked = paragraphs.map((paragraph, index) => {
    const lower = paragraph.toLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 1 : 0), 0);
    return { paragraph, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);

  const selected = [];
  let length = 0;
  for (const item of ranked) {
    if (length + item.paragraph.length + 2 > maxChars) continue;
    selected.push(item);
    length += item.paragraph.length + 2;
  }
  return selected.sort((a, b) => a.index - b.index).map((item) => item.paragraph).join('\n\n');
}
