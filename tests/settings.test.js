import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { publicSettings, writePromptTemplates } from '../src/server/settings.js';

test('public settings mask the translation API key', () => {
  const result = publicSettings({
    translation: { baseUrl: 'http://localhost/v1', model: 'translator', apiKey: 'secret' },
    agent: { model: 'reader', thinking: 'high' },
    prompts: { summary: 'summary', section: 'section', figure: 'figure', question: 'question' },
  });
  assert.equal(result.translation.apiKeyConfigured, true);
  assert.equal('apiKey' in result.translation, false);
});

test('prompt templates expose the configured task instruction and arguments', async () => {
  const directory = await writePromptTemplates({
    prompts: { summary: '自定义概括', section: '自定义精读', figure: '自定义图片', question: '自定义问答' },
  });
  const content = await readFile(`${directory}/paper-summary.md`, 'utf8');
  assert.match(content, /自定义概括/);
  assert.match(content, /\$@/);
  await rm(directory, { recursive: true, force: true });
});
