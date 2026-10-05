function chatEndpoint(baseUrl) {
  const normalized = String(baseUrl ?? '').replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => item?.text ?? '').join('');
  return '';
}

export function translationSettings() {
  return {
    baseUrl: process.env.TRANSLATION_BASE_URL ?? '',
    apiKey: process.env.TRANSLATION_API_KEY ?? '',
    model: process.env.TRANSLATION_MODEL ?? '',
  };
}

export async function translateText({ text, sourceLanguage, targetLanguage }) {
  const settings = translationSettings();
  if (!settings.baseUrl || !settings.model) {
    throw new Error('请配置 TRANSLATION_BASE_URL 和 TRANSLATION_MODEL');
  }

  const headers = { 'content-type': 'application/json' };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
  const response = await fetch(chatEndpoint(settings.baseUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: settings.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content: '你是学术论文翻译助手。只输出译文，保留公式、术语和段落结构，不添加解释。',
        },
        {
          role: 'user',
          content: `源语言：${sourceLanguage || '自动识别'}\n目标语言：${targetLanguage}\n\n${text}`,
        },
      ],
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.error?.message || `翻译模型请求失败：HTTP ${response.status}`);
  }
  const result = contentText(payload?.choices?.[0]?.message?.content).trim();
  if (!result) throw new Error('翻译模型返回空结果');
  return result;
}
