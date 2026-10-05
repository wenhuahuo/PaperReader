// Browser check for the reader layout: node scripts/check-reader-ui.mjs <paper.pdf>
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  await sleep(1500);
  const data = `data:application/pdf;base64,${(await readFile(pdfPath)).toString('base64')}`;
  const upload = await fetch(`http://127.0.0.1:${port}/api/papers/upload`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fileName: path.basename(pdfPath), data, folderId: 'inbox' }),
  });
  if (!upload.ok) throw new Error(`Upload failed: ${await upload.text()}`);

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

  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/` });
  await sleep(1500);
  await evaluate("document.querySelector('.paper-item').click()");
  await sleep(2500);

  const layout = await evaluate(`(() => {
    const visible = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const inViewport = (selector) => document.querySelector(selector).getBoundingClientRect().bottom <= innerHeight;
    const canvas = document.getElementById('pdfCanvas');
    return {
      emptyReaderHidden: !visible('emptyReader'),
      chatComposerInViewport: inViewport('#chatForm'),
      settingsButtonInViewport: inViewport('#settingsButton'),
      translateButtonInViewport: inViewport('#translateSelection'),
      hiDpiCanvas: canvas.width === Math.floor(parseFloat(canvas.style.width) * devicePixelRatio),
      textLayerSpans: document.querySelectorAll('#textLayer span').length,
    };
  })()`);

  const selectedChip = await evaluate(`(async () => {
    const span = [...document.querySelectorAll('#textLayer span')].find((item) => item.textContent.trim().length > 3);
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return document.getElementById('contextChips').textContent.includes('已选中文本');
  })()`);

  const cropDefaultOff = await evaluate("!document.getElementById('canvasWrap').classList.contains('crop-mode')");
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
    return !document.getElementById('paperMenu').hidden;
  })()`);

  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(runtimeDirectory, 'reader-ui.png'), Buffer.from(screenshot.data, 'base64'));
  socket.close();

  const result = { ...layout, selectedChip, cropDefaultOff, folderCollapses, paperMenuOpens };
  console.log(JSON.stringify(result, null, 2));
  const failed = Object.entries(result).filter(([, value]) => value === false || value === 0);
  if (failed.length) throw new Error(`Reader UI check failed: ${failed.map(([key]) => key).join(', ')}`);
} finally {
  chrome.kill();
  server.kill();
}
