import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cleanPaperTitle, normalizeText } from '../shared/paper.js';
import {
  ensureStore,
  readIndex,
  saveIndex,
  paperDirectory,
  paperPdfPath,
  translationCachePath,
  createPaperRecord,
} from './store.js';
import { getArxivPaper } from './arxiv.js';
import { translateText } from './model.js';
import { getAppSettings, publicSettings, saveAppSettings, writePromptTemplates } from './settings.js';
import { runPaperAgent } from './pi.js';

const projectRoot = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
const staticRoot = path.join(projectRoot, 'dist');
const port = Number(process.env.PORT || 3080);
const bodyLimit = 80 * 1024 * 1024;

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mjs': 'text/javascript; charset=utf-8',
};

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendError(res, error) {
  const status = error.statusCode || 400;
  sendJson(res, status, { error: error.message });
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > bodyLimit) {
      const error = new Error('请求内容超过大小限制');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function paperResponse(paper) {
  return {
    ...paper,
    pdfUrl: `/api/papers/${paper.id}/pdf`,
  };
}

async function updatePaper(paperId, updater) {
  const index = await readIndex();
  const paper = index.papers.find((item) => item.id === paperId);
  if (!paper) throw notFound('论文不存在');
  updater(paper, index);
  await saveIndex(index);
  return paper;
}

function notFound(message) {
  const error = new Error(message);
  error.statusCode = 404;
  return error;
}

async function importPdf({ pdfBuffer, metadata }) {
  const paper = createPaperRecord(metadata);
  await mkdir(paperDirectory(paper.id), { recursive: true });
  await writeFile(paperPdfPath(paper.id), pdfBuffer);
  const index = await readIndex();
  index.papers.unshift(paper);
  await saveIndex(index);
  return paper;
}

async function importLocalPdf(body) {
  const match = String(body.data ?? '').match(/^data:application\/pdf;base64,(.+)$/s);
  if (!match) throw new Error('上传内容必须是 PDF data URL');
  const fileName = String(body.fileName || 'paper.pdf').replace(/[/\\]/g, '-');
  const title = cleanPaperTitle(fileName.replace(/\.pdf$/i, '')) || '未命名论文';
  return importPdf({
    pdfBuffer: Buffer.from(match[1], 'base64'),
    metadata: { title, fileName, folderId: body.folderId },
  });
}

async function importArxivPdf(body) {
  const metadata = await getArxivPaper(body.url);
  const response = await fetch(metadata.pdfUrl);
  if (!response.ok) throw new Error(`arXiv PDF 下载失败：HTTP ${response.status}`);
  return importPdf({
    pdfBuffer: Buffer.from(await response.arrayBuffer()),
    metadata: { ...metadata, fileName: `${metadata.arxivId}.pdf`, folderId: body.folderId },
  });
}

async function readTranslations(paperId) {
  try {
    return JSON.parse(await readFile(translationCachePath(paperId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function cachedTranslation(paperId, input) {
  const translations = await readTranslations(paperId);
  const hit = translations.find((item) => (
    item.sourceText === input.text
    && item.sourceLanguage === input.sourceLanguage
    && item.targetLanguage === input.targetLanguage
  ));
  if (hit) return { ...hit, cached: true };
  const result = await translateText(input);
  const next = {
    sourceText: input.text,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    result,
    translatedAt: new Date().toISOString(),
  };
  translations.push(next);
  await writeFile(translationCachePath(paperId), JSON.stringify(translations, null, 2));
  return { ...next, cached: false };
}

async function handleApi(req, res, url) {
  const segments = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/settings') {
    sendJson(res, 200, publicSettings(await getAppSettings()));
    return;
  }
  if (req.method === 'PUT' && url.pathname === '/api/settings') {
    const settings = await saveAppSettings(await readJsonBody(req));
    await writePromptTemplates(settings);
    sendJson(res, 200, publicSettings(settings));
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/library') {
    const index = await readIndex();
    sendJson(res, 200, { folders: index.folders, papers: index.papers.map(paperResponse) });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/folders') {
    const body = await readJsonBody(req);
    const name = normalizeText(body.name);
    if (!name) throw new Error('文件夹名称不能为空');
    const index = await readIndex();
    const parentId = body.parentId || null;
    if (parentId && !index.folders.some((folder) => folder.id === parentId)) throw notFound('父文件夹不存在');
    const folder = { id: cryptoRandomId(), name, parentId };
    index.folders.push(folder);
    await saveIndex(index);
    sendJson(res, 201, folder);
    return;
  }
  if (req.method === 'PATCH' && segments[1] === 'folders' && segments[2]) {
    const body = await readJsonBody(req);
    const name = normalizeText(body.name);
    if (!name) throw new Error('文件夹名称不能为空');
    const index = await readIndex();
    const folder = index.folders.find((item) => item.id === segments[2]);
    if (!folder) throw notFound('文件夹不存在');
    folder.name = name;
    await saveIndex(index);
    sendJson(res, 200, folder);
    return;
  }
  if (req.method === 'DELETE' && segments[1] === 'folders' && segments[2]) {
    const folderId = segments[2];
    if (folderId === 'inbox') throw new Error('Inbox 文件夹用于保存默认导入论文，不能删除');
    const index = await readIndex();
    if (!index.folders.some((folder) => folder.id === folderId)) throw notFound('文件夹不存在');
    const folderIds = collectFolderTree(index.folders, folderId);
    const paperIds = index.papers.filter((paper) => folderIds.has(paper.folderId)).map((paper) => paper.id);
    for (const paperId of paperIds) {
      await rm(paperDirectory(paperId), { recursive: true, force: true });
      await rm(translationCachePath(paperId), { force: true });
    }
    index.folders = index.folders.filter((folder) => !folderIds.has(folder.id));
    index.papers = index.papers.filter((paper) => !paperIds.includes(paper.id));
    await saveIndex(index);
    sendJson(res, 200, { deletedFolderIds: [...folderIds], deletedPaperIds: paperIds });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/papers/upload') {
    const paper = await importLocalPdf(await readJsonBody(req));
    sendJson(res, 201, paperResponse(paper));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/papers/arxiv') {
    const paper = await importArxivPdf(await readJsonBody(req));
    sendJson(res, 201, paperResponse(paper));
    return;
  }

  const paperId = segments[2];
  const action = segments[3];
  if (segments[1] !== 'papers' || !paperId) throw notFound('接口不存在');
  const index = await readIndex();
  const paper = index.papers.find((item) => item.id === paperId);
  if (!paper) throw notFound('论文不存在');

  if (req.method === 'GET' && action === 'pdf') {
    res.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-cache' });
    createReadStream(paperPdfPath(paperId)).pipe(res);
    return;
  }
  if (req.method === 'POST' && action === 'position') {
    const body = await readJsonBody(req);
    const updated = await updatePaper(paperId, (target) => {
      target.currentPage = Math.max(1, Number(body.page) || 1);
      target.lastOpenedAt = new Date().toISOString();
    });
    sendJson(res, 200, paperResponse(updated));
    return;
  }
  if (req.method === 'POST' && action === 'translate') {
    const body = await readJsonBody(req);
    const text = normalizeText(body.text);
    if (!text) throw new Error('翻译内容不能为空');
    const result = await cachedTranslation(paperId, {
      text,
      sourceLanguage: body.sourceLanguage || 'auto',
      targetLanguage: body.targetLanguage || '中文',
    });
    sendJson(res, 200, result);
    return;
  }
  if (req.method === 'POST' && action === 'ask') {
    const body = await readJsonBody(req);
    const question = normalizeText(body.question);
    if (!question) throw new Error('问题不能为空');
    const context = {
      paper,
      page: body.page,
      selectedText: normalizeText(body.selectedText),
      currentPageText: normalizeText(body.pageText),
    };
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      await runPaperAgent({
        question,
        context,
        imageData: body.imageData,
        task: body.task || 'question',
        onDelta: (delta) => emit('token', { text: delta }),
      });
      emit('done', { ok: true });
    } catch (error) {
      emit('error', { message: error.message });
    } finally {
      res.end();
    }
    return;
  }
  if (req.method === 'DELETE' && !action) {
    await rm(paperDirectory(paperId), { recursive: true, force: true });
    await rm(translationCachePath(paperId), { force: true });
    index.papers = index.papers.filter((item) => item.id !== paperId);
    await saveIndex(index);
    sendJson(res, 200, { ok: true });
    return;
  }
  throw notFound('接口不存在');
}

function collectFolderTree(folders, rootId) {
  const result = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

function cryptoRandomId() {
  return `folder-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`;
}

async function serveStatic(res, pathname) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(staticRoot, `.${requested}`);
  if (!target.startsWith(staticRoot)) throw notFound('资源不存在');
  const content = await readFile(target);
  res.writeHead(200, { 'content-type': mimeTypes[path.extname(target)] || 'application/octet-stream' });
  res.end(content);
}

await ensureStore();
await writePromptTemplates(await getAppSettings());
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) sendError(res, error);
    else res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Paper Reader running at http://127.0.0.1:${port}`);
});
