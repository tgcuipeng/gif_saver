import { Base64Wasm, Memory, base64_encode_padded } from './node_modules/@hazae41/base64.wasm/dist/esm/node/index.mjs';

const MAX_CONCURRENT_DOWNLOADS = 5;
const MAX_CONCURRENT_ENCODINGS = 1;
/** WASM Base64 分块编码，避免超大缓冲区一次性编码失败（必须是 3 的倍数） */
const WASM_BASE64_CHUNK_BYTES = 3 * 1024 * 1024;
const EXPORT_DB_NAME = 'singlehtml_export_db';
const EXPORT_STORE_NAME = 'pending_exports';
const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const EXPORT_RECORD_MAX_AGE_MS = 60 * 60 * 1000;
const HTTP_URL_REGEXP = /^https?:\/\//i;
const TASK_CANCELED_ERROR = 'TASK_CANCELED';
const SUPPORTED_FORMATS = ['gif', 'jpg', 'png', 'webp'];
const MIME_TO_FORMAT = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp'
};
const FORMAT_TO_MIME = {
  gif: 'image/gif',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp'
};
const ACTIVE_TASKS = new Map();
/** 同一 tab 重复点「保存」时，取消上一任务，避免状态与浮层 taskId 错乱 */
const TAB_CURRENT_TASK = new Map();
/** 页面浮层更新节流（毫秒），减轻 executeScript 频率 */
const OVERLAY_THROTTLE_MS = 1500;
const overlayLastShownAt = new Map();
let wasmInitPromise = null;
let encodingQueueTail = Promise.resolve();
let activeEncodingCount = 0;
const DOWNLOAD_EXPORT_CLEANUPS = new Map();

// Service worker 唤醒时主动清理一轮过期导出缓存，缩短异常残留时间。
pruneExpiredExportRecords().catch(() => {
  // ignore cleanup errors on startup
});

