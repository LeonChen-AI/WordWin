// WordWin Popup v5

const $ = (sel) => document.querySelector(sel);

let hasApiKey = false;
let statusTimer = null;
let currentPageStatus = null;

function syncPopupView() {
  if (!hasApiKey) {
    $('#page-setup').style.display = 'block';
    $('#page-main').style.display = 'none';
    return;
  }

  $('#page-setup').style.display = 'none';
  updateToggleBtn();
  $('#page-main').style.display = 'block';
  refreshPageStatus();
}

// 初始化
chrome.storage.local.get(['apiKey'], (data) => {
  hasApiKey = Boolean(data.apiKey);
  syncPopupView();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  let shouldSyncView = false;

  if (changes.apiKey) {
    hasApiKey = Boolean(changes.apiKey.newValue);
    shouldSyncView = true;
  }

  if (shouldSyncView) {
    syncPopupView();
  }
});

// 前往设置页
$('#btn-go-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

$('#btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// 当前页按钮：只操作当前标签页，不再开启全局自动翻译。
$('#btn-toggle').addEventListener('click', () => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      showToast('当前页面不可用');
      return;
    }

    const shouldStop = isPageActive(currentPageStatus);
    chrome.tabs.sendMessage(tab.id, { type: shouldStop ? 'stopPageAnnotating' : 'startPageAnnotating' }, (result) => {
      if (chrome.runtime.lastError || result?.error) {
        showToast('当前页面暂不可标注');
        refreshPageStatus();
        return;
      }
      showToast(shouldStop ? '已取消翻译' : '已开始翻译当前页');
      setTimeout(refreshPageStatus, 250);
    });
  });
});

function isPageActive(status) {
  return Boolean(status && status.state && status.state !== 'off');
}

function updateToggleBtn() {
  const btn = $('#btn-toggle');
  if (isPageActive(currentPageStatus)) {
    btn.textContent = '取消翻译';
    btn.classList.add('active');
  } else {
    btn.textContent = '翻译当前页';
    btn.classList.remove('active');
  }
}

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
        currentPageStatus = null;
        updateStatusCard(null);
        return;
      }
      currentPageStatus = status;
      updateStatusCard(status);
    });
  });
}

function updateStatusCard(status) {
  const card = $('#status-card');
  const text = $('#status-text');
  card.classList.remove('error');
  currentPageStatus = status;
  updateToggleBtn();

  if (!status || status.state === 'off') {
    card.hidden = true;
    return;
  }

  card.hidden = false;

  if (status.state === 'error') {
    card.classList.add('error');
    text.textContent = status.message || '标注失败，请检查设置';
    return;
  }

  const countText = status.annotatedCount > 0 ? `，已标注 ${status.annotatedCount} 处` : '';
  text.textContent = `${status.message || '正在处理'}${countText}`;
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
