import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);

export async function extractPdfText(pdfPath, textPath) {
  await execFileAsync('pdftotext', ['-layout', pdfPath, textPath], { maxBuffer: 1024 * 1024 });
  return readFile(textPath, 'utf8');
}
