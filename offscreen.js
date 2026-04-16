const EXPORT_DB_NAME = 'singlehtml_export_db';
const EXPORT_STORE_NAME = 'pending_exports';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') {
    return false;
  }

  if (message?.type === 'create-export-blob-url') {
    (async () => {
      const exportId = String(message?.exportId || '');
      if (!exportId) {
        throw new Error('无效的导出标识。');
      }
      const blob = await getPendingExportBlob(exportId);
      if (!blob) {
        throw new Error('临时导出内容不存在或已过期。');
      }
      const blobUrl = URL.createObjectURL(blob);
      sendResponse({ ok: true, blobUrl });
    })().catch((error) => {
      sendResponse({
        ok: false,
        error: error?.message || String(error)
      });
    });
    return true;
  }

  if (message?.type === 'revoke-export-blob-url') {
    const blobUrl = String(message?.blobUrl || '');
    if (blobUrl) {
      try {
        URL.revokeObjectURL(blobUrl);
      } catch {
        // ignore
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

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

async function getPendingExportBlob(id) {
  const db = await openExportDb();
  try {
    const record = await new Promise((resolve, reject) => {
      const tx = db.transaction(EXPORT_STORE_NAME, 'readonly');
      const store = tx.objectStore(EXPORT_STORE_NAME);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('读取导出缓存失败。'));
    });
    return record?.blob || null;
  } finally {
    db.close();
  }
}