chrome.downloads.onChanged.addListener((delta) => {
  const id = Number(delta?.id);
  if (!Number.isInteger(id)) {
    return;
  }
  if (!delta?.state?.current) {
    return;
  }
  if (delta.state.current !== 'complete' && delta.state.current !== 'interrupted') {
    return;
  }
  const exportId = DOWNLOAD_EXPORT_CLEANUPS.get(id);
  if (!exportId) {
    return;
  }
  DOWNLOAD_EXPORT_CLEANUPS.delete(id);
  deletePendingExportBlob(exportId).catch(() => {
    // ignore cleanup errors
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'cancel-export-task') {
    const taskId = String(message?.taskId || '');
    if (taskId) {
      cancelTask(taskId);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type !== 'export-gifs') {
    return false;
  }

  const taskId = createTaskId();
  const targetTabId = Number(message?.tabId);
  if (Number.isInteger(targetTabId)) {
    const prevTaskId = TAB_CURRENT_TASK.get(targetTabId);
    if (prevTaskId) {
      cancelTask(prevTaskId);
    }
    TAB_CURRENT_TASK.set(targetTabId, taskId);
  }

  const taskContext = createTaskContext(taskId);
  handleExportRequest({ ...message, taskId }, taskContext)
    .then(async (result) => {
      if (Number.isInteger(targetTabId)) {
        const extra =
          result.skippedOverLimit > 0 ? `，另有 ${result.skippedOverLimit} 个超出单次上限未处理` : '';
        await showTaskOverlay(targetTabId, {
          taskId,
          status: 'success',
          text: `下载完成 ${result.embeddedCount}/${result.matchedCount} 个图片，失败 ${result.failedCount} 个${extra}`
        });
      }
      sendResponse({ ok: true, ...result });
    })
    .catch(async (error) => {
      if (error?.message === TASK_CANCELED_ERROR) {
        sendResponse({
          ok: false,
          error: '任务已中断（已关闭页面上的进度条）。'
        });
        return;
      }
      if (Number.isInteger(targetTabId)) {
        const failText =
          error?.message === 'SAVE_DIALOG_CANCELED'
            ? '未保存文件：已在系统保存对话框中取消。'
            : `下载失败：${error?.message || String(error)}`;
        const failDetail = buildErrorDetail(error);
        await showTaskOverlay(targetTabId, {
          taskId,
          status: 'error',
          text: failText,
          detail: failDetail
        });
      }
      sendResponse({
        ok: false,
        error: error?.message || String(error)
      });
    })
    .finally(() => {
      ACTIVE_TASKS.delete(taskId);
      if (Number.isInteger(targetTabId) && TAB_CURRENT_TASK.get(targetTabId) === taskId) {
        TAB_CURRENT_TASK.delete(targetTabId);
      }
    });

  return true;
});

async function handleExportRequest(message, taskContext) {
  const outputFileName = message?.outputFileName || '';
  const askUserForPath = Boolean(message?.askUserForPath);
  const tabId = Number(message?.tabId);
  const candidates = Array.isArray(message?.candidates) ? message.candidates : null;
  const selectedFormats = normalizeFormats(message?.selectedFormats);
  const minSizeEnabled = Boolean(message?.minSizeEnabled);
  const minSizeKB = normalizeMinSizeKB(message?.minSizeKB);
  const layoutColumns = normalizeLayoutColumns(message?.layoutColumns);
  const minSizeBytes = minSizeEnabled ? minSizeKB * 1024 : 0;
  const maxImageCount = normalizeMaxImageCount(message?.maxImageCount);
  const maxSingleImageKB = normalizeMaxSingleImageKB(message?.maxSingleImageKB);
  const maxSingleBytes = maxSingleImageKB > 0 ? maxSingleImageKB * 1024 : 0;

  if (!outputFileName) {
    throw new Error('文件名为空。');
  }
  if (Number.isInteger(tabId)) {
    overlayLastShownAt.delete(tabId);
    await showTaskOverlay(tabId, {
      taskId: message.taskId,
      status: 'running',
      text: '正在下载 0/0 个图片，失败 0 个'
    });
  }

  throwIfCancelled(taskContext);
  const sourceCandidates =
    candidates || (Number.isInteger(tabId) ? await collectCandidatesFromTab(tabId) : []);
  const normalizedCandidates = Array.from(
    new Set(
      sourceCandidates
        .map((url) => String(url || '').trim())
        .filter((url) => HTTP_URL_REGEXP.test(url))
    )
  );

  throwIfCancelled(taskContext);
  let matchedCount = 0;
  let truncatedForLimit = 0;
  if (Number.isInteger(tabId)) {
    await showTaskOverlay(tabId, {
      taskId: message.taskId,
      status: 'running',
      text: `正在扫描 0/${normalizedCandidates.length} 个链接，命中 0 个，失败 0 个`
    });
  }
  const matchedEntries = [];
  const urlTaskCache = new Map();
  let scannedCount = 0;
  let matchedFoundCount = 0;
  const progressStep = 10;

  await runWithConcurrency(normalizedCandidates, MAX_CONCURRENT_DOWNLOADS, async (url, currentIndex) => {
    if (taskContext?.canceled) {
      return;
    }
    const result = await getOrCreateTaskCache(urlTaskCache, url, () =>
      fetchMatchedImageAsDataUrl(url, selectedFormats, minSizeBytes, maxSingleBytes, taskContext)
    );

    scannedCount += 1;
    if (result?.matched) {
      matchedFoundCount += 1;
      matchedEntries.push({
        domIndex: currentIndex,
        sourceUrl: url,
        format: result.format || null,
        embed: result.embed || null
      });
    }

    if (
      Number.isInteger(tabId) &&
      (scannedCount === normalizedCandidates.length || scannedCount % progressStep === 0)
    ) {
      const cappedMatched = Math.min(matchedFoundCount, maxImageCount);
      const liveSorted = matchedEntries.slice().sort((a, b) => a.domIndex - b.domIndex);
      const liveSelected = liveSorted.slice(0, maxImageCount);
      const liveFailed = liveSelected.filter((entry) => !entry.embed).length;
      const liveTruncated = Math.max(0, matchedFoundCount - maxImageCount);
      const extra = liveTruncated > 0 ? `（已忽略超出 ${liveTruncated} 个）` : '';
      await showTaskOverlay(tabId, {
        taskId: message.taskId,
        status: 'running',
        text: `正在扫描 ${scannedCount}/${normalizedCandidates.length} 个链接，命中 ${cappedMatched} 个，失败 ${liveFailed} 个${extra}`
      });
    }
  });

  throwIfCancelled(taskContext);
  matchedEntries.sort((a, b) => a.domIndex - b.domIndex);
  const selectedMatchedEntries = matchedEntries.slice(0, maxImageCount);
  matchedCount = selectedMatchedEntries.length;
  truncatedForLimit = Math.max(0, matchedEntries.length - maxImageCount);
  const failedEmbeds = selectedMatchedEntries.filter((entry) => !entry.embed).map((entry) => entry.sourceUrl);
  const embedRecords = selectedMatchedEntries
    .filter((entry) => Boolean(entry.embed))
    .map((entry, imageIndex) => {
      const ext = entry.format === 'jpg' ? 'jpg' : entry.format;
      return {
        filename: `img_${String(imageIndex + 1).padStart(3, '0')}.${ext}`,
        sourceUrl: entry.sourceUrl,
        dataUrl: entry.embed.dataUrl,
        fileSize: entry.embed.byteLength,
        index: imageIndex
      };
    });
  embedRecords.sort((a, b) => a.index - b.index);
  const finalRecords = embedRecords.map(({ filename, sourceUrl, dataUrl, fileSize }) => ({
    filename,
    sourceUrl,
    dataUrl,
    fileSize
  }));

  const htmlText = buildPreviewHtml(finalRecords, layoutColumns);
  const htmlBytes = new TextEncoder().encode(htmlText);
  const approxB64Len = Math.ceil((htmlBytes.length * 4) / 3) + 64;
  if (approxB64Len > 500 * 1024 * 1024) {
    throw new Error(
      '导出体积过大（内嵌图片过多或单张过大）。请缩小范围：减少格式勾选、提高「大于 K」阈值，或分多次导出。'
    );
  }
  if (Number.isInteger(tabId)) {
    await showTaskOverlay(tabId, {
      taskId: message.taskId,
      status: 'running',
      text: `正在下载 ${matchedCount}/${matchedCount} 个图片，失败 ${failedEmbeds.length} 个`
    });
  }
  throwIfCancelled(taskContext);
  const downloadResult = await safeDownloadHtmlWithBlobOffscreen(
    htmlText,
    outputFileName,
    askUserForPath
  );

  if (!downloadResult.ok) {
    if (downloadResult.canceled) {
      throw new Error('SAVE_DIALOG_CANCELED');
    }
    throw new Error(downloadResult.error || '导出文件生成失败，请检查下载权限或文件名。');
  }

  return {
    outputFileName,
    matchedCount,
    embeddedCount: finalRecords.length,
    failedCount: failedEmbeds.length,
    skippedOverLimit: truncatedForLimit
  };
}

function createTaskId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createTaskContext(taskId) {
  const context = {
    taskId,
    canceled: false,
    controllers: new Set()
  };
  ACTIVE_TASKS.set(taskId, context);
  return context;
}

function cancelTask(taskId) {
  const task = ACTIVE_TASKS.get(taskId);
  if (!task) {
    return;
  }
  task.canceled = true;
  task.controllers.forEach((controller) => {
    try {
      controller.abort();
    } catch {
      // ignore
    }
  });
  task.controllers.clear();
}

function throwIfCancelled(taskContext) {
  if (taskContext?.canceled) {
    throw new Error(TASK_CANCELED_ERROR);
  }
}

async function showTaskOverlay(tabId, payload) {
  try {
    const status = payload?.status || 'running';
    if (status === 'running') {
      const now = Date.now();
      const last = overlayLastShownAt.get(tabId) || 0;
      if (now - last < OVERLAY_THROTTLE_MS) {
        return;
      }
      overlayLastShownAt.set(tabId, now);
    } else {
      overlayLastShownAt.delete(tabId);
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      func: renderTaskOverlayInPage,
      args: [payload]
    });
  } catch {
    // Ignore pages where script injection is not allowed.
  }
}

function renderTaskOverlayInPage(payload) {
  const overlayId = '__img_export_task_overlay__';
  let root = document.getElementById(overlayId);
  if (!root) {
    root = document.createElement('div');
    root.id = overlayId;
    root.style.position = 'fixed';
    root.style.top = '16px';
    root.style.right = '16px';
    root.style.zIndex = '2147483647';
    root.style.padding = '10px 12px';
    root.style.maxWidth = '420px';
    root.style.borderRadius = '999px';
    root.style.background = 'rgba(0,0,0,0.8)';
    root.style.color = '#fff';
    root.style.fontSize = '12px';
    root.style.lineHeight = '1.2';
    root.style.fontFamily = 'Arial, sans-serif';
    root.style.boxShadow = '0 4px 12px rgba(0,0,0,0.3)';
    root.style.whiteSpace = 'nowrap';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.gap = '8px';
    root.style.pointerEvents = 'auto';
    root.style.userSelect = 'none';

    const textEl = document.createElement('span');
    textEl.id = `${overlayId}__text`;
    textEl.style.flex = '1';
    textEl.style.overflow = 'hidden';
    textEl.style.textOverflow = 'ellipsis';
    root.appendChild(textEl);

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = 'x';
    closeBtn.setAttribute('aria-label', '关闭进度提示');
    closeBtn.style.border = 'none';
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = '#fff';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.fontSize = '12px';
    closeBtn.style.lineHeight = '1';
    closeBtn.style.padding = '0';
    closeBtn.style.margin = '0';
    closeBtn.style.opacity = '0.8';
    closeBtn.style.pointerEvents = 'auto';
    closeBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      const taskId = root?.dataset?.taskId || '';
      if (taskId) {
        try {
          chrome.runtime.sendMessage({ type: 'cancel-export-task', taskId });
        } catch {
          // ignore
        }
      }
      root?.remove();
    });
    root.appendChild(closeBtn);

    document.documentElement.appendChild(root);
  }

  const status = payload?.status || 'running';
  const text = String(payload?.text || '');
  const detail = String(payload?.detail || '');
  root.dataset.taskId = String(payload?.taskId || '');
  root.dataset.status = status;
  root.dataset.detail = detail;
  root.dataset.summary = text;
  if (status === 'success') {
    root.style.background = 'rgba(12, 125, 71, 0.92)';
    root.style.cursor = 'default';
    root.title = '';
  } else if (status === 'error') {
    root.style.background = 'rgba(176, 39, 39, 0.92)';
    root.style.cursor = 'pointer';
    root.title = '点击查看失败详情';
  } else {
    root.style.background = 'rgba(0,0,0,0.8)';
    root.style.cursor = 'default';
    root.title = '';
  }

  if (!root.dataset.bindDetailClick) {
    root.dataset.bindDetailClick = '1';
    root.addEventListener('click', () => {
      if (root?.dataset?.status !== 'error') {
        return;
      }
      const detailText = root?.dataset?.detail || root?.dataset?.summary || '未知错误';
      try {
        alert(`失败详情：\n\n${detailText}`);
      } catch {
        // ignore
      }
    });
  }

  const textEl = document.getElementById(`${overlayId}__text`);
  if (textEl) {
    textEl.textContent = text;
  }

  if (status === 'success') {
    setTimeout(() => {
      const existing = document.getElementById(overlayId);
      if (existing) {
        existing.remove();
      }
    }, 4000);
  }
}

