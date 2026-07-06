// AdaptiveTranslation Popup 0.9.1

const $ = (sel) => document.querySelector(sel);
const API_CONFIG_KEYS = ['apiKey', 'baseUrl', 'model', 'serviceProvider', 'providerConfigs'];

let hasApiKey = false;
let statusTimer = null;
let currentPageStatus = null;
let toggleBtnBusy = false;

function isUnsupportedTabUrl(url) {
  return /^(chrome|edge|about|extension|chrome-extension):\/\//.test(String(url || ''));
}

function getMessageFailureText(result) {
  if (result?.error) return String(result.error).slice(0, 90);
  const lastError = chrome.runtime.lastError?.message || '';
  if (/Receiving end does not exist|Could not establish connection/i.test(lastError)) {
    return '当前页面尚未加载标注脚本，请刷新页面后重试';
  }
  return '当前页面无法标注，请刷新后重试';
}

function hasUsableApiConfig(data = {}) {
  if (data.apiKey) return true;
  const configs = data.providerConfigs || {};
  const provider = data.serviceProvider;
  if (provider && configs[provider]?.apiKey) return true;
  return Object.values(configs).some(config => config && config.apiKey);
}

// ===== 初始化 =====

chrome.storage.local.get([...API_CONFIG_KEYS, 'level', 'paragraphTranslationMode', 'scanMode', 'fontSize', 'autoTranslate', 'translationColor', 'vocabulary'], (data) => {
  hasApiKey = hasUsableApiConfig(data);
  syncPopupView(data);
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  let shouldSyncView = false;

  if (changes.apiKey || changes.providerConfigs || changes.serviceProvider) {
    shouldSyncView = true;
  }

  // 实时更新控制面板
  if (changes.level) updateLevelBadge(changes.level.newValue || 'L3');
  if (changes.paragraphTranslationMode) {
    const toggle = $('#toggle-paragraph');
    if (toggle) toggle.checked = changes.paragraphTranslationMode.newValue === 'on';
  }
  if (changes.scanMode) {
    const sel = $('#select-scan-mode');
    if (sel) sel.value = changes.scanMode.newValue || 'full';
  }
  if (changes.fontSize) updateFontDisplay(changes.fontSize.newValue || 100);
  if (changes.autoTranslate) {
    const autoToggle = $('#toggle-auto-translate');
    if (autoToggle) autoToggle.checked = Boolean(changes.autoTranslate.newValue);
  }
  if (changes.vocabulary) updateVocabBadge(changes.vocabulary.newValue || []);
  if (changes.translationColor) {
    const picker = $('#color-picker');
    if (picker) picker.value = changes.translationColor.newValue || '#818cf8';
  }

  if (shouldSyncView) {
    chrome.storage.local.get([...API_CONFIG_KEYS, 'level', 'paragraphTranslationMode', 'scanMode', 'fontSize', 'autoTranslate', 'translationColor', 'vocabulary'], syncPopupView);
  }
});

function syncPopupView(data) {
  hasApiKey = hasUsableApiConfig(data);
  if (!hasApiKey) {
    $('#page-setup').style.display = 'flex';
    $('#page-main').style.display = 'none';
    return;
  }

  $('#page-setup').style.display = 'none';
  $('#page-main').style.display = 'flex';

  // 初始化控制面板
  if (data) {
    updateLevelBadge(data.level || 'L3');
    const toggle = $('#toggle-paragraph');
    if (toggle) toggle.checked = (data.paragraphTranslationMode || 'on') === 'on';
    const sel = $('#select-scan-mode');
    if (sel) sel.value = data.scanMode || 'full';
    updateFontDisplay(data.fontSize || 100);
    const autoToggle = $('#toggle-auto-translate');
    if (autoToggle) autoToggle.checked = Boolean(data.autoTranslate);
    const picker = $('#color-picker');
    if (picker) picker.value = data.translationColor || '#818cf8';
    updateVocabBadge(data.vocabulary || []);
  }

  updateToggleBtn();
  refreshPageStatus();
}

// ===== 前往设置 / 齿轮 =====

