import * as pdfjsLib from 'pdfjs-dist/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { renderMarkdownSource } from './markdown.js';
import './styles.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const state = {
  folders: [],
  papers: [],
  selectedPaper: null,
  importFolderId: 'inbox',
  collapsedFolders: new Set(),
  contextFolderId: null,
  contextPaperId: null,
  pdf: null,
  renderId: 0,
  pageObserver: null,
  savePositionTimer: null,
  page: 1,
  zoom: 1,
  selectedText: '',
  cropMode: false,
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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function renderLibrary() {
  const tree = $('libraryTree');
  tree.innerHTML = '';
  const foldersByParent = new Map();
  for (const folder of state.folders) {
    const parent = folder.parentId || null;
    if (!foldersByParent.has(parent)) foldersByParent.set(parent, []);
    foldersByParent.get(parent).push(folder);
  }

  const renderFolder = (folder, depth) => {
    const node = document.createElement('div');
    node.className = 'folder-node';
    node.style.setProperty('--depth', depth);
    const collapsed = state.collapsedFolders.has(folder.id);
    const title = document.createElement('div');
    title.className = `folder-title${state.importFolderId === folder.id ? ' selected-folder' : ''}`;
    title.innerHTML = `<span class="folder-caret">${collapsed ? '▸' : '▾'}</span>📁 ${escapeHtml(folder.name)}`;
    title.title = '左键展开/收起并选为导入位置，右键打开文件夹菜单';
    title.addEventListener('click', () => {
      state.importFolderId = folder.id;
      if (collapsed) state.collapsedFolders.delete(folder.id);
      else state.collapsedFolders.add(folder.id);
      renderLibrary();
    });
    title.addEventListener('contextmenu', (event) => {
      state.contextFolderId = folder.id;
      showMenu($('folderMenu'), event);
    });
    node.append(title);

    const children = document.createElement('div');
    children.className = 'folder-children';
    children.hidden = collapsed;
    for (const paper of state.papers.filter((item) => item.folderId === folder.id)) {
      const button = document.createElement('button');
      button.className = `paper-item${state.selectedPaper?.id === paper.id ? ' selected' : ''}`;
      const firstAuthor = paper.authors?.length > 1 ? `${paper.authors[0]} 等` : paper.authors?.[0];
      button.innerHTML = `<strong>${escapeHtml(paper.title)}</strong><small>${escapeHtml([firstAuthor, paper.year].filter(Boolean).join(' · ') || '本地导入')}</small>`;
      button.title = paper.title;
      button.addEventListener('click', () => selectPaper(paper));
      button.addEventListener('contextmenu', (event) => {
        state.contextPaperId = paper.id;
        showMenu($('paperMenu'), event);
      });
      children.append(button);
    }
    for (const child of foldersByParent.get(folder.id) || []) children.append(renderFolder(child, depth + 1));
    node.append(children);
    return node;
  };

  for (const folder of foldersByParent.get(null) || []) tree.append(renderFolder(folder, 0));
  if (!state.folders.length && !state.papers.length) tree.textContent = '还没有论文';
  $('libraryStatus').textContent = `${state.papers.length} 篇论文`;
}

