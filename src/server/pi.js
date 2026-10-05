import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getAppSettings, writePromptTemplates } from './settings.js';

const promptDirectory = path.resolve('.runtime/agent-prompts');

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function runPaperAgent({ question, context, imageData, task = 'question', onDelta }) {
  const settings = await getAppSettings();
  const templateDirectory = await writePromptTemplates(settings);
  await mkdir(promptDirectory, { recursive: true });
  const requestId = randomUUID();
  const promptPath = path.join(promptDirectory, `${requestId}.md`);
  const imagePath = imageData ? path.join(promptDirectory, `${requestId}.png`) : null;
  const templateName = ['summary', 'section', 'figure', 'question'].includes(task) ? task : 'question';
  const prompt = [
    `/paper-${templateName}`,
    '# 论文阅读上下文',
    context.paper ? `论文：${context.paper.title}` : '',
    context.page ? `当前页码：${context.page}` : '',
    context.selectedText ? `选中文本：\n${context.selectedText}` : '',
    context.currentPageText ? `当前页文本：\n${context.currentPageText}` : '',
    '',
    '# 用户问题',
    question,
    '',
    '请基于提供的论文上下文回答，并在可能时给出当前页码或原文依据。',
  ].filter(Boolean).join('\n\n');
  await writeFile(promptPath, prompt);

  const args = [
    '--prompt-template', templateDirectory,
    '--system-prompt',
    '你是论文阅读 Agent，专注于基于用户提供上下文的论文概括、章节精读、图片解释和问答。',
    '--thinking', settings.agent.thinking,
    '--',
    `@${promptPath}`,
    ...(imagePath ? [`@${imagePath}`] : []),
  ];

  if (imagePath) {
    const encoded = imageData.replace(/^data:image\/[^;]+;base64,/, '');
    await writeFile(imagePath, Buffer.from(encoded, 'base64'));
  }

  try {
    await runPi(settings, args, onDelta);
  } finally {
    await cleanup(promptPath, imagePath);
  }
}

export function parseMetadataResponse(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end < start) throw new Error(`pi 未返回 JSON 元数据：${text.slice(0, 200)}`);
  const parsed = JSON.parse(text.slice(start, end + 1));
  const title = String(parsed.title ?? '').trim();
  if (!title) throw new Error('pi 未识别出论文标题');
  return {
    title,
    authors: Array.isArray(parsed.authors) ? parsed.authors.map((author) => String(author).trim()).filter(Boolean) : [],
    year: String(parsed.year ?? '').trim(),
  };
}

export async function extractPaperMetadata(firstPageText) {
  const settings = await getAppSettings();
  await mkdir(promptDirectory, { recursive: true });
  const promptPath = path.join(promptDirectory, `${randomUUID()}-metadata.md`);
  await writeFile(promptPath, `以下是一篇论文 PDF 的首页文本：\n\n${firstPageText}`);
  const args = [
    '--system-prompt',
    '从论文首页文本中提取元数据。只输出一个 JSON 对象，不要输出其他内容：{"title": "论文标题", "authors": ["作者"], "year": "发表年份"}。无法确定的字段使用空字符串或空数组。',
    '--thinking', 'off',
    '--',
    `@${promptPath}`,
  ];
  let text = '';
  try {
    await runPi(settings, args, (delta) => { text += delta; });
  } finally {
    await rm(promptPath, { force: true });
  }
  return parseMetadataResponse(text);
}

function runPi(settings, taskArgs, onDelta) {
  const args = [
    '--mode', 'json',
    '--no-session',
    '--no-tools',
    '--no-context-files',
    '--approve',
    '--print',
    ...(settings.agent.model ? ['--model', settings.agent.model] : []),
    ...taskArgs,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_COMMAND || 'pi', args, {
      cwd: process.cwd(),
      env: { ...process.env, PI_OFFLINE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let modelError = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseEvent(line);
        const delta = event?.assistantMessageEvent?.type === 'text_delta'
          ? event.assistantMessageEvent.delta
          : '';
        if (delta) onDelta(delta);
        if (event?.type === 'message_end' && event.message.role === 'assistant' && event.message.stopReason === 'error') {
          modelError = event.message.errorMessage || '模型返回错误';
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      reject(new Error(`pi 启动失败：${error.message}`));
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `pi 运行失败，退出码 ${code}`));
        return;
      }
      if (modelError) {
        reject(new Error(`pi 模型调用失败：${modelError}`));
        return;
      }
      resolve();
    });
  });
}

async function cleanup(promptPath, imagePath) {
  await rm(promptPath, { force: true });
  if (imagePath) await rm(imagePath, { force: true });
}