$('#btn-go-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('#btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// ===== 翻译按钮 =====

$('#btn-toggle').addEventListener('click', () => {
  if (toggleBtnBusy) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      showToast('当前页面不可用');
      return;
    }

    if (isUnsupportedTabUrl(tab.url)) {
      showToast('浏览器内部页面无法标注');
      updateStatusCard(null, tab.url);
      return;
    }

    const shouldStop = isPageTranslating(currentPageStatus);
    setToggleBtnLoading(true);

    chrome.tabs.sendMessage(tab.id, { type: shouldStop ? 'stopPageAnnotating' : 'startPageAnnotating' }, (result) => {
      setToggleBtnLoading(false);

      if (chrome.runtime.lastError || result?.error) {
        const failureText = getMessageFailureText(result);
        showToast(failureText);
        currentPageStatus = { state: 'error', message: failureText, localUntil: Date.now() + 5000 };
        updateStatusCard(currentPageStatus, tab.url);
        return;
      }
      // 持久化翻译开关状态，让新页面也能自动启动
      chrome.storage.local.set({ translationEnabled: !shouldStop });
      showToast(shouldStop ? '已取消翻译' : (isPageActive(currentPageStatus) ? '正在重新翻译' : '已开始翻译当前页'));
      setTimeout(refreshPageStatus, 250);
    });
  });
});

function isPageActive(status) {
  return Boolean(status && status.state && status.state !== 'off');
}

function isPageTranslating(status) {
  return Boolean(status && status.state === 'running');
}

function setToggleBtnLoading(loading) {
  const btn = $('#btn-toggle');
  toggleBtnBusy = loading;
  if (loading) {
    btn.disabled = true;
    btn.classList.add('loading');
    btn.textContent = '处理中…';
  } else {
    btn.disabled = false;
    btn.classList.remove('loading');
    updateToggleBtn();
  }
}

function updateToggleBtn() {
  const btn = $('#btn-toggle');
  btn.classList.remove('active');

  if (isPageTranslating(currentPageStatus)) {
    btn.textContent = '取消翻译';
    btn.classList.add('active');
  } else if (currentPageStatus?.state === 'completed') {
    btn.textContent = '重新翻译';
  } else if (currentPageStatus?.state === 'error') {
    btn.textContent = '重试翻译';
  } else {
    btn.textContent = '翻译当前页';
  }
}

// ===== 等级控制 =====

$('#btn-level-down').addEventListener('click', () => changeLevel(-1));
$('#btn-level-up').addEventListener('click', () => changeLevel(1));

function changeLevel(delta) {
  chrome.storage.local.get(['level'], (data) => {
    const current = parseInt((data.level || 'L3').replace('L', ''), 10);
    const next = Math.max(1, Math.min(5, current + delta));
    if (next === current) return;
    const newLevel = 'L' + next;
    chrome.storage.local.set({ level: newLevel }, () => {
      updateLevelBadge(newLevel);
      showToast('等级已调整为 ' + newLevel);
    });
  });
}

function updateLevelBadge(level) {
  const badge = $('#level-badge');
  if (!badge) return;
  badge.textContent = level || 'L3';
  badge.className = 'level-badge level-' + (level || 'L3');

  const num = parseInt((level || 'L3').replace('L', ''), 10);
  $('#btn-level-down').disabled = num <= 1;
  $('#btn-level-up').disabled = num >= 5;
}

// ===== 段落翻译开关 =====

$('#toggle-paragraph').addEventListener('change', (e) => {
  const mode = e.target.checked ? 'on' : 'off';
  chrome.storage.local.set({ paragraphTranslationMode: mode }, () => {
    showToast(mode === 'on' ? '已开启段落翻译' : '已关闭段落翻译');
  });
});

// ===== 扫描模式 =====

$('#select-scan-mode').addEventListener('change', (e) => {
  const mode = e.target.value;
  chrome.storage.local.set({ scanMode: mode }, () => {
    showToast(mode === 'full' ? '全面翻译模式' : '正文翻译模式');
  });
});

// ===== 连续阅读模式 =====

$('#toggle-auto-translate').addEventListener('change', (e) => {
  const enabled = e.target.checked;
  chrome.storage.local.set({ autoTranslate: enabled }, () => {
    showToast(enabled ? '已开启连续阅读模式' : '已关闭连续阅读模式');
  });
});

// ===== 字号控制 =====

const FONT_MIN = 80;
const FONT_MAX = 130;
const FONT_STEP = 10;

$('#btn-font-down').addEventListener('click', () => changeFontSize(-FONT_STEP));
$('#btn-font-up').addEventListener('click', () => changeFontSize(FONT_STEP));

