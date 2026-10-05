import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const promptDirectory = path.resolve('.runtime/agent-prompts');

function parseEvent(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function runPaperAgent({ question, context, imageData, onDelta }) {
  await mkdir(promptDirectory, { recursive: true });
  const requestId = randomUUID();
  const promptPath = path.join(promptDirectory, `${requestId}.md`);
  const imagePath = imageData ? path.join(promptDirectory, `${requestId}.png`) : null;
  const prompt = [
    '# 论文阅读上下文',
    context.paper ? `论文：${context.paper.title}` : '',
    context.page ? `当前页码：${context.page}` : '',
    context.selectedText ? `选中文本：\n${context.selectedText}` : '',
    context.paperText ? `论文文本：\n${context.paperText}` : '',
    '',
    '# 用户问题',
    question,
    '',
    '请基于提供的论文上下文回答。引用页码或结构块时使用上下文中的信息。无法从上下文确认的内容请明确说明。',
  ].filter(Boolean).join('\n\n');
  await writeFile(promptPath, prompt);

  const args = [
    '--mode', 'json',
    '--no-session',
    '--no-tools',
    '--no-context-files',
    '--print',
    '--system-prompt',
    '你是论文阅读 Agent，专注于论文概括、章节精读、图片解释和基于证据的问答。',
    '--',
    `@${promptPath}`,
    ...(imagePath ? [`@${imagePath}`] : []),
  ];
  if (process.env.PI_MODEL) args.splice(0, 0, '--model', process.env.PI_MODEL);
  if (process.env.PI_THINKING) args.splice(0, 0, '--thinking', process.env.PI_THINKING);

  if (imagePath) {
    const encoded = imageData.replace(/^data:image\/[^;]+;base64,/, '');
    await writeFile(imagePath, Buffer.from(encoded, 'base64'));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.env.PI_COMMAND || 'pi', args, {
      cwd: process.cwd(),
      env: { ...process.env, PI_OFFLINE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split('\n');
      stdout = lines.pop() ?? '';
      for (const line of lines) {
        const event = parseEvent(line);
        const delta = event?.assistantMessageEvent?.type === 'text_delta'
          ? event.assistantMessageEvent.delta
          : '';
        if (delta) onDelta(delta);
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', async (error) => {
      await cleanup(promptPath, imagePath);
      reject(new Error(`pi 启动失败：${error.message}`));
    });
    child.on('close', async (code) => {
      await cleanup(promptPath, imagePath);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `pi 运行失败，退出码 ${code}`));
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
