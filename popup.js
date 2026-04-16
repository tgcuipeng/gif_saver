const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const minSizeEnabledEl = document.getElementById('minSizeEnabled');
const minSizeInputEl = document.getElementById('minSizeInput');
const maxCountInputEl = document.getElementById('maxCountInput');
const maxSingleKBInputEl = document.getElementById('maxSingleKBInput');
const columnRadios = [
  document.getElementById('col_1'),
  document.getElementById('col_2'),
  document.getElementById('col_3'),
  document.getElementById('col_4')
];
const formatCheckboxes = {
  gif: document.getElementById('fmt_gif'),
  jpg: document.getElementById('fmt_jpg'),
  png: document.getElementById('fmt_png'),
  webp: document.getElementById('fmt_webp')
};

const SETTINGS_KEY = 'exportOptionsV1';
const SUPPORTED_FORMATS = ['gif', 'jpg', 'png', 'webp'];
const DEFAULT_SETTINGS = {
  formats: ['gif'],
  minSizeEnabled: true,
  minSizeKB: 200,
  layoutColumns: 1,
  maxImageCount: 250,
  maxSingleImageMB: 5
};

init().catch((error) => {
  setBusy(false, `初始化失败：${humanizeErrorMessage(error)}`);
});

saveBtn.addEventListener('click', async () => {
  const options = collectCurrentOptions();
  if (!options.formats.length) {
    setBusy(false, '请至少勾选一个图片格式。');
    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      throw new Error('未找到当前标签页。');
    }
    const defaultFileName = buildDefaultFileNameByTitle(tab.title);
    const minText = options.minSizeEnabled ? `${options.minSizeKB}K` : '未启用';
    setBusy(
      true,
      `任务已提交，后台将按格式(${options.formats.join('/')})和大小阈值(${minText})处理...`
    );

    const response = await chrome.runtime.sendMessage({
      type: 'export-gifs',
      tabId: tab.id,
      outputFileName: defaultFileName,
      askUserForPath: true,
      selectedFormats: options.formats,
      minSizeEnabled: options.minSizeEnabled,
      minSizeKB: options.minSizeKB,
      layoutColumns: options.layoutColumns,
      maxImageCount: options.maxImageCount,
      maxSingleImageKB: options.maxSingleImageMB > 0 ? mbToKb(options.maxSingleImageMB) : 0
    });

    if (!response?.ok) {
      throw new Error(response?.error || '后台处理失败。');
    }

    const {
      outputFileName: finalFileName,
      matchedCount = 0,
      embeddedCount = 0,
      failedCount = 0,
      skippedOverLimit = 0
    } = response;

    const limitHint =
      skippedOverLimit > 0 ? `\n另有 ${skippedOverLimit} 张超出单次处理上限，未纳入本次导出。` : '';
    setBusy(
      false,
      `完成：命中 ${matchedCount} 个，内嵌成功 ${embeddedCount} 个，失败 ${failedCount} 个。\n已保存 ${finalFileName}${limitHint}`
    );
  } catch (error) {
    setBusy(false, `执行失败：${humanizeErrorMessage(error)}`);
  }
});

async function init() {
  const saved = await loadOptions();
  applyOptionsToUi(saved);
  bindOptionEvents();
  setBusy(false, '准备就绪');
}

function bindOptionEvents() {
  Object.values(formatCheckboxes).forEach((checkbox) => {
    checkbox.addEventListener('change', async () => {
      if (!getSelectedFormats().length) {
        formatCheckboxes.gif.checked = true;
      }
      await persistCurrentOptions();
    });
  });

  minSizeEnabledEl.addEventListener('change', async () => {
    minSizeInputEl.disabled = !minSizeEnabledEl.checked;
    await persistCurrentOptions();
  });

  minSizeInputEl.addEventListener('change', async () => {
    minSizeInputEl.value = String(normalizeMinSizeKB(minSizeInputEl.value));
    await persistCurrentOptions();
  });

  let minSizePersistTimer = null;
  minSizeInputEl.addEventListener('input', () => {
    if (minSizePersistTimer) {
      clearTimeout(minSizePersistTimer);
    }
    minSizePersistTimer = setTimeout(async () => {
      minSizeInputEl.value = String(normalizeMinSizeKB(minSizeInputEl.value));
      await persistCurrentOptions();
    }, 400);
  });

  columnRadios.forEach((radio) => {
    radio.addEventListener('change', async () => {
      await persistCurrentOptions();
    });
  });

  const debouncePersist = (normalizeFn, inputEl) => {
    let timer = null;
    inputEl.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(async () => {
        inputEl.value = String(normalizeFn(inputEl.value));
        await persistCurrentOptions();
      }, 400);
    });
  };
  debouncePersist(normalizeMaxImageCount, maxCountInputEl);
  debouncePersist(normalizeMaxSingleImageMB, maxSingleKBInputEl);

  maxCountInputEl.addEventListener('change', async () => {
    maxCountInputEl.value = String(normalizeMaxImageCount(maxCountInputEl.value));
    await persistCurrentOptions();
  });
  maxSingleKBInputEl.addEventListener('change', async () => {
    maxSingleKBInputEl.value = String(normalizeMaxSingleImageMB(maxSingleKBInputEl.value));
    await persistCurrentOptions();
  });
}

