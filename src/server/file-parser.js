import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const DEFAULT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function joinUrl(baseUrl, pathname) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${pathname.replace(/^\/+/, '')}`;
}

function expertError(message) {
  return new Error(`智谱 Expert：${message}`);
}

function responseStatus(response) {
  return Number(response?.status ?? 0);
}

async function responsePayload(response) {
  if (typeof response?.text === 'function') {
    const raw = await response.text();
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      return { raw };
    }
  }
  if (typeof response?.json === 'function') return response.json();
  return {};
}

function responseDetail(payload) {
  if (typeof payload === 'string') return payload;
  return payload?.error?.message
    || payload?.error
    || payload?.message
    || payload?.raw
    || '';
}

async function expertRequest(url, init, operation) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const cause = error?.cause?.code || error?.message || String(error);
    throw expertError(`${operation}网络请求失败：${cause}`);
  }
  let payload;
  try {
    payload = await responsePayload(response);
  } catch (error) {
    throw expertError(`${operation}响应读取失败：${error.message}`);
  }
  if (!response.ok) {
    const detail = responseDetail(payload);
    throw expertError(`${operation}请求失败：HTTP ${responseStatus(response)}${detail ? `，${detail}` : ''}`);
  }
  return payload;
}

function nestedValue(payload, keys) {
  for (const value of [payload, payload?.data, payload?.result]) {
    if (!value || typeof value !== 'object') continue;
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null) return value[key];
    }
  }
  return undefined;
}

function taskIdFrom(payload) {
  const taskId = nestedValue(payload, ['task_id', 'taskId', 'id']);
  if (typeof taskId !== 'string' || !taskId.trim()) {
    throw expertError('文件解析创建响应缺少 task_id');
  }
  return taskId;
}

function statusFrom(payload) {
  const status = nestedValue(payload, ['status', 'state']);
  return typeof status === 'string' ? status.toLowerCase() : '';
}

function downloadLinkFrom(payload) {
  const link = nestedValue(payload, ['parsing_result_url', 'parsingResultUrl', 'download_link', 'downloadLink', 'download_url', 'downloadUrl']);
  if (typeof link !== 'string' || !link) throw expertError('解析成功响应缺少下载链接');
  return link;
}

function withoutSignedLinks(value) {
  if (Array.isArray(value)) return value.map(withoutSignedLinks);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (/^(download[_-]?(link|url)|parsing[_-]?result[_-]?url|signed[_-]?url)$/i.test(key)) continue;
    result[key] = withoutSignedLinks(child);
  }
  return result;
}

async function saveTaskMetadata(filePath, metadata) {
  await writeFile(filePath, JSON.stringify(withoutSignedLinks(metadata), null, 2));
}

function sleep(milliseconds, signal) {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(expertError('请求已取消'));
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function validateZipEntryName(entryName) {
  if (typeof entryName !== 'string' || !entryName || entryName.includes('\\') || entryName.includes('\0')) {
    throw expertError(`ZIP 包包含不安全路径：${String(entryName)}`);
  }
  if (entryName.startsWith('/') || /^[A-Za-z]:/.test(entryName)) {
    throw expertError(`ZIP 包包含不安全路径：${entryName}`);
  }
  const normalized = path.posix.normalize(entryName);
  if (normalized !== entryName || normalized === '..' || normalized.startsWith('../')) {
    throw expertError(`ZIP 包包含不安全路径：${entryName}`);
  }
  return normalized;
}

function outputPathForEntry(parsedDirectory, entryName) {
  const outputPath = path.resolve(parsedDirectory, ...entryName.split('/'));
  const relative = path.relative(parsedDirectory, outputPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw expertError(`ZIP 包包含不安全路径：${entryName}`);
  }
  return outputPath;
}

async function extractResultZip(zipBuffer, directory) {
  let entries;
  try {
    entries = unzipSync(new Uint8Array(zipBuffer));
  } catch (error) {
    throw expertError(`ZIP 结果解析失败：${error.message}`);
  }

  const parsedDirectory = path.join(directory, 'parsed');
  const result = entries['result.md'];
  const resultBytes = result && !(result instanceof Uint8Array) ? new Uint8Array(result) : result;
  if (!resultBytes || !strFromU8(resultBytes).trim()) {
    throw expertError('ZIP 结果缺少非空 result.md');
  }

  const imageEntries = [];
  for (const [entryName, bytes] of Object.entries(entries)) {
    const safeName = validateZipEntryName(entryName);
    if (safeName === 'result.md') continue;
    if (safeName.startsWith('images/') && safeName !== 'images/' && !safeName.endsWith('/')) {
      imageEntries.push([safeName, bytes]);
    }
  }

  await mkdir(path.join(parsedDirectory, 'images'), { recursive: true });
  await writeFile(path.join(parsedDirectory, 'result.md'), strFromU8(resultBytes));
  await writeFile(path.join(parsedDirectory, 'result.zip'), Buffer.from(zipBuffer));
  const images = [];
  for (const [entryName, bytes] of imageEntries) {
    const outputPath = outputPathForEntry(parsedDirectory, entryName);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, Buffer.from(bytes));
    images.push({ path: path.posix.join('parsed', entryName) });
  }
  return { markdown: strFromU8(resultBytes), images };
}

/**
 * Parse a PDF using Zhipu's Expert file parser and persist its result.
 * @param {Buffer|Uint8Array} pdfBuffer
 * @param {string} directory
 * @param {object} settings
 * @param {AbortSignal} signal
 * @param {{pollIntervalMs?: number, timeoutMs?: number}} options
 */
export async function parsePdfWithExpert(
  pdfBuffer,
  directory,
  settings = {},
  signal,
  options = {},
) {
  const apiKey = settings?.rag?.parserApiKey ?? process.env.GLM_API_KEY ?? '';
  if (!apiKey) throw expertError('未配置 parser API key（GLM_API_KEY）');
  const baseUrl = settings?.rag?.parserBaseUrl || DEFAULT_BASE_URL;
  const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));

  await mkdir(directory, { recursive: true });
  const form = new FormData();
  form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), 'original.pdf');
  form.append('tool_type', 'expert');
  form.append('file_type', 'PDF');

  const createResponse = await expertRequest(
    joinUrl(baseUrl, '/files/parser/create'),
    { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal },
    '文件上传',
  );
  const taskId = taskIdFrom(createResponse);
  const taskPath = path.join(directory, 'parse-task.json');
  await saveTaskMetadata(taskPath, { task_id: taskId, create: createResponse, status: 'uploaded' });

  const deadline = Date.now() + timeoutMs;
  let pollResponse;
  while (true) {
    if (Date.now() > deadline) throw expertError(`解析任务超时（${timeoutMs}ms）`);
    pollResponse = await expertRequest(
      joinUrl(baseUrl, `/files/parser/result/${encodeURIComponent(taskId)}/download_link`),
      { method: 'GET', headers: { Authorization: `Bearer ${apiKey}` }, signal },
      '解析任务查询',
    );
    const status = statusFrom(pollResponse);
    await saveTaskMetadata(taskPath, { task_id: taskId, create: createResponse, result: pollResponse, status });
    if (status === 'succeeded') break;
    if (status !== 'processing') {
      throw expertError(`解析任务失败：状态 ${status || '未知'}`);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw expertError(`解析任务超时（${timeoutMs}ms）`);
    await sleep(Math.min(pollIntervalMs, remaining), signal);
  }

  const downloadLink = downloadLinkFrom(pollResponse);
  let downloadResponse;
  try {
    downloadResponse = await fetch(downloadLink, { method: 'GET', signal });
  } catch (error) {
    const cause = error?.cause?.code || error?.message || String(error);
    throw expertError(`结果下载网络请求失败：${cause}`);
  }
  if (!downloadResponse.ok) {
    throw expertError(`结果下载请求失败：HTTP ${responseStatus(downloadResponse)}`);
  }
  let zipBuffer;
  try {
    zipBuffer = await downloadResponse.arrayBuffer();
  } catch (error) {
    throw expertError(`结果下载读取失败：${error.message}`);
  }
  const parsed = await extractResultZip(zipBuffer, directory);
  return { ...parsed, taskId };
}