function changeFontSize(delta) {
  chrome.storage.local.get(['fontSize'], (data) => {
    const current = data.fontSize || 100;
    const next = Math.max(FONT_MIN, Math.min(FONT_MAX, current + delta));
    if (next === current) return;
    chrome.storage.local.set({ fontSize: next }, () => {
      updateFontDisplay(next);
    });
  });
}

function updateFontDisplay(size) {
  const el = $('#font-size-value');
  if (el) el.textContent = size + '%';
  $('#btn-font-down').disabled = size <= FONT_MIN;
  $('#btn-font-up').disabled = size >= FONT_MAX;
}

// ===== 标注颜色 =====

$('#color-picker').addEventListener('input', (e) => {
  chrome.storage.local.set({ translationColor: e.target.value });
});

// ===== 生词本 =====

$('#btn-vocab').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('vocab.html') });
});

function updateVocabBadge(vocab) {
  const btn = $('#btn-vocab');
  const count = Array.isArray(vocab) ? vocab.length : 0;
  if (btn) btn.title = count > 0 ? '生词本（' + count + ' 词）' : '生词本';
}

// ===== 页面状态轮询 =====

function refreshPageStatus() {
  if (!hasApiKey) return;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      updateStatusCard(null);
      return;
    }

    chrome.tabs.sendMessage(tab.id, { type: 'getPageStatus' }, (status) => {
      if (chrome.runtime.lastError || !status) {
        if (currentPageStatus?.state === 'error' && currentPageStatus.localUntil > Date.now()) {
          updateStatusCard(currentPageStatus, tab.url);
          return;
        }
        currentPageStatus = null;
        updateStatusCard(null, tab.url);
        return;
      }
      currentPageStatus = status;
      updateStatusCard(status, tab.url);
    });
  });
}

function updateStatusCard(status, tabUrl) {
  const card = $('#status-footer');
  const dot = $('#status-dot');
  const text = $('#status-text');
  const summaryDot = $('#summary-status-dot');
  const summaryTitle = $('#summary-status-title');
  const summaryDetail = $('#summary-status-detail');
  card.classList.remove('error', 'unsupported');
  dot.classList.remove('active', 'error', 'unsupported');
  summaryDot.className = 'summary-dot idle';
  currentPageStatus = status;
  updateToggleBtn();

  if (!status || status.state === 'off') {
    if (isUnsupportedTabUrl(tabUrl)) {
      card.hidden = false;
      card.classList.add('unsupported');
      dot.classList.add('unsupported');
      text.textContent = '浏览器内部页面不支持注入脚本';
      summaryDot.className = 'summary-dot unsupported';
      summaryTitle.textContent = '当前页不支持';
      summaryDetail.textContent = '浏览器内部页面无法标注';
    } else {
      card.hidden = true;
      summaryTitle.textContent = '当前页未翻译';
      summaryDetail.textContent = '点击下方按钮开始标注';
    }
  } else if (status.state === 'error') {
    card.hidden = false;
    card.classList.add('error');
    dot.classList.add('error');
    text.textContent = status.message || '标注失败，请检查接口配置后重试';
    summaryDot.className = 'summary-dot error';
    summaryTitle.textContent = '标注失败';
    summaryDetail.textContent = status.message || '请检查接口配置后重试';
  } else {
    card.hidden = false;
    dot.classList.add('active');
    const pending = status.pendingCount || 0;
    const annotated = status.annotatedCount || 0;
    const paragraphs = status.translatedParagraphCount || 0;
    summaryDot.className = pending > 0 ? 'summary-dot running' : 'summary-dot done';
    if (pending > 0) {
      text.textContent = '标注中…';
      summaryTitle.textContent = '正在标注';
      summaryDetail.textContent = `待处理 ${pending} 项`;
    } else {
      text.textContent = '标注完成';
      summaryTitle.textContent = '当前页已标注';
      summaryDetail.textContent = `生词 ${annotated} 个 · 段落 ${paragraphs} 段`;
    }
  }

  // 容器底部间距：footer 隐藏时加 padding，可见时不加
  $('#page-main').classList.toggle('no-status', card.hidden);
}

function showToast(text) {
  const toast = $('#toast');
  toast.textContent = text;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1500);
}

statusTimer = setInterval(refreshPageStatus, 1000);
window.addEventListener('unload', () => {
  if (statusTimer) clearInterval(statusTimer);
});

initCustomDropdowns();