function showMenu(menu, event) {
  event.preventDefault();
  hideMenus();
  menu.hidden = false;
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8)}px`;
}

function hideMenus() {
  $('folderMenu').hidden = true;
  $('paperMenu').hidden = true;
}

async function loadLibrary() {
  const library = await request('/api/library');
  state.folders = library.folders;
  state.papers = library.papers;
  if (!state.folders.some((folder) => folder.id === state.importFolderId)) state.importFolderId = 'inbox';
  if (state.selectedPaper && !state.papers.some((paper) => paper.id === state.selectedPaper.id)) clearReader();
  renderLibrary();
}

function clearReader() {
  state.selectedPaper = null;
  state.pdf = null;
  state.selectedText = '';
  state.pageObserver?.disconnect();
  $('pdfPages').replaceChildren();
  $('emptyReader').hidden = false;
  $('pdfPages').hidden = true;
  $('translationPanel').hidden = true;
  $('paperTitle').textContent = 'Paper Reader';
  $('paperMeta').textContent = '选择一篇论文开始阅读';
  $('pageCount').textContent = '—';
  updateContextChips();
}

async function selectPaper(paper) {
  state.selectedPaper = paper;
  state.pdf = null;
  state.page = paper.currentPage || 1;
  state.zoom = 1;
  state.selectedText = '';
  state.selectedImage = null;
  state.selectedImageLabel = '';
  renderLibrary();
  updateContextChips();
  $('paperTitle').textContent = paper.title;
  $('paperMeta').textContent = [paper.authors?.slice(0, 3).join(', '), paper.year, paper.arxivId].filter(Boolean).join(' · ') || '本地论文';
  $('emptyReader').hidden = true;
  $('pdfPages').hidden = false;
  $('translationPanel').hidden = true;
  try {
    state.pdf = await pdfjsLib.getDocument(paper.pdfUrl).promise;
    $('pageCount').textContent = state.pdf.numPages;
    await renderDocument();
    scrollToPage(state.page);
  } catch (error) {
    showToast(`PDF 加载失败：${error.message}`);
  }
}

async function renderDocument() {
  const renderId = ++state.renderId;
  const pdf = state.pdf;
  const scale = state.zoom * 1.35;
  const container = $('pdfPages');
  state.pageObserver?.disconnect();
  const pages = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const viewport = (await pdf.getPage(pageNumber)).getViewport({ scale });
    if (renderId !== state.renderId) return;
    const element = document.createElement('div');
    element.className = 'pdf-page';
    element.dataset.page = pageNumber;
    element.style.width = `${Math.floor(viewport.width)}px`;
    element.style.height = `${Math.floor(viewport.height)}px`;
    pages.push(element);
  }
  container.replaceChildren(...pages);
  state.pageObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting || entry.target.dataset.rendered) continue;
      renderPdfPage(pdf, entry.target, scale).catch((error) => showToast(`PDF 页面渲染失败：${error.message}`));
    }
  }, { root: $('readerStage'), rootMargin: '800px 0px' });
  for (const element of pages) state.pageObserver.observe(element);
  $('zoomLabel').textContent = `${Math.round(state.zoom * 100)}%`;
}

async function renderPdfPage(pdf, element, scale) {
  element.dataset.rendered = 'true';
  const page = await pdf.getPage(Number(element.dataset.page));
  const viewport = page.getViewport({ scale });
  const outputScale = window.devicePixelRatio;
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width * outputScale);
  canvas.height = Math.floor(viewport.height * outputScale);
  canvas.style.width = `${Math.floor(viewport.width)}px`;
  canvas.style.height = `${Math.floor(viewport.height)}px`;
  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  textLayer.style.setProperty('--total-scale-factor', viewport.scale);
  element.append(canvas, textLayer);
  await page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport,
    transform: [outputScale, 0, 0, outputScale, 0, 0],
  }).promise;
  await new pdfjsLib.TextLayer({ textContentSource: await page.getTextContent(), container: textLayer, viewport }).render();
}

function scrollToPage(pageNumber) {
  const target = Math.min(Math.max(1, pageNumber), state.pdf.numPages);
  $('pdfPages').children[target - 1].scrollIntoView({ block: 'start' });
  setCurrentPage(target);
}

function updateCurrentPageFromScroll() {
  const stage = $('readerStage');
  const line = stage.getBoundingClientRect().top + stage.clientHeight / 3;
  const current = [...$('pdfPages').children].find((element) => element.getBoundingClientRect().bottom >= line);
  if (current) setCurrentPage(Number(current.dataset.page));
}

function setCurrentPage(pageNumber) {
  $('pageInput').value = pageNumber;
  if (pageNumber === state.page) return;
  state.page = pageNumber;
  const paperId = state.selectedPaper.id;
  window.clearTimeout(state.savePositionTimer);
  state.savePositionTimer = window.setTimeout(async () => {
    try {
      await request(`/api/papers/${paperId}/position`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: pageNumber }),
      });
    } catch (error) {
      showToast(`阅读位置保存失败：${error.message}`);
    }
  }, 600);
}

async function changeZoom(delta) {
  if (!state.pdf) return;
  state.zoom = Math.min(2, Math.max(.6, Math.round((state.zoom + delta) * 10) / 10));
  const page = state.page;
  await renderDocument();
  scrollToPage(page);
}

async function currentPageText() {
  const page = await state.pdf.getPage(state.page);
  return (await page.getTextContent()).items.map((item) => item.str).join(' ');
}

function trackPdfSelection() {
  const selection = window.getSelection();
  if (!selection.rangeCount || !$('pdfPages').contains(selection.anchorNode)) return;
  state.selectedText = selection.toString().trim();
  updateContextChips();
}

function setCropMode(enabled) {
  state.cropMode = enabled;
  $('pdfPages').classList.toggle('crop-mode', enabled);
  $('cropToggle').classList.toggle('active', enabled);
}

async function translateSelection() {
  const text = state.selectedText;
  if (!state.selectedPaper) return showToast('请先选择一篇论文');
  if (!text) return showToast('请先在 PDF 页面中选中文字');
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

function renderMarkdown(text) {
  return DOMPurify.sanitize(renderMarkdownSource(text), {
    ADD_TAGS: ['annotation', 'math', 'menclose', 'merror', 'mfenced', 'mfrac', 'mi', 'mmultiscripts', 'mn', 'mo', 'mover', 'mpadded', 'mphantom', 'mroot', 'mrow', 'ms', 'mspace', 'msqrt', 'mstyle', 'msub', 'msubsup', 'msup', 'mtable', 'mtd', 'mtext', 'mtr', 'munder', 'munderover', 'semantics'],
    ADD_ATTR: ['aria-hidden', 'class', 'encoding', 'style', 'xmlns'],
  });
}

function addMessage(role, text = '') {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  const content = document.createElement(role === 'assistant' ? 'div' : 'pre');
  if (role === 'assistant') content.className = 'markdown';
  content.textContent = text;
  message.append(content);
  $('chatMessages').append(message);
  $('chatMessages').scrollTop = $('chatMessages').scrollHeight;
  return content;
}

function updateContextChips() {
  const chips = $('contextChips');
  chips.innerHTML = '';
  if (state.selectedText) chips.append(chip('已选中文本'));
  if (state.selectedImage) chips.append(chip(state.selectedImageLabel || '已附加图片'));
  chips.hidden = !chips.children.length;
}

function chip(text) {
  const element = document.createElement('span');
  element.className = 'context-chip';
  element.textContent = text;
  return element;
}

async function sendQuestion(question, task = 'question') {
  if (!state.selectedPaper) return showToast('请先选择一篇论文');
  if (!state.pdf) return showToast('PDF 尚未加载完成');
  if (!question.trim()) return;
  if (state.agentBusy) return showToast('Agent 正在回答');
  state.agentBusy = true;
  $('agentStatus').textContent = '思考中';
  $('agentStatus').classList.add('busy');
  addMessage('user', question);
  const assistant = addMessage('assistant', '');
  let answer = '';
  try {
    const payload = {
      question,
      task,
      page: state.page,
      pageText: await currentPageText(),
      selectedText: state.selectedText,
      imageData: state.selectedImage,
    };
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
          answer += parsed.text;
          assistant.innerHTML = renderMarkdown(answer);
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
  const pages = $('pdfPages');
  const cropBox = document.createElement('div');
  cropBox.className = 'crop-box';
  let start = null;
  const cropRect = (event) => {
    const x = Math.min(Math.max(event.clientX - start.rect.left, 0), start.rect.width);
    const y = Math.min(Math.max(event.clientY - start.rect.top, 0), start.rect.height);
    return { left: Math.min(start.x, x), top: Math.min(start.y, y), width: Math.abs(x - start.x), height: Math.abs(y - start.y) };
  };
  pages.addEventListener('pointerdown', (event) => {
    const pageElement = event.target.closest('.pdf-page');
    const canvas = pageElement?.querySelector('canvas');
    if (!state.cropMode || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    start = { x: event.clientX - rect.left, y: event.clientY - rect.top, rect, canvas };
    Object.assign(cropBox.style, { left: `${start.x}px`, top: `${start.y}px`, width: '0px', height: '0px' });
    pageElement.append(cropBox);
    pages.setPointerCapture(event.pointerId);
  });
  pages.addEventListener('pointermove', (event) => {
    if (!start) return;
    const { left, top, width, height } = cropRect(event);
    Object.assign(cropBox.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
  });
  pages.addEventListener('pointerup', (event) => {
    if (!start) return;
    const { rect, canvas } = start;
    const { left, top, width, height } = cropRect(event);
    start = null;
    cropBox.remove();
    if (width < 10 || height < 10) return;
    setCropMode(false);
    const scaleX = canvas.width / rect.width; const scaleY = canvas.height / rect.height;
    const crop = document.createElement('canvas');
    crop.width = Math.round(width * scaleX); crop.height = Math.round(height * scaleY);
    crop.getContext('2d').drawImage(canvas, left * scaleX, top * scaleY, crop.width, crop.height, 0, 0, crop.width, crop.height);
    state.selectedImage = crop.toDataURL('image/png');
    state.selectedImageLabel = '已框选图片';
    $('imageStatus').textContent = '截图已附加';
    updateContextChips();
  });
}

async function readFirstPageText(file) {
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    return content.items.map((item) => item.str + (item.hasEOL ? '\n' : ' ')).join('');
  } finally {
    await pdf.destroy();
  }
}

async function importLocalFile(event) {
  const file = event.target.files[0];
  if (!file) return;
  $('libraryStatus').textContent = '正在导入并识别论文信息…';
  try {
    const [data, firstPageText] = await Promise.all([readAsDataUrl(file), readFirstPageText(file)]);
    const result = await request('/api/papers/upload', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName: file.name, data, firstPageText, folderId: state.importFolderId || 'inbox' }),
    });
    if (result.metadataError) showToast(`论文已导入，但未能识别标题和作者：${result.metadataError}`);
    await loadLibrary();
    await selectPaper(result);
  } catch (error) {
    showToast(error.message);
    renderLibrary();
  }
  event.target.value = '';
}

async function openSettings() {
  try {
    const settings = await request('/api/settings');
    $('translationBaseUrl').value = settings.translation.baseUrl;
    $('translationModel').value = settings.translation.model;
    $('translationApiKey').value = '';
    $('translationApiKey').placeholder = settings.translation.apiKeyConfigured ? '已配置，留空保持' : '请输入 API Key';
    $('agentModel').value = settings.agent.model;
    $('agentThinking').value = settings.agent.thinking;
    $('summaryPrompt').value = settings.prompts.summary;
    $('sectionPrompt').value = settings.prompts.section;
    $('figurePrompt').value = settings.prompts.figure;
    $('questionPrompt').value = settings.prompts.question;
    $('settingsStatus').textContent = '';
    $('appShell').hidden = true;
    $('settingsView').hidden = false;
  } catch (error) { showToast(error.message); }
}

async function saveSettings(event) {
  event.preventDefault();
  const translation = { baseUrl: $('translationBaseUrl').value.trim(), model: $('translationModel').value.trim() };
  if ($('translationApiKey').value.trim()) translation.apiKey = $('translationApiKey').value.trim();
  try {
    await request('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        translation,
        agent: { model: $('agentModel').value.trim(), thinking: $('agentThinking').value },
        prompts: {
          summary: $('summaryPrompt').value.trim(),
          section: $('sectionPrompt').value.trim(),
          figure: $('figurePrompt').value.trim(),
          question: $('questionPrompt').value.trim(),
        },
      }),
    });
    $('settingsStatus').textContent = '已保存';
  } catch (error) {
    $('settingsStatus').textContent = '保存失败';
    showToast(error.message);
  }
}

$('uploadButton').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', importLocalFile);
$('arxivForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = $('arxivInput').value.trim();
  if (!url) return;
  try {
    const result = await request('/api/papers/arxiv', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, folderId: state.importFolderId || 'inbox' }),
    });
    $('arxivInput').value = '';
    await loadLibrary();
    await selectPaper(result);
  } catch (error) { showToast(error.message); }
});
$('folderButton').addEventListener('click', async () => {
  const name = window.prompt('文件夹名称');
  if (!name?.trim()) return;
  try {
    await request('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    await loadLibrary();
  } catch (error) { showToast(error.message); }
});
$('paperMenu').addEventListener('click', async (event) => {
  const paper = state.papers.find((item) => item.id === state.contextPaperId);
  hideMenus();
  if (!paper || event.target.dataset.action !== 'delete') return;
  if (!window.confirm(`删除论文“${paper.title}”？`)) return;
  try {
    await request(`/api/papers/${paper.id}`, { method: 'DELETE' });
    await loadLibrary();
  } catch (error) { showToast(error.message); }
});
$('folderMenu').addEventListener('click', async (event) => {
  const action = event.target.dataset.action;
  const folder = state.folders.find((item) => item.id === state.contextFolderId);
  hideMenus();
  if (!folder || !action) return;
  try {
    if (action === 'rename') {
      const name = window.prompt('新的文件夹名称', folder.name);
      if (!name?.trim()) return;
      await request(`/api/folders/${folder.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    }
    if (action === 'new-child') {
      const name = window.prompt('子文件夹名称');
      if (!name?.trim()) return;
      await request('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, parentId: folder.id }) });
    }
    if (action === 'import') {
      state.importFolderId = folder.id;
      $('fileInput').click();
      return;
    }
    if (action === 'delete') {
      if (!window.confirm(`删除“${folder.name}”及其中的论文和子文件夹？`)) return;
      await request(`/api/folders/${folder.id}`, { method: 'DELETE' });
    }
    await loadLibrary();
  } catch (error) { showToast(error.message); }
});
$('settingsButton').addEventListener('click', openSettings);
$('closeSettings').addEventListener('click', () => { $('settingsView').hidden = true; $('appShell').hidden = false; });
$('settingsForm').addEventListener('submit', saveSettings);
document.addEventListener('click', (event) => {
  if (!$('folderMenu').contains(event.target) && !$('paperMenu').contains(event.target)) hideMenus();
});
document.addEventListener('selectionchange', trackPdfSelection);
$('cropToggle').addEventListener('click', () => setCropMode(!state.cropMode));
$('previousPage').addEventListener('click', () => { if (state.pdf) scrollToPage(state.page - 1); });
$('nextPage').addEventListener('click', () => { if (state.pdf) scrollToPage(state.page + 1); });
$('pageInput').addEventListener('change', (event) => { if (state.pdf) scrollToPage(Number(event.target.value)); });
$('readerStage').addEventListener('scroll', () => { if (state.pdf) updateCurrentPageFromScroll(); });
$('zoomOut').addEventListener('click', () => changeZoom(-.1));
$('zoomIn').addEventListener('click', () => changeZoom(.1));
$('translateSelection').addEventListener('click', translateSelection);
$('chatInput').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey) {
    event.preventDefault();
    const input = event.target;
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    return;
  }
  if (event.shiftKey || event.altKey || event.metaKey) return;
  event.preventDefault();
  $('chatForm').requestSubmit();
});
$('chatForm').addEventListener('submit', async (event) => { event.preventDefault(); const input = $('chatInput'); const question = input.value; input.value = ''; await sendQuestion(question); });
for (const button of document.querySelectorAll('.quick-actions button')) {
  button.addEventListener('click', () => sendQuestion(button.dataset.prompt, button.dataset.task));
}
$('imageInput').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  state.selectedImage = await readAsDataUrl(file);
  state.selectedImageLabel = file.name;
  $('imageStatus').textContent = file.name;
  updateContextChips();
});
setupCropSelection();
updateContextChips();
loadLibrary().catch((error) => showToast(error.message));

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
