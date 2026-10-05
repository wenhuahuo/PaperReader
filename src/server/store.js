import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const rootDirectory = path.resolve(process.env.PAPER_READER_ROOT ?? '.runtime/library');
const indexPath = path.join(rootDirectory, 'index.json');

const initialIndex = {
  folders: [{ id: 'inbox', name: 'Inbox', parentId: null }],
  papers: [],
};

export async function ensureStore() {
  await mkdir(path.join(rootDirectory, 'papers'), { recursive: true });
  await mkdir(path.join(rootDirectory, 'cache', 'translations'), { recursive: true });
  try {
    await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await saveIndex(initialIndex);
  }
}

export async function readIndex() {
  return JSON.parse(await readFile(indexPath, 'utf8'));
}

export async function saveIndex(index) {
  await writeFile(indexPath, JSON.stringify(index, null, 2));
}

export function paperDirectory(paperId) {
  return path.join(rootDirectory, 'papers', paperId);
}

export function paperPdfPath(paperId) {
  return path.join(paperDirectory(paperId), 'original.pdf');
}

export function paperTextPath(paperId) {
  return path.join(paperDirectory(paperId), 'content.txt');
}

export function paperManifestPath(paperId) {
  return path.join(paperDirectory(paperId), 'manifest.json');
}

export function translationCachePath(paperId) {
  return path.join(rootDirectory, 'cache', 'translations', `${paperId}.json`);
}

export function createPaperRecord(input) {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: input.title,
    authors: input.authors ?? [],
    abstract: input.abstract ?? '',
    year: input.year ?? '',
    sourceUrl: input.sourceUrl ?? '',
    arxivId: input.arxivId ?? null,
    version: input.version ?? null,
    folderId: input.folderId || 'inbox',
    fileName: input.fileName,
    importedAt: now,
    lastOpenedAt: now,
    currentPage: 1,
    parseStatus: 'pending',
    parseError: null,
  };
}

export { rootDirectory };