function buildErrorDetail(error) {
  try {
    if (!error) {
      return '未知错误（error 为空）';
    }
    const message = error?.message || String(error);
    const stack = typeof error?.stack === 'string' ? error.stack : '';
    return stack ? `${message}\n\n${stack}` : message;
  } catch {
    return String(error);
  }
}

async function collectCandidatesFromTab(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: collectCandidateUrlsInPage
  });
  return Array.isArray(result?.result) ? result.result : [];
}

function collectCandidateUrlsInPage() {
  const collected = new Set();
  const srcsetSeparator = /\s*,\s*/;
  const canUse = (url) => /^https?:\/\//i.test(url);

  const addCandidate = (url) => {
    if (!url) {
      return;
    }

    try {
      const absUrl = new URL(url, window.location.href).href;
      if (canUse(absUrl)) {
        collected.add(absUrl);
      }
    } catch {
      // Ignore invalid URLs.
    }
  };

  const addFromSrcSet = (srcsetValue) => {
    if (!srcsetValue) {
      return;
    }
    srcsetValue
      .split(srcsetSeparator)
      .map((item) => item.trim().split(/\s+/)[0])
      .forEach((url) => addCandidate(url));
  };

  document.querySelectorAll('img, source').forEach((node) => {
    addCandidate(node.src);
    addCandidate(node.getAttribute('data-src'));
    addCandidate(node.getAttribute('data-original'));
    addCandidate(node.getAttribute('data-lazy-src'));
    addCandidate(node.getAttribute('data-gif'));
    addFromSrcSet(node.srcset);
    addFromSrcSet(node.getAttribute('srcset'));
    addFromSrcSet(node.getAttribute('data-srcset'));
  });

  document.querySelectorAll('a[href]').forEach((a) => addCandidate(a.href));

  document.querySelectorAll('[style]').forEach((node) => {
    const style = node.getAttribute('style') || '';
    const matches = style.match(/url\((['"]?)(.*?)\1\)/gi) || [];
    matches.forEach((chunk) => {
      const url = chunk.replace(/^url\((['"]?)/i, '').replace(/(['"]?)\)$/i, '');
      addCandidate(url);
    });
  });

  return Array.from(collected);
}

function getOrCreateTaskCache(cacheMap, key, loader) {
  if (cacheMap.has(key)) {
    return cacheMap.get(key);
  }
  const pending = Promise.resolve()
    .then(loader)
    .catch(() => ({ matched: false, format: null, embed: null }));
  cacheMap.set(key, pending);
  return pending;
}

async function fetchMatchedImageAsDataUrl(
  url,
  selectedFormats,
  minSizeBytes,
  maxSingleBytes,
  taskContext
) {
  const byExt = detectFormatByExtension(url);
  if (byExt && !selectedFormats.includes(byExt)) {
    return { matched: false, format: null, embed: null };
  }

  try {
    if (taskContext?.canceled) {
      return { matched: false, format: null, embed: null };
    }
    const response = await fetchWithTimeout(
      url,
      {
        method: 'GET',
        redirect: 'follow'
      },
      300_000,
      taskContext
    );
    if (response.status === 499) {
      return { matched: false, format: null, embed: null };
    }
    if (!response.ok) {
      if (byExt && selectedFormats.includes(byExt)) {
        return { matched: true, format: byExt, embed: null };
      }
      return { matched: false, format: null, embed: null };
    }

    const bytes = await response.arrayBuffer();
    const u8 = new Uint8Array(bytes);
    const contentType = normalizeMimeType(response.headers.get('content-type'));
    const byType = MIME_TO_FORMAT[contentType];
    const byMagic = detectFormatByMagic(u8);
    const format = byType || byMagic || byExt;
    if (!format || !selectedFormats.includes(format)) {
      return { matched: false, format: null, embed: null };
    }

    if (minSizeBytes > 0 && bytes.byteLength <= minSizeBytes) {
      return { matched: true, format, embed: null };
    }
    if (maxSingleBytes > 0 && bytes.byteLength > maxSingleBytes) {
      return { matched: true, format, embed: null };
    }

    const mimeType = FORMAT_TO_MIME[format] || contentType || 'application/octet-stream';
    return {
      matched: true,
      format,
      embed: {
        byteLength: bytes.byteLength,
        dataUrl: `data:${mimeType};base64,${await encodeArrayBufferToBase64(bytes)}`
      }
    };
  } catch {
    if (taskContext?.canceled) {
      return { matched: false, format: null, embed: null };
    }
    if (byExt && selectedFormats.includes(byExt)) {
      return { matched: true, format: byExt, embed: null };
    }
    return { matched: false, format: null, embed: null };
  }
}

function detectFormatByExtension(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.gif')) return 'gif';
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'jpg';
    if (pathname.endsWith('.png')) return 'png';
    if (pathname.endsWith('.webp')) return 'webp';
  } catch {
    return null;
  }
  return null;
}

function detectFormatByMagic(bytes) {
  if (bytes.length >= 6) {
    const h0 = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (h0 === 'GIF87a' || h0 === 'GIF89a') {
      return 'gif';
    }
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpg';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) === 'RIFF' &&
    String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

function normalizeMimeType(contentType) {
  if (!contentType) {
    return '';
  }
  return String(contentType).split(';')[0].trim().toLowerCase();
}

function normalizeFormats(raw) {
  if (!Array.isArray(raw)) {
    return ['gif'];
  }
  const formats = raw.filter((fmt) => SUPPORTED_FORMATS.includes(fmt));
  return formats.length ? formats : ['gif'];
}

function normalizeMinSizeKB(value) {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 1) {
    return 200;
  }
  return Math.min(num, 1024 * 300);
}

function normalizeLayoutColumns(value) {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 1) {
    return 1;
  }
  return Math.min(num, 4);
}

function normalizeMaxImageCount(value) {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 1) {
    return 250;
  }
  return Math.min(num, 2000);
}

function normalizeMaxSingleImageKB(value) {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 0) {
    return 5120;
  }
  if (num === 0) {
    return 0;
  }
  return Math.min(num, 512 * 1024);
}

async function fetchWithTimeout(url, init, timeoutMs, taskContext) {
  if (taskContext?.canceled) {
    return new Response(null, { status: 499, statusText: 'Canceled' });
  }
  const controller = new AbortController();
  taskContext?.controllers?.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (taskContext?.canceled) {
      return new Response(null, { status: 499, statusText: 'Canceled' });
    }
    if (error?.name === 'AbortError') {
      return new Response(null, { status: 408, statusText: 'Timeout' });
    }
    throw error;
  } finally {
    clearTimeout(timer);
    taskContext?.controllers?.delete(controller);
  }
}

async function safeDownload(url, filename, askUserForPath = false) {
  try {
    const downloadId = await chrome.downloads.download({
      url,
      filename,
      conflictAction: 'uniquify',
      saveAs: askUserForPath
    });
    return { ok: true, canceled: false, downloadId };
  } catch (error) {
    const msg = error?.message || String(error);
    const canceled = /USER_CANCELED|canceled|cancelled|cancel/i.test(msg);
    return { ok: false, canceled, downloadId: null };
  }
}

async function safeDownloadHtmlWithBlobOffscreen(htmlText, filename, askUserForPath = false) {
  const exportId = `export_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const htmlBlob = new Blob([htmlText], { type: 'text/html;charset=utf-8' });
  await pruneExpiredExportRecords();
  await putPendingExportBlob(exportId, htmlBlob);
  let blobUrl = '';
  try {
    await ensureOffscreenDocumentReady();
    const blobResp = await chrome.runtime.sendMessage({
      type: 'create-export-blob-url',
      target: 'offscreen',
      exportId
    });
    if (!blobResp?.ok || !blobResp?.blobUrl) {
      return {
        ok: false,
        canceled: false,
        error: blobResp?.error || '创建 Blob 下载地址失败。'
      };
    }
    blobUrl = String(blobResp.blobUrl);
    const downloadResult = await safeDownload(blobUrl, filename, askUserForPath);
    if (downloadResult.ok && Number.isInteger(downloadResult.downloadId)) {
      DOWNLOAD_EXPORT_CLEANUPS.set(downloadResult.downloadId, exportId);
    }
    return downloadResult;
  } catch (error) {
    return {
      ok: false,
      canceled: false,
      error: error?.message || String(error)
    };
  } finally {
    if (blobUrl) {
      try {
        await chrome.runtime.sendMessage({
          type: 'revoke-export-blob-url',
          target: 'offscreen',
          blobUrl
        });
      } catch {
        // ignore revoke errors
      }
    }
    try {
      await deletePendingExportBlob(exportId);
    } catch {
      // ignore cleanup errors
    }
  }
}

async function ensureOffscreenDocumentReady() {
  if (!chrome.offscreen) {
    throw new Error('当前浏览器不支持 offscreen 文档能力。');
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [offscreenUrl]
  });
  if (existing.length > 0) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOCUMENT_PATH,
    reasons: ['BLOBS'],
    justification: 'Create blob URL for large HTML export download.'
  });
}

function openExportDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(EXPORT_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EXPORT_STORE_NAME)) {
        db.createObjectStore(EXPORT_STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('打开导出缓存数据库失败。'));
  });
}

async function putPendingExportBlob(id, blob) {
  const db = await openExportDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(EXPORT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(EXPORT_STORE_NAME);
      store.put({
        id,
        blob,
        createdAt: Date.now()
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('写入导出缓存失败。'));
      tx.onabort = () => reject(tx.error || new Error('写入导出缓存被中止。'));
    });
  } finally {
    db.close();
  }
}

async function deletePendingExportBlob(id) {
  const db = await openExportDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(EXPORT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(EXPORT_STORE_NAME);
      store.delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('删除导出缓存失败。'));
      tx.onabort = () => reject(tx.error || new Error('删除导出缓存被中止。'));
    });
  } finally {
    db.close();
  }
}

async function pruneExpiredExportRecords() {
  const db = await openExportDb();
  try {
    await new Promise((resolve, reject) => {
      const now = Date.now();
      const tx = db.transaction(EXPORT_STORE_NAME, 'readwrite');
      const store = tx.objectStore(EXPORT_STORE_NAME);
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          return;
        }
        const createdAt = Number(cursor.value?.createdAt || 0);
        if (!createdAt || now - createdAt > EXPORT_RECORD_MAX_AGE_MS) {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('清理导出缓存失败。'));
      tx.onabort = () => reject(tx.error || new Error('清理导出缓存被中止。'));
    });
  } finally {
    db.close();
  }
}

async function ensureWasmEncoderReady() {
  if (!wasmInitPromise) {
    wasmInitPromise = Base64Wasm.initBundled();
  }
  await wasmInitPromise;
}

async function encodeArrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  return enqueueExclusiveEncoding(async () => {
    await ensureWasmEncoderReady();
    try {
      return encodeWithWasmChunked(bytes);
    } catch (error) {
      const msg = error?.message || String(error);
      throw new Error(`WASM_BASE64_ENCODE_FAILED: ${msg}`);
    }
  });
}

function enqueueExclusiveEncoding(task) {
  const startTask = () => Promise.resolve().then(task);
  const runWhenAvailable = () => {
    if (activeEncodingCount < MAX_CONCURRENT_ENCODINGS) {
      activeEncodingCount += 1;
      return startTask().finally(() => {
        activeEncodingCount -= 1;
      });
    }
    return encodingQueueTail.then(runWhenAvailable);
  };
  const pending = runWhenAvailable();
  encodingQueueTail = pending.catch(() => {});
  return pending;
}

function encodeWithWasm(bytes) {
  const memory = new Memory(bytes);
  try {
    return base64_encode_padded(memory);
  } finally {
    if (typeof Symbol.dispose === 'symbol' && typeof memory[Symbol.dispose] === 'function') {
      memory[Symbol.dispose]();
    }
  }
}

function encodeWithWasmChunked(bytes) {
  if (bytes.length <= WASM_BASE64_CHUNK_BYTES) {
    return encodeWithWasm(bytes);
  }
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += WASM_BASE64_CHUNK_BYTES) {
    const end = Math.min(offset + WASM_BASE64_CHUNK_BYTES, bytes.length);
    parts.push(encodeWithWasm(bytes.subarray(offset, end)));
  }
  return parts.join('');
}

async function runWithConcurrency(items, limit, worker) {
  const result = new Array(items.length);
  let nextIndex = 0;
  let runningCount = 0;
  let aborted = false;

  return new Promise((resolve, reject) => {
    const launchNext = () => {
      if (aborted) {
        return;
      }
      if (nextIndex >= items.length && runningCount === 0) {
        resolve(result);
        return;
      }

      while (runningCount < limit && nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        runningCount += 1;

        Promise.resolve(worker(items[currentIndex], currentIndex))
          .then((value) => {
            result[currentIndex] = value;
          })
          .catch((error) => {
            if (!aborted) {
              aborted = true;
              reject(error);
            }
          })
          .finally(() => {
            runningCount -= 1;
            if (!aborted) {
              launchNext();
            }
          });
      }
    };

    launchNext();
  });
}

function buildPreviewHtml(records, layoutColumns) {
  const imageHtml = records
    .map(
      (record) => `
      <div class="img-cell">
        <img src="${record.dataUrl}" alt="${escapeHtml(record.filename)}" loading="lazy">
      </div>
    `
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title></title>
  <style>
    body {
      margin: 0;
      padding: 12px;
      background: #fff;
    }
    .img-grid {
      display: grid;
      grid-template-columns: repeat(${layoutColumns}, minmax(0, 1fr));
      gap: 12px;
      align-items: start;
    }
    .img-cell {
      width: 100%;
    }
    .img-cell img {
      display: block;
      max-width: 100%;
      height: auto;
    }
  </style>
</head>
<body>
  <div class="img-grid">
    ${imageHtml}
  </div>
</body>
</html>`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
