import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const runtimeDirectory = path.resolve('.runtime');
const settingsPath = path.join(runtimeDirectory, 'settings.json');
const promptDirectory = path.join(runtimeDirectory, 'prompt-templates');

const defaultSettings = {
  translation: { baseUrl: '', apiKey: '', model: '' },
  agent: { model: '', thinking: 'medium' },
  prompts: {
    summary: '请概括这篇论文的研究问题、方法、主要结果和局限。',
    section: '请精读当前页对应的章节，解释关键概念、论证逻辑和与全文的关系。',
    figure: '请解释当前图片或表格，说明图中元素、数据趋势以及它支持的论文结论。',
    question: '请基于论文上下文回答用户问题，并给出可核对的页码或原文依据。',
  },
};

function mergeSettings(saved = {}) {
  return {
    translation: {
      baseUrl: saved.translation?.baseUrl ?? process.env.TRANSLATION_BASE_URL ?? defaultSettings.translation.baseUrl,
      apiKey: saved.translation?.apiKey ?? process.env.TRANSLATION_API_KEY ?? defaultSettings.translation.apiKey,
      model: saved.translation?.model ?? process.env.TRANSLATION_MODEL ?? defaultSettings.translation.model,
    },
    agent: {
      model: saved.agent?.model ?? process.env.PI_MODEL ?? defaultSettings.agent.model,
      thinking: saved.agent?.thinking ?? process.env.PI_THINKING ?? defaultSettings.agent.thinking,
    },
    prompts: { ...defaultSettings.prompts, ...(saved.prompts ?? {}) },
  };
}

export async function getAppSettings() {
  await mkdir(runtimeDirectory, { recursive: true });
  try {
    return mergeSettings(JSON.parse(await readFile(settingsPath, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return mergeSettings();
  }
}

export async function saveAppSettings(patch) {
  const current = await getAppSettings();
  const next = mergeSettings({
    ...current,
    translation: { ...current.translation, ...(patch.translation ?? {}) },
    agent: { ...current.agent, ...(patch.agent ?? {}) },
    prompts: { ...current.prompts, ...(patch.prompts ?? {}) },
  });
  await writeFile(settingsPath, JSON.stringify(next, null, 2));
  return next;
}

export function publicSettings(settings) {
  return {
    translation: {
      baseUrl: settings.translation.baseUrl,
      model: settings.translation.model,
      apiKeyConfigured: Boolean(settings.translation.apiKey),
    },
    agent: settings.agent,
    prompts: settings.prompts,
  };
}

export async function writePromptTemplates(settings) {
  await mkdir(promptDirectory, { recursive: true });
  const templates = {
    summary: settings.prompts.summary,
    section: settings.prompts.section,
    figure: settings.prompts.figure,
    question: settings.prompts.question,
  };
  for (const [name, instruction] of Object.entries(templates)) {
    const content = [
      '---',
      `description: Paper Reader ${name} prompt`,
      'argument-hint: "[paper context]"',
      '---',
      instruction,
      '',
      '$@',
      '',
    ].join('\n');
    await writeFile(path.join(promptDirectory, `paper-${name}.md`), content);
  }
  return promptDirectory;
}

export { promptDirectory };
