import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createCanvas } from '@napi-rs/canvas';
import { getAppSettings } from './settings.js';
import { paperRagIndexPath } from './store.js';

const OCR_BATCH_SIZE = 8;
const OCR_RENDER_SCALE = 200 / 72;

function joinUrl(baseUrl, pathname) {
  return `${baseUrl.replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

function authorizationHeader(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

async function postJson(url, body, headers, label, signal) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    const cause = error.cause?.code || error.message;
    throw new Error(`${label}服务连接失败：${url}（${cause}）`);
  }
  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { raw };
  }
  if (!response.ok) {
    const detail = payload.error?.message || payload.error || payload.raw || raw;
    throw new Error(`${label}请求失败：HTTP ${response.status}${detail ? `，${detail}` : ''}`);
  }
  return payload;
}

function parseJsonResult(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      throw new Error(`GLM-OCR 返回的 json_result 不是有效 JSON：${error.message}`);
    }
  }
  return value;
}

function normalizeOcrPages(value) {
  const parsed = parseJsonResult(value);
  if (!Array.isArray(parsed)) throw new Error('GLM-OCR 未返回页面结果');
  if (!parsed.length) return [];
  return Array.isArray(parsed[0]) ? parsed : [parsed];
}

async function renderPdfPages(pdfBuffer) {
  const pdf = await pdfjsLib.getDocument({
    data: new Uint8Array(pdfBuffer),
    disableWorker: true,
    standardFontDataUrl: fileURLToPath(new URL('../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url)),
  }).promise;
  const pages = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: OCR_RENDER_SCALE });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      pages.push(`data:image/jpeg;base64,${canvas.toBuffer('image/jpeg', { quality: 90 }).toString('base64')}`);
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return pages;
}

async function ocrPages(images, settings, signal) {
  const payload = await postJson(
    joinUrl(settings.rag.ocrBaseUrl, '/glmocr/parse'),
    { images },
    authorizationHeader(settings.rag.ocrApiKey),
    'GLM-OCR',
    signal,
  );
  const pages = normalizeOcrPages(payload.json_result ?? payload.layout_details);
  if (pages.length !== images.length) throw new Error(`GLM-OCR 返回页数不匹配：请求 ${images.length} 页，返回 ${pages.length} 页`);
  return pages;
}

function regionLabel(region) {
  return String(region.native_label ?? region.label ?? '').toLowerCase();
}

function isHeading(region) {
  return regionLabel(region) === 'paragraph_title';
}

function isImage(region) {
  return ['image', 'chart'].includes(regionLabel(region));
}

function regionText(region) {
  return String(region.content ?? '').trim();
}

function flushSection(sections, current) {
  if (!current || !current.text.trim()) return;
  sections.push({
    id: `section-${sections.length + 1}`,
    title: current.title,
    pageStart: current.pageStart,
    pageEnd: current.pageEnd,
    text: current.text.trim(),
  });
}

export function buildSectionsFromOcr(pages) {
  const sections = [];
  const images = [];
  let current = { title: '未分节内容', pageStart: 1, pageEnd: 1, text: '' };

  pages.forEach((regions, pageIndex) => {
    const pageNumber = pageIndex + 1;
    for (const region of regions || []) {
      const label = regionLabel(region);
      if (isImage(region)) {
        images.push({
          page: pageNumber,
          label,
          bbox: Array.isArray(region.bbox_2d) ? region.bbox_2d : null,
          content: regionText(region),
        });
        continue;
      }
      const text = regionText(region);
      if (!text) continue;
      if (isHeading(region)) {
        flushSection(sections, current);
        current = { title: text, pageStart: pageNumber, pageEnd: pageNumber, text };
        continue;
      }
      current.pageEnd = pageNumber;
      current.text += `${current.text ? '\n\n' : ''}${text}`;
    }
  });
  flushSection(sections, current);
  return { sections, images };
}

async function embedTexts(texts, settings, signal) {
  if (!settings.rag.embeddingBaseUrl) throw new Error('未配置 WeMM embedding 服务地址');
  if (!texts.length) return [];
  const payload = await postJson(
    joinUrl(settings.rag.embeddingBaseUrl, '/embeddings'),
    { model: settings.rag.embeddingModel, input: texts },
    authorizationHeader(settings.rag.embeddingApiKey),
    'WeMM embedding',
    signal,
  );
  const data = Array.isArray(payload.data) ? [...payload.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)) : [];
  if (data.length !== texts.length || data.some((item) => !Array.isArray(item.embedding))) {
    throw new Error('WeMM embedding 返回的向量数量或格式不正确');
  }
  const vectors = data.map((item) => item.embedding.map(Number));
  if (vectors.some((vector) => !vector.length || vector.some((value) => !Number.isFinite(value)))) {
    throw new Error('WeMM embedding 返回了无效向量');
  }
  return vectors;
}

function normalizeVector(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!norm) throw new Error('WeMM embedding 返回了零向量');
  return vector.map((value) => value / norm);
}

function cosineSimilarity(left, right) {
  if (left.length !== right.length) throw new Error('embedding 维度不一致');
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

export async function buildPaperRagIndex(pdfBuffer) {
  const settings = await getAppSettings();
  if (!settings.rag.ocrBaseUrl) throw new Error('未配置 GLM-OCR 服务地址');
  const images = await renderPdfPages(pdfBuffer);
  const pages = [];
  for (let start = 0; start < images.length; start += OCR_BATCH_SIZE) {
    pages.push(...await ocrPages(images.slice(start, start + OCR_BATCH_SIZE), settings));
  }
  const { sections, images: imageMetadata } = buildSectionsFromOcr(pages);
  if (!sections.length) throw new Error('GLM-OCR 未提取到可索引的文本');
  const embeddings = await embedTexts(sections.map((section) => section.text), settings);
  const index = {
    version: 1,
    embeddingModel: settings.rag.embeddingModel,
    sections: sections.map((section, index) => ({ ...section, embedding: normalizeVector(embeddings[index]) })),
    images: imageMetadata,
    indexedAt: new Date().toISOString(),
  };
  return index;
}

export async function savePaperRagIndex(paperId, index) {
  await writeFile(paperRagIndexPath(paperId), JSON.stringify(index));
}

async function readPaperRagIndex(paperId) {
  try {
    return JSON.parse(await readFile(paperRagIndexPath(paperId), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('论文全文索引不存在，请重新导入论文');
    throw error;
  }
}

export async function retrievePaperSections(paperId, query, topK, signal) {
  const text = String(query ?? '').trim();
  if (!text) throw new Error('全文检索问题不能为空');
  const settings = await getAppSettings();
  const limit = Number(topK ?? settings.rag.topK);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('全文检索 topK 必须是正整数');
  const [index, queryEmbedding] = await Promise.all([
    readPaperRagIndex(paperId),
    embedTexts([text], settings, signal),
  ]);
  const queryVector = normalizeVector(queryEmbedding[0]);
  return index.sections
    .map((section) => ({
      title: section.title,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      text: section.text,
      score: cosineSimilarity(queryVector, section.embedding),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit);
}

export { cosineSimilarity, normalizeVector };
