import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const state = {
  folders: [],
  papers: [],
  selectedPaper: null,
  pdf: null,
  page: 1,
  zoom: 1,
  selectedImage: null,
  selectedImageLabel: '',
  agentBusy: false,
};

const $ = (id) => document.getElementById(id);

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { toast.hidden = true; }, 4200);
}

async function request(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败：HTTP ${response.status}`);
  return payload;
}

function renderLibrary() {
  const tree = $('libraryTree');
  tree.innerHTML = '';
  for (const folder of state.folders) {
    const section = document.createElement('section');
    section.className = 'folder';
    const title = document.createElement('div');
    title.className = 'folder-title';
    title.textContent = `▾ ${folder.name}`;
    section.append(title);
    const papers = state.papers.filter((paper) => paper.folderId === folder.id);
    for (const paper of papers) {
      const button = document.createElement('button');
      button.className = `paper-item${state.selectedPaper?.id === paper.id ? ' selected' : ''}`;
      button.innerHTML = `<strong>${escapeHtml(paper.title)}</strong><small>${paper.year || '本地导入'} · ${paper.parseStatus}</small>`;
      button.addEventListener('click', () => selectPaper(paper));
      section.append(button);
    }
    tree.append(section);
  }
  if (!state.folders.length && !state.papers.length) tree.textContent = '还没有论文';
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

async function loadLibrary() {
  const library = await request('/api/library');
  state.folders = library.folders;
  state.papers = library.papers;
  renderLibrary();
  $('libraryStatus').textContent = `${state.papers.length} 篇论文`;
}

async function selectPaper(paper) {
  state.selectedPaper = paper;
  state.page = paper.currentPage || 1;
  state.zoom = 1;
  renderLibrary();
  $('paperTitle').textContent = paper.title;
  $('paperMeta').textContent = [paper.authors?.slice(0, 3).join(', '), paper.year, paper.arxivId].filter(Boolean).join(' · ') || '本地论文';
  $('emptyReader').hidden = true;
  $('pdfPageWrap').hidden = false;
  $('translationPanel').hidden = true;
  try {
    state.pdf = await pdfjsLib.getDocument(paper.pdfUrl).promise;
    $('pageCount').textContent = state.pdf.numPages;
    await renderPage();
  } catch (error) {
    showToast(`PDF 加载失败：${error.message}`);
  }
}

async function renderPage() {
  if (!state.pdf) return;
  state.page = Math.min(Math.max(1, state.page), state.pdf.numPages);
  $('pageInput').value = state.page;
  const page = await state.pdf.getPage(state.page);
  const viewport = page.getViewport({ scale: state.zoom * 1.35 });
  const canvas = $('pdfCanvas');
  const context = canvas.getContext('2d', { alpha: false });
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: context, viewport }).promise;
  const textContent = await page.getTextContent();
  $('pageText').textContent = textContent.items.map((item) => item.str).join(' ');
  $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
  await request(`/api/papers/${state.selectedPaper.id}/position`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: state.page }),
  }).catch(() => {});
}

function selectedText() {
  const selection = window.getSelection()?.toString().trim();
  return selection || '';
}

async function translateSelection() {
  const text = selectedText();
  if (!state.selectedPaper) return showToast('请先选择一篇论文');
  if (!text) return showToast('请先在当前页文本中选中内容');
  $('translationPanel').hidden = false;
  $('translationStatus').textContent = '翻译中…';
  $('translationResult').textContent = '';
  try {
    const result = await request(`/api/papers/${state.selectedPaper.id}/translate`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, targetLanguage: '中文', sourceLanguage: 'auto' }),
    });
    $('translationResult').textContent = result.result;
    $('translationStatus').textContent = result.cached ? '缓存命中' : '模型翻译';
  } catch (error) {
    $('translationStatus').textContent = '失败';
    showToast(error.message);
  }
}

function addMessage(role, text = '') {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  const content = document.createElement('pre');
  content.textContent = text;
  message.append(content);
  $('chatMessages').append(message);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  return content;
}

function updateContextChips() {
  const chips = $('contextChips');
  chips.innerHTML = '';
  if (state.selectedPaper) chips.append(chip(`论文：${state.selectedPaper.title}`));
  chips.append(chip(`第 ${state.page} 页`));
  if (selectedText()) chips.append(chip('已选中文本'));
  if (state.selectedImage) chips.append(chip(state.selectedImageLabel || '已附加图片'));
}

function chip(text) {
  const element = document.createElement('span');
  element.className = 'context-chip';
  element.textContent = text;
  return element;
}

async function sendQuestion(question) {
  if (!state.selectedPaper) return showToast('请先选择一篇论文');
  if (!question.trim()) return;
  if (state.agentBusy) return showToast('Agent 正在回答');
  state.agentBusy = true;
  $('agentStatus').textContent = '思考中';
  $('agentStatus').classList.add('busy');
  addMessage('user', question);
  const assistant = addMessage('assistant', '');
  const payload = {
    question,
    page: state.page,
    selectedText: selectedText(),
    imageData: state.selectedImage,
  };
  try {
    const response = await fetch(`/api/papers/${state.selectedPaper.id}/ask`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    if (!response.ok || !response.body) throw new Error(`Agent 请求失败：HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const events = buffer.split('\n\n');
      buffer = events.pop() || '';
      for (const raw of events) {
        const eventName = raw.match(/^event: (.+)$/m)?.[1];
        const data = raw.match(/^data: (.+)$/m)?.[1];
        if (!data) continue;
        const parsed = JSON.parse(data);
        if (eventName === 'token') {
          assistant.textContent += parsed.text;
          $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
        }
        if (eventName === 'error') throw new Error(parsed.message);
      }
    }
  } catch (error) {
    assistant.textContent = `Agent 错误：${error.message}`;
    showToast(error.message);
  } finally {
    state.agentBusy = false;
    $('agentStatus').textContent = '就绪';
    $('agentStatus').classList.remove('busy');
    state.selectedImage = null;
    state.selectedImageLabel = '';
    $('imageStatus').textContent = '';
    updateContextChips();
  }
}

