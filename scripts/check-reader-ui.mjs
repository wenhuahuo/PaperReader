// Browser check for the reader UI: node scripts/check-reader-ui.mjs <paper.pdf>
// Imports the PDF through the real upload UI, so metadata recognition may call the arXiv API or pi.
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const pdfPath = process.argv[2];
if (!pdfPath) throw new Error('Usage: node scripts/check-reader-ui.mjs <paper.pdf>');

const runtimeDirectory = path.resolve('.runtime/reader-ui-check');
const port = 3092;
const debugPort = 9333;
const chromePath = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await rm(path.join(runtimeDirectory, 'library'), { recursive: true, force: true });
await mkdir(runtimeDirectory, { recursive: true });
const server = spawn('node', ['src/server/index.js'], {
  env: { ...process.env, PORT: String(port), PAPER_READER_ROOT: path.join(runtimeDirectory, 'library') },
  stdio: 'inherit',
});
const chrome = spawn(chromePath, [
  '--headless=new', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${path.join(runtimeDirectory, 'chrome-profile')}`,
  '--no-first-run', '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

try {
  let targets = null;
  for (let attempt = 0; attempt < 30 && !targets; attempt += 1) {
    await sleep(500);
    targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json(), () => null);
  }
  if (!targets) throw new Error(`Chrome debug port ${debugPort} did not open`);
  const target = targets.find((item) => item.type === 'page');
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || expression);
    return result.result.value;
  };
  const waitFor = async (expression, timeoutMs) => {
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += 250) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    return false;
  };

  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await waitFor("document.querySelector('.folder-title') !== null", 10000);

  const { root } = await send('DOM.getDocument');
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#fileInput' });
  await send('DOM.setFileInputFiles', { nodeId, files: [path.resolve(pdfPath)] });
  const imported = await waitFor("document.querySelectorAll('.pdf-page canvas').length > 0", 90000);
  if (!imported) throw new Error('Paper import or first page rendering timed out');

  const metadata = await evaluate(`(async () => {
    const library = await (await fetch('/api/library')).json();
    const paper = library.papers[0];
    return { title: paper.title, authors: paper.authors, year: paper.year, arxivId: paper.arxivId, toast: document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent };
  })()`);

  const layout = await evaluate(`(() => {
    const visible = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const inViewport = (selector) => document.querySelector(selector).getBoundingClientRect().bottom <= innerHeight;
    const canvas = document.querySelector('.pdf-page canvas');
    return {
      emptyReaderHidden: !visible('emptyReader'),
      chatComposerInViewport: inViewport('#chatForm'),
      settingsButtonInViewport: inViewport('#settingsButton'),
      translateButtonInViewport: inViewport('#translateSelection'),
      allPagesStacked: document.querySelectorAll('.pdf-page').length === Number(document.getElementById('pageCount').textContent),
      hiDpiCanvas: canvas.width === Math.floor(parseFloat(canvas.style.width) * devicePixelRatio),
      textLayerSpans: document.querySelectorAll('.pdf-page .textLayer span').length,
      noPaperOrPageChips: !/论文：|第 \\d+ 页/.test(document.getElementById('contextChips').textContent),
    };
  })()`);

  const scrollPaging = await evaluate(`(async () => {
    const stage = document.getElementById('readerStage');
    stage.scrollTop = document.querySelectorAll('.pdf-page')[2].offsetTop;
    await new Promise((resolve) => setTimeout(resolve, 300));
    const afterScroll = document.getElementById('pageInput').value;
    document.getElementById('previousPage').click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    return afterScroll === '3' && document.getElementById('pageInput').value === '2';
  })()`);

  const selectedChip = await evaluate(`(async () => {
    const span = [...document.querySelectorAll('.pdf-page .textLayer span')].find((item) => item.textContent.trim().length > 3);
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return document.getElementById('contextChips').textContent.includes('已选中文本');
  })()`);

  const keyboard = await evaluate(`(async () => {
    const input = document.getElementById('chatInput');
    input.focus();
    input.value = 'line';
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    const ctrlEnterNewline = input.value === 'line\\n';
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    return { ctrlEnterNewline, enterSubmits: input.value === '' };
  })()`);

  const markdown = await evaluate(`(async () => {
    const originalFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/ask')) return originalFetch(url, options);
      const body = 'event: token\\ndata: ' + JSON.stringify({ text: '## 结论\\n\\n**关键**：<img src=x onerror=alert(1)>\\n\\n- 第一点' }) + '\\n\\nevent: done\\ndata: {}\\n\\n';
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
    document.getElementById('chatInput').value = '测试 Markdown';
    document.getElementById('chatForm').requestSubmit();
    await new Promise((resolve) => setTimeout(resolve, 800));
    window.fetch = originalFetch;
    const answer = [...document.querySelectorAll('.message.assistant .markdown')].pop();
    return {
      markdownRendered: Boolean(answer?.querySelector('h2') && answer.querySelector('strong') && answer.querySelector('li')),
      markdownSanitized: !answer?.querySelector('img[onerror]'),
    };
  })()`);

  const cropDefaultOff = await evaluate("!document.getElementById('pdfPages').classList.contains('crop-mode')");
  const folderCollapses = await evaluate(`(async () => {
    document.querySelector('.folder-title').click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const hidden = document.querySelector('.folder-children').hidden;
    document.querySelector('.folder-title').click();
    return hidden;
  })()`);
  const paperMenuOpens = await evaluate(`(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const item = document.querySelector('.paper-item');
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
    const opened = !document.getElementById('paperMenu').hidden;
    document.body.click();
    return opened;
  })()`);

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(runtimeDirectory, 'reader-ui.png'), Buffer.from(screenshot.data, 'base64'));
  socket.close();

  const checks = { ...layout, scrollPaging, selectedChip, ...keyboard, ...markdown, cropDefaultOff, folderCollapses, paperMenuOpens };
  console.log(JSON.stringify({ metadata, checks }, null, 2));
  const failed = Object.entries(checks).filter(([, value]) => value === false || value === 0);
  if (failed.length) throw new Error(`Reader UI check failed: ${failed.map(([key]) => key).join(', ')}`);
} finally {
  chrome.kill();
  server.kill();
}