function collectCurrentOptions() {
  return {
    formats: getSelectedFormats(),
    minSizeEnabled: minSizeEnabledEl.checked,
    minSizeKB: normalizeMinSizeKB(minSizeInputEl.value),
    layoutColumns: getSelectedLayoutColumns(),
    maxImageCount: normalizeMaxImageCount(maxCountInputEl.value),
    maxSingleImageMB: normalizeMaxSingleImageMB(maxSingleKBInputEl.value)
  };
}

function getSelectedFormats() {
  return SUPPORTED_FORMATS.filter((fmt) => formatCheckboxes[fmt].checked);
}

function applyOptionsToUi(options) {
  const formats = Array.isArray(options.formats) ? options.formats : DEFAULT_SETTINGS.formats;
  SUPPORTED_FORMATS.forEach((fmt) => {
    formatCheckboxes[fmt].checked = formats.includes(fmt);
  });

  if (!getSelectedFormats().length) {
    formatCheckboxes.gif.checked = true;
  }

  minSizeEnabledEl.checked = Boolean(options.minSizeEnabled);
  minSizeInputEl.value = String(normalizeMinSizeKB(options.minSizeKB));
  minSizeInputEl.disabled = !minSizeEnabledEl.checked;

  const columns = normalizeLayoutColumns(options.layoutColumns);
  const targetId = `col_${columns}`;
  columnRadios.forEach((radio) => {
    radio.checked = radio.id === targetId;
  });

  maxCountInputEl.value = String(normalizeMaxImageCount(options.maxImageCount));
  maxSingleKBInputEl.value = String(normalizeMaxSingleImageMB(options.maxSingleImageMB));
}

async function persistCurrentOptions() {
  const options = collectCurrentOptions();
  await chrome.storage.local.set({ [SETTINGS_KEY]: options });
}

async function loadOptions() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = stored?.[SETTINGS_KEY] || {};
  const formats = Array.isArray(raw.formats)
    ? raw.formats.filter((fmt) => SUPPORTED_FORMATS.includes(fmt))
    : DEFAULT_SETTINGS.formats;
  return {
    formats: formats.length ? formats : DEFAULT_SETTINGS.formats,
    minSizeEnabled:
      typeof raw.minSizeEnabled === 'boolean' ? raw.minSizeEnabled : DEFAULT_SETTINGS.minSizeEnabled,
    minSizeKB: normalizeMinSizeKB(raw.minSizeKB ?? DEFAULT_SETTINGS.minSizeKB),
    layoutColumns: normalizeLayoutColumns(raw.layoutColumns ?? DEFAULT_SETTINGS.layoutColumns),
    maxImageCount: normalizeMaxImageCount(raw.maxImageCount ?? DEFAULT_SETTINGS.maxImageCount),
    maxSingleImageMB: normalizeMaxSingleImageMB(
      raw.maxSingleImageMB ?? DEFAULT_SETTINGS.maxSingleImageMB
    )
  };
}

function normalizeMinSizeKB(value) {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 1) {
    return DEFAULT_SETTINGS.minSizeKB;
  }
  return Math.min(num, 1024 * 300);
}

function getSelectedLayoutColumns() {
  const selected = columnRadios.find((radio) => radio.checked);
  return normalizeLayoutColumns(selected?.value ?? 1);
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
    return DEFAULT_SETTINGS.maxImageCount;
  }
  return Math.min(num, 2000);
}

/** 0 = 不限制单张大小；否则为 MB 上限 */
function normalizeMaxSingleImageMB(value) {
  const num = Number.parseInt(String(value), 10);
  if (Number.isNaN(num) || num < 0) {
    return DEFAULT_SETTINGS.maxSingleImageMB;
  }
  if (num === 0) {
    return 0;
  }
  return Math.min(num, 512);
}

function mbToKb(mb) {
  const num = Number.parseInt(String(mb), 10);
  if (Number.isNaN(num) || num <= 0) {
    return 0;
  }
  return num * 1024;
}

function setBusy(busy, message) {
  saveBtn.disabled = busy;
  minSizeEnabledEl.disabled = busy;
  minSizeInputEl.disabled = busy || !minSizeEnabledEl.checked;
  maxCountInputEl.disabled = busy;
  maxSingleKBInputEl.disabled = busy;
  Object.values(formatCheckboxes).forEach((checkbox) => {
    checkbox.disabled = busy;
  });
  columnRadios.forEach((radio) => {
    radio.disabled = busy;
  });
  statusEl.textContent = message;
}

function createTimestamp() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

function buildDefaultFileNameByTitle(title) {
  const cleaned = String(title || '')
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/\.+$/g, '')
    .slice(0, 80);
  if (!cleaned) {
    return `image_export_${createTimestamp()}.html`;
  }
  return `${cleaned}.html`;
}

function humanizeErrorMessage(error) {
  const raw = error?.message || String(error);
  if (/SAVE_DIALOG_CANCELED/i.test(raw)) {
    return '未保存文件：你在系统「另存为」对话框中点了取消。网络抓取任务已结束，可重新点击保存再试。';
  }
  if (/任务已中断|TASK_CANCELED/i.test(raw)) {
    return raw;
  }
  if (/User canceled|USER_CANCELED|cancelled|canceled/i.test(raw)) {
    return '操作已取消。';
  }
  if (/Cannot access|chrome:\/\/|edge:\/\/|about:|moz-extension/i.test(raw)) {
    return '当前页面受浏览器安全限制（如 chrome:// 页面），无法抓取资源。';
  }
  if (/Missing host permission/i.test(raw)) {
    return '缺少页面访问权限，请刷新页面后重试。';
  }
  return raw;
}