function setupCropSelection() {
  const canvas = $('pdfCanvas');
  const wrap = $('canvasWrap');
  let start = null;
  wrap.addEventListener('pointerdown', (event) => {
    if (!state.pdf) return;
    const rect = canvas.getBoundingClientRect();
    start = { x: event.clientX - rect.left, y: event.clientY - rect.top, rect };
    $('cropBox').hidden = false;
    $('cropBox').style.left = `${start.x}px`;
    $('cropBox').style.top = `${start.y}px`;
    $('cropBox').style.width = '0px';
    $('cropBox').style.height = '0px';
    wrap.setPointerCapture(event.pointerId);
  });
  wrap.addEventListener('pointermove', (event) => {
    if (!start) return;
    const rect = start.rect;
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const left = Math.min(start.x, x); const top = Math.min(start.y, y);
    const width = Math.abs(x - start.x); const height = Math.abs(y - start.y);
    Object.assign($('cropBox').style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  });
  wrap.addEventListener('pointerup', (event) => {
    if (!start) return;
    const rect = start.rect;
    const x = event.clientX - rect.left; const y = event.clientY - rect.top;
    const left = Math.min(start.x, x); const top = Math.min(start.y, y);
    const width = Math.abs(x - start.x); const height = Math.abs(y - start.y);
    start = null;
    if (width < 10 || height < 10) { $('cropBox').hidden = true; return; }
    const scaleX = canvas.width / rect.width; const scaleY = canvas.height / rect.height;
    const crop = document.createElement('canvas');
    crop.width = Math.round(width * scaleX); crop.height = Math.round(height * scaleY);
    crop.getContext('2d').drawImage(canvas, left * scaleX, top * scaleY, crop.width, crop.height, 0, 0, crop.width, crop.height);
    state.selectedImage = crop.toDataURL('image/png');
    state.selectedImageLabel = '已框选图片';
    $('imageStatus').textContent = '截图已附加';
    $('cropBox').hidden = true;
    updateContextChips();
  });
}

$('uploadButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const data = await readAsDataUrl(file);
    const result = await request('/api/papers/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data, folderId: state.folders[0]?.id || 'inbox' }),
    });
    await loadLibrary();
    await selectPaper(result);
  } catch (error) { showToast(error.message); }
  event.target.value = '';
});
$('arxivForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('arxivInput').value.trim();
  if (!url) return;
  try {
    const result = await request('/api/papers/arxiv', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, folderId: state.folders[0]?.id || 'inbox' }),
    });
    $('arxivInput').value = '';
    await loadLibrary();
    await selectPaper(result);
  } catch (error) { showToast(error.message); }
});
$('folderButton').addEventListener('click', async () => {
  const name = window.prompt('文件夹名称');
  if (!name?.trim()) return;
  try { await request('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }); await loadLibrary(); }
  catch (error) { showToast(error.message); }
});
$('previousPage').addEventListener('click', async () => { state.page -= 1; await renderPage(); });
$('nextPage').addEventListener('click', async () => { state.page += 1; await renderPage(); });
$('pageInput').addEventListener('change', async (event) => { state.page = Number(event.target.value); await renderPage(); });
$('zoomOut').addEventListener('click', async () => { state.zoom = Math.max(.6, state.zoom - .1); await renderPage(); });
$('zoomIn').addEventListener('click', async () => { state.zoom = Math.min(2, state.zoom + .1); await renderPage(); });
$('translateSelection').addEventListener('click', translateSelection);
$('chatForm').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('chatInput'); const question = input.value; input.value = ''; await sendQuestion(question); });
for (const button of document.querySelectorAll('.quick-actions button')) button.addEventListener('click', () => sendQuestion(button.dataset.prompt));
$('imageInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  state.selectedImage = await readAsDataUrl(file);
  state.selectedImageLabel = file.name;
  $('imageStatus').textContent = file.name;
  updateContextChips();
});
setupCropSelection();
loadLibrary().catch((error) => showToast(error.message));

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
