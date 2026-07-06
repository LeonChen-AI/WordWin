// AdaptiveTranslation 生词本 0.9.1

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

let allWords = [];
let currentFilter = 'all';
let currentSort = 'time';
let currentSortDir = 'desc';
let searchQuery = '';
let currentView = 'cards';
let currentLevel = 'all';
let currentPage = 1;
let _returnToList = false;
let lastFocusedBeforeModal = null;
let activeToastTimer = null;
const PAGE_SIZE_CARDS = 10;
const PAGE_SIZE_LIST = 50;

function iconSvg(name, size = 16) {
  const paths = {
    volume: '<path d="M4 9V15H8L13 19V5L8 9H4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 9.5C16.8 10.2 17.25 11.1 17.25 12C17.25 12.9 16.8 13.8 16 14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.4 7.2C19.7 8.5 20.5 10.15 20.5 12C20.5 13.85 19.7 15.5 18.4 16.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    edit: '<path d="M4 20H8.5L19 9.5C20.1 8.4 20.1 6.6 19 5.5L18.5 5C17.4 3.9 15.6 3.9 14.5 5L4 15.5V20Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M13.5 6L18 10.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
    trash: '<path d="M5 7H19" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9 7V5H15V7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M8 10V19H16V10" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M10.5 12.5V16.5M13.5 12.5V16.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    arrowDown: '<path d="M12 5V19M12 19L7 14M12 19L17 14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    arrowUp: '<path d="M12 19V5M12 5L7 10M12 5L17 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
  };
  return `<svg class="ui-icon ui-icon-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths[name] || ''}</svg>`;
}

// ===== 初始化 =====

function init() {
  loadVocabulary();
  bindEvents();
  // Restore saved view preference
  try {
    const saved = localStorage.getItem('vocabView');
    if (saved === 'list') {
      currentView = 'list';
      $('#view-cards').classList.remove('active');
      $('#view-list').classList.add('active');
    }
  } catch (e) {}
}

function bindEvents() {
  // Back to settings
  $('#btn-back').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Pre-select level from current settings
  chrome.storage.local.get(['level'], (data) => {
    const level = data.level || 'L3';
    const sel = $('#add-level');
    if (sel) sel.value = level;
  });

  $('#search-input').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    currentPage = 1;
    render();
  });

  $$('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      $$('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentFilter = tab.dataset.filter;
      currentPage = 1;
      render();
    });
  });

  $('#sort-select').addEventListener('change', (e) => {
    currentSort = e.target.value;
    currentPage = 1;
    render();
  });

  // Sort direction toggle
  $('#sort-dir').addEventListener('click', () => {
    currentSortDir = currentSortDir === 'desc' ? 'asc' : 'desc';
    $('#sort-dir').innerHTML = currentSortDir === 'desc' ? iconSvg('arrowDown') : iconSvg('arrowUp');
    $('#sort-dir').title = currentSortDir === 'desc' ? '降序' : '升序';
    $('#sort-dir').setAttribute('aria-label', currentSortDir === 'desc' ? '降序' : '升序');
    currentPage = 1;
    render();
  });

  // View toggle
  $('#view-cards').addEventListener('click', () => {
    if (currentView === 'cards') return;
    currentView = 'cards';
    $('#view-cards').classList.add('active');
    $('#view-list').classList.remove('active');
    try { localStorage.setItem('vocabView', 'cards'); } catch (e) {}
    render();
  });

  $('#view-list').addEventListener('click', () => {
    if (currentView === 'list') return;
    currentView = 'list';
    $('#view-list').classList.add('active');
    $('#view-cards').classList.remove('active');
    try { localStorage.setItem('vocabView', 'list'); } catch (e) {}
    render();
  });

  // Level filter chips
  $$('.level-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $$('.level-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      currentLevel = chip.dataset.level;
      currentPage = 1;
      render();
    });
  });

  $('#btn-export').addEventListener('click', exportCSV);

  $('#btn-clear-all').addEventListener('click', () => {
    if (allWords.length === 0) return;
    openClearModal();
  });

  $('#btn-clear-cancel').addEventListener('click', closeClearModal);
  $('#btn-clear-confirm').addEventListener('click', clearAllVocabulary);
  $('#clear-modal').addEventListener('click', (e) => {
    if (e.target.id === 'clear-modal') closeClearModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#clear-modal').hidden) closeClearModal();
  });

  // 手动添加单词
  const addWordInput = $('#add-word');
  const addTransInput = $('#add-translation');
  const addBtn = $('#btn-add');

  function handleManualAdd() {
    const word = addWordInput.value.trim();
    if (!word) return;
    if (!/^[A-Za-z][A-Za-z' -]*$/.test(word)) {
      addWordInput.style.borderColor = '#ef4444';
      setTimeout(() => { addWordInput.style.borderColor = ''; }, 1500);
      return;
    }

    const translation = addTransInput.value.trim();
    const level = $('#add-level').value || 'L3';

    chrome.runtime.sendMessage({
      type: 'saveWord',
      word: {
        word: word,
        translation: translation,
        level: level,
        category: 'learning',
        sourceUrl: '',
        sourceTitle: '手动添加',
        context: ''
      }
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        addBtn.textContent = '失败';
        setTimeout(() => { addBtn.textContent = '添加'; }, 1500);
        return;
      }
      addWordInput.value = '';
      addTransInput.value = '';
      addBtn.textContent = '已添加';
      addBtn.style.background = '#059669';
      setTimeout(() => {
        addBtn.textContent = '添加';
        addBtn.style.background = '';
      }, 1200);
      loadVocabulary();
    });
  }

  addBtn.addEventListener('click', handleManualAdd);

  // Listen for storage changes from other tabs
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.vocabulary) {
      allWords = changes.vocabulary.newValue || [];
      render();
    }
  });
}

function openClearModal() {
  const modal = $('#clear-modal');
  const countEl = $('#clear-modal-count');
  lastFocusedBeforeModal = document.activeElement;
  countEl.textContent = `将删除全部 ${allWords.length} 个单词，此操作不可恢复。`;
  modal.hidden = false;
  document.body.classList.add('modal-open');
  $('#btn-clear-cancel').focus();
}

function closeClearModal() {
  const modal = $('#clear-modal');
  modal.hidden = true;
  document.body.classList.remove('modal-open');
  if (lastFocusedBeforeModal && typeof lastFocusedBeforeModal.focus === 'function') {
    lastFocusedBeforeModal.focus();
  }
  lastFocusedBeforeModal = null;
}

function clearAllVocabulary() {
  const btn = $('#btn-clear-confirm');
  btn.disabled = true;
  btn.textContent = '清空中...';

  chrome.storage.local.set({ vocabulary: [] }, () => {
    btn.disabled = false;
    btn.textContent = '确认清空';
    allWords = [];
    closeClearModal();
    render();
  });
}

function loadVocabulary() {
  chrome.runtime.sendMessage({ type: 'getVocabulary' }, (response) => {
    if (chrome.runtime.lastError) {
      // Fallback: read directly from storage
      chrome.storage.local.get(['vocabulary'], (data) => {
        allWords = data.vocabulary || [];
        render();
      });
      return;
    }
    allWords = (response && response.vocabulary) || [];
    render();
  });
}

// ===== TTS =====

let cachedEnglishVoice = null;

function findEnglishVoice() {
  if (cachedEnglishVoice) return cachedEnglishVoice;
  if (!window.speechSynthesis) return null;
  const voices = window.speechSynthesis.getVoices();
  const preferred = voices.find(v => /en[-_]US/i.test(v.lang) && /natural|neural|samantha|alex|victoria|karen|daniel|google/i.test(v.name));
  const fallback = voices.find(v => /en[-_]US/i.test(v.lang));
  const anyEnglish = voices.find(v => /^en/i.test(v.lang));
  cachedEnglishVoice = preferred || fallback || anyEnglish || null;
  return cachedEnglishVoice;
}

function speakWord(word) {
  if (!word || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(word);
  utterance.lang = 'en-US';
  utterance.rate = 0.9;
  const voice = findEnglishVoice();
  if (voice) utterance.voice = voice;
  window.speechSynthesis.speak(utterance);
}

if (window.speechSynthesis) {
  window.speechSynthesis.onvoiceschanged = () => { cachedEnglishVoice = null; };
}

// ===== 渲染 =====

function render() {
  const filtered = getFilteredWords();
  const listEl = $('#word-list');
  const compactEl = $('#word-list-compact');
  const emptyEl = $('#empty-state');
  const paginationEl = $('#pagination');

  updateStats();

  // Show/hide view containers
  if (currentView === 'cards') {
    listEl.classList.remove('hidden');
    compactEl.classList.remove('active');
  } else {
    listEl.classList.add('hidden');
    compactEl.classList.add('active');
  }

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    compactEl.innerHTML = '';
    paginationEl.innerHTML = '';
    emptyEl.hidden = false;
    if (allWords.length > 0 && (searchQuery || currentFilter !== 'all' || currentLevel !== 'all')) {
      emptyEl.querySelector('.empty-title').textContent = '没有匹配的单词';
      emptyEl.querySelector('.empty-hint').textContent = '试试其他搜索词或筛选条件';
    } else {
      emptyEl.querySelector('.empty-title').textContent = '还没有收录任何单词';
      emptyEl.querySelector('.empty-hint').textContent = '阅读时点击标注的生词，即可加入生词本';
    }
    return;
  }

  emptyEl.hidden = true;

  // Pagination
  const pageSize = currentView === 'cards' ? PAGE_SIZE_CARDS : PAGE_SIZE_LIST;
  const totalPages = Math.ceil(filtered.length / pageSize);
  if (currentPage > totalPages) currentPage = totalPages;
  const startIdx = (currentPage - 1) * pageSize;
  const pageWords = filtered.slice(startIdx, startIdx + pageSize);

  if (currentView === 'cards') {
    renderCardView(listEl, pageWords);
  } else {
    renderListView(compactEl, pageWords);
  }

  renderPagination(paginationEl, totalPages);
}

function getGroupKey(word) {
  if (currentSort === 'alpha') {
    return ((word.word || '?')[0] || '?').toUpperCase();
  }
  if (currentSort === 'level') {
    return word.level || 'L3';
  }
  return '';
}

function renderGroupHeader(key, count) {
  return `<div class="letter-group">
    <span class="letter-group-letter">${key}</span>
    <span class="letter-group-count">${count} 词</span>
    <span class="letter-group-line"></span>
  </div>`;
}

function renderCardView(listEl, words) {
  let html = '';
  const isGrouped = currentSort === 'alpha' || currentSort === 'level';

  if (isGrouped) {
    let lastGroup = '';
    const groupCounts = {};
    words.forEach(w => {
      const g = getGroupKey(w);
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    });
    words.forEach(word => {
      const group = getGroupKey(word);
      if (group !== lastGroup) {
        html += renderGroupHeader(group, groupCounts[group]);
        lastGroup = group;
      }
      html += renderWordCard(word);
    });
  } else {
    html = words.map(word => renderWordCard(word)).join('');
  }

  listEl.innerHTML = html;

  // Bind card events
  listEl.querySelectorAll('.btn-category').forEach(btn => {
    btn.addEventListener('click', () => {
      const word = btn.closest('.word-card').dataset.word;
      const category = btn.dataset.category;
      updateCategory(word, category);
    });
  });

  listEl.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const word = btn.closest('.word-card').dataset.word;
      removeWord(word);
    });
  });

  listEl.querySelectorAll('.btn-edit').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.word-card');
      const word = card.dataset.word;
      startEditWord(card, word);
    });
  });

  listEl.querySelectorAll('.word-tts-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      speakWord(btn.dataset.word);
    });
  });

  listEl.querySelectorAll('.word-source-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const url = link.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });
}

function renderListView(compactEl, words) {
  let html = '';
  const isGrouped = currentSort === 'alpha' || currentSort === 'level';

  if (isGrouped) {
    let lastGroup = '';
    const groupCounts = {};
    words.forEach(w => {
      const g = getGroupKey(w);
      groupCounts[g] = (groupCounts[g] || 0) + 1;
    });
    words.forEach(word => {
      const group = getGroupKey(word);
      if (group !== lastGroup) {
        html += renderGroupHeader(group, groupCounts[group]);
        lastGroup = group;
      }
      html += renderListRow(word);
    });
  } else {
    html = words.map(word => renderListRow(word)).join('');
  }

  compactEl.innerHTML = html;

  // Click row to toggle detail
  compactEl.querySelectorAll('.list-row').forEach(row => {
    row.addEventListener('click', () => {
      const detail = row.nextElementSibling;
      if (detail && detail.classList.contains('list-detail')) {
        detail.classList.toggle('open');
      }
    });
  });

  // TTS buttons
  compactEl.querySelectorAll('.btn-mini-tts').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakWord(btn.dataset.word);
    });
  });

  // Edit buttons — switch to card view and auto-edit
  compactEl.querySelectorAll('.btn-mini-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wordKey = btn.dataset.word;
      _returnToList = true;
      currentView = 'cards';
      $('#view-cards').classList.add('active');
      $('#view-list').classList.remove('active');
      // Don't persist — temporary switch for editing
      render();
      // Find the card and enter edit mode
      requestAnimationFrame(() => {
        const card = $(`#word-list .word-card[data-word="${CSS.escape(wordKey)}"]`);
        if (card) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
          startEditWord(card, wordKey);
        }
      });
    });
  });

  // Delete buttons
  compactEl.querySelectorAll('.btn-mini-del').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeWord(btn.dataset.word);
    });
  });

  // Source links
  compactEl.querySelectorAll('.detail-source').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const url = link.dataset.url;
      if (url) chrome.tabs.create({ url });
    });
  });
}

function renderWordCard(word) {
  const date = new Date(word.createdAt).toLocaleDateString('zh-CN', {
    month: 'short', day: 'numeric'
  });
  const category = word.category || 'learning';
  const context = word.context
    ? `<div class="word-context">"${escapeHtml(word.context)}"</div>`
    : '';
  const sourceLink = word.sourceUrl
    ? `<a class="word-source-link" href="#" data-url="${escapeHtml(word.sourceUrl)}">${escapeHtml(word.sourceTitle || '来源页面')}</a>`
    : '';
  const phonetic = word.phonetic
    ? `<span class="word-phonetic">${escapeHtml(word.phonetic)}</span>`
    : '';
  const pos = word.pos
    ? `<span class="word-pos">${escapeHtml(word.pos)}</span>`
    : '';
  const example = word.example
    ? `<div class="word-example">"${escapeHtml(word.example)}"</div>`
    : '';

  return `
    <div class="word-card" data-word="${escapeHtml(word.word)}">
      <div class="word-main">
        <div class="word-row">
          <span class="word-text">${escapeHtml(word.word)}</span>
          ${phonetic}
          <button class="word-tts-btn" data-word="${escapeHtml(word.word)}" title="发音" aria-label="发音">${iconSvg('volume')}</button>
          ${pos}
          <span class="word-level-badge ${word.level || 'L3'}">${word.level || 'L3'}</span>
        </div>
        <div class="word-definition">${escapeHtml(word.translation || '暂无翻译')}</div>
        <div class="word-meta">
          <span>${date}</span>
          ${sourceLink ? `<span>·</span>${sourceLink}` : ''}
        </div>
        ${context}
        ${example}
      </div>
      <div class="word-actions">
        <button class="btn-category ${category === 'learning' ? 'active-learning' : ''}" data-category="learning">学习中</button>
        <button class="btn-category ${category === 'mastered' ? 'active-mastered' : ''}" data-category="mastered">已掌握</button>
        <button class="btn-edit" title="编辑" aria-label="编辑">${iconSvg('edit')}</button>
        <button class="btn-delete" title="删除" aria-label="删除">${iconSvg('trash')}</button>
      </div>
    </div>
  `;
}

function renderListRow(word) {
  const level = word.level || 'L3';
  const category = word.category || 'learning';
  const phonetic = word.phonetic
    ? `<span class="detail-phonetic">${escapeHtml(word.phonetic)}</span>`
    : '';
  const pos = word.pos
    ? `<span class="detail-pos">${escapeHtml(word.pos)}</span>`
    : '';
  const context = word.context
    ? `<div class="detail-context">"${escapeHtml(word.context)}"</div>`
    : '';
  const sourceLink = word.sourceUrl
    ? `<a class="detail-source" href="#" data-url="${escapeHtml(word.sourceUrl)}">${escapeHtml(word.sourceTitle || '来源')}</a>`
    : '';
  const date = new Date(word.createdAt).toLocaleDateString('zh-CN', {
    month: 'short', day: 'numeric'
  });
  const metaParts = [];
  if (sourceLink) metaParts.push(sourceLink);
  metaParts.push(`<span style="font-size:11px;color:#9ca3af">${date}</span>`);

  return `
    <div class="list-row" data-word="${escapeHtml(word.word)}">
      <span class="list-dot ${level}"></span>
      <span class="list-word">${escapeHtml(word.word)}</span>
      <span class="list-trans">${escapeHtml(word.translation || '暂无翻译')}</span>
      <span class="list-cat ${category}">${category === 'learning' ? '学习中' : '已掌握'}</span>
      <div class="list-actions">
        <button class="btn-mini btn-mini-tts" data-word="${escapeHtml(word.word)}" title="发音" aria-label="发音">${iconSvg('volume', 15)}</button>
        <button class="btn-mini btn-mini-edit" data-word="${escapeHtml(word.word)}" title="编辑" aria-label="编辑">${iconSvg('edit', 15)}</button>
        <button class="btn-mini btn-mini-del danger" data-word="${escapeHtml(word.word)}" title="删除" aria-label="删除">${iconSvg('trash', 15)}</button>
      </div>
    </div>
    <div class="list-detail">
      ${phonetic} ${pos}
      ${context}
      <div style="margin-top:6px;display:flex;gap:8px;align-items:center">${metaParts.join('<span style="color:#c7d2fe;font-size:11px">·</span>')}</div>
    </div>
  `;
}

function renderPagination(el, totalPages) {
  if (totalPages <= 1) {
    el.innerHTML = '';
    return;
  }

  let html = '';
  html += `<button class="page-btn" data-page="prev" ${currentPage === 1 ? 'disabled' : ''}>‹</button>`;

  // Smart page number display
  const pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '...') {
      pages.push('...');
    }
  }

  pages.forEach(p => {
    if (p === '...') {
      html += `<span class="page-info">…</span>`;
    } else {
      html += `<button class="page-btn ${p === currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
    }
  });

  html += `<button class="page-btn" data-page="next" ${currentPage === totalPages ? 'disabled' : ''}>›</button>`;
  html += `<span class="page-info">${allWords.length} 词</span>`;

  el.innerHTML = html;

  el.querySelectorAll('.page-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const page = btn.dataset.page;
      if (page === 'prev') currentPage = Math.max(1, currentPage - 1);
      else if (page === 'next') currentPage = Math.min(totalPages, currentPage + 1);
      else currentPage = parseInt(page);
      render();
      // Scroll to top of list
      const target = currentView === 'cards' ? '#word-list' : '#word-list-compact';
      $(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function startEditWord(card, wordKey) {
  const wordData = allWords.find(w => w.word.toLowerCase() === wordKey.toLowerCase());
  if (!wordData) return;

  // Check if already in edit mode
  if (card.classList.contains('editing')) {
    return;
  }
  card.classList.add('editing');

  const mainEl = card.querySelector('.word-main');
  const actionsEl = card.querySelector('.word-actions');

  // Replace definition with edit form
  const defEl = mainEl.querySelector('.word-definition');
  const currentTranslation = wordData.translation || '';
  const currentLevel = wordData.level || 'L3';

  if (defEl) {
    const editForm = document.createElement('div');
    editForm.className = 'word-edit-form';
    editForm.innerHTML = `
      <div class="edit-row">
        <label>翻译</label>
        <input type="text" class="edit-translation" value="${escapeHtml(currentTranslation)}" placeholder="输入中文翻译">
      </div>
      <div class="edit-row edit-row-pair">
        <label>音标</label>
        <input type="text" class="edit-phonetic" value="${escapeHtml(wordData.phonetic || '')}" placeholder="/ˈwɜːrd/">
        <label>词性</label>
        <input type="text" class="edit-pos" value="${escapeHtml(wordData.pos || '')}" placeholder="n. / v. / adj.">
      </div>
      <div class="edit-row">
        <label>例句</label>
        <input type="text" class="edit-example" value="${escapeHtml(wordData.example || '')}" placeholder="包含该词的例句（可选）">
      </div>
      <div class="edit-row">
        <label>等级</label>
        <select class="edit-level">
          <option value="L1"${currentLevel === 'L1' ? ' selected' : ''}>L1</option>
          <option value="L2"${currentLevel === 'L2' ? ' selected' : ''}>L2</option>
          <option value="L3"${currentLevel === 'L3' ? ' selected' : ''}>L3</option>
          <option value="L4"${currentLevel === 'L4' ? ' selected' : ''}>L4</option>
          <option value="L5"${currentLevel === 'L5' ? ' selected' : ''}>L5</option>
        </select>
      </div>
    `;
    defEl.replaceWith(editForm);
  }

  // Replace actions with save/cancel
  actionsEl.innerHTML = `
    <button class="btn-edit-save">保存</button>
    <button class="btn-edit-cancel">取消</button>
  `;

  const transInput = mainEl.querySelector('.edit-translation');
  if (transInput) transInput.focus();

  actionsEl.querySelector('.btn-edit-save').addEventListener('click', () => {
    const newTranslation = mainEl.querySelector('.edit-translation').value.trim();
    const newPhonetic = mainEl.querySelector('.edit-phonetic').value.trim();
    const newPos = mainEl.querySelector('.edit-pos').value.trim();
    const newExample = mainEl.querySelector('.edit-example').value.trim();
    const newLevel = mainEl.querySelector('.edit-level').value;

    const details = {
      translation: newTranslation,
      phonetic: newPhonetic,
      pos: newPos,
      example: newExample,
      level: newLevel
    };

    chrome.runtime.sendMessage({
      type: 'updateWordDetails',
      word: wordKey,
      details: details
    }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        showToastMsg('保存失败');
        return;
      }
      // Update local data
      if (wordData) {
        if ('translation' in details) wordData.translation = details.translation;
        if ('phonetic' in details) wordData.phonetic = details.phonetic;
        if ('pos' in details) wordData.pos = details.pos;
        if ('example' in details) wordData.example = details.example;
        if ('level' in details) wordData.level = details.level;
      }
      _finishEdit();
    });
  });

  actionsEl.querySelector('.btn-edit-cancel').addEventListener('click', () => {
    _finishEdit();
  });
}

function _finishEdit() {
  if (_returnToList) {
    _returnToList = false;
    currentView = 'list';
    $('#view-cards').classList.remove('active');
    $('#view-list').classList.add('active');
    try { localStorage.setItem('vocabView', 'list'); } catch (e2) {}
  }
  render();
}

function showToastMsg(text, action) {
  const toast = document.createElement('div');
  toast.className = 'vocab-toast';
  toast.innerHTML = `<span>${escapeHtml(text)}</span>`;
  if (action && action.label && typeof action.onClick === 'function') {
    const btn = document.createElement('button');
    btn.className = 'vocab-toast-action';
    btn.type = 'button';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      clearTimeout(activeToastTimer);
      toast.remove();
      action.onClick();
    });
    toast.appendChild(btn);
  }

  document.querySelectorAll('.vocab-toast').forEach(el => el.remove());
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));
  activeToastTimer = setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, action ? 6000 : 1500);
}

function getFilteredWords() {
  let words = [...allWords];

  // Filter by category
  if (currentFilter !== 'all') {
    words = words.filter(w => (w.category || 'learning') === currentFilter);
  }

  // Filter by level
  if (currentLevel !== 'all') {
    words = words.filter(w => (w.level || 'L3') === currentLevel);
  }

  // Filter by search
  if (searchQuery) {
    words = words.filter(w =>
      (w.word || '').toLowerCase().includes(searchQuery) ||
      (w.translation || '').toLowerCase().includes(searchQuery) ||
      (w.context || '').toLowerCase().includes(searchQuery)
    );
  }

  // Sort
  const dir = currentSortDir === 'desc' ? -1 : 1;
  switch (currentSort) {
    case 'time':
      words.sort((a, b) => ((a.createdAt || 0) - (b.createdAt || 0)) * dir);
      break;
    case 'alpha':
      words.sort((a, b) => (a.word || '').localeCompare(b.word || '') * dir);
      break;
    case 'level':
      words.sort((a, b) => {
        const la = parseInt((a.level || 'L3').replace('L', '')) || 3;
        const lb = parseInt((b.level || 'L3').replace('L', '')) || 3;
        return (la - lb) * dir;
      });
      break;
  }

  return words;
}

function updateStats() {
  const total = allWords.length;
  const learning = allWords.filter(w => (w.category || 'learning') === 'learning').length;
  const mastered = allWords.filter(w => w.category === 'mastered').length;

  $('#stat-total').textContent = total;
  $('#stat-learning').textContent = learning;
  $('#stat-mastered').textContent = mastered;
}

// ===== 操作 =====

function updateCategory(word, category) {
  chrome.runtime.sendMessage({
    type: 'updateWordCategory',
    word: word,
    category: category
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) return;
    const item = allWords.find(w => w.word.toLowerCase() === word.toLowerCase());
    if (item) {
      item.category = category;
      render();
    }
  });
}

function removeWord(word) {
  const removedIndex = allWords.findIndex(w => w.word.toLowerCase() === (word || '').toLowerCase());
  const removedWord = removedIndex >= 0 ? { ...allWords[removedIndex] } : null;

  chrome.runtime.sendMessage({
    type: 'removeWord',
    word: word
  }, (response) => {
    if (chrome.runtime.lastError || !response?.ok) return;
    allWords = allWords.filter(w => w.word.toLowerCase() !== word.toLowerCase());
    render();
    if (removedWord) {
      showToastMsg(`已删除 ${removedWord.word}`, {
        label: '撤销',
        onClick: () => restoreRemovedWord(removedWord, removedIndex)
      });
    }
  });
}

function restoreRemovedWord(wordData, index) {
  chrome.storage.local.get(['vocabulary'], (data) => {
    const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];
    const exists = vocabulary.some(w => w.word.toLowerCase() === wordData.word.toLowerCase());
    if (exists) {
      showToastMsg('单词已存在');
      return;
    }

    const next = [...vocabulary];
    const safeIndex = Math.max(0, Math.min(index, next.length));
    next.splice(safeIndex, 0, wordData);
    chrome.storage.local.set({ vocabulary: next }, () => {
      if (chrome.runtime.lastError) {
        showToastMsg('恢复失败');
        return;
      }
      allWords = next;
      render();
      showToastMsg(`已恢复 ${wordData.word}`);
    });
  });
}

function exportCSV() {
  if (allWords.length === 0) return;

  const header = '单词,翻译,等级,分类,来源,收录时间\n';
  const rows = allWords.map(w => {
    const date = new Date(w.createdAt).toLocaleString('zh-CN');
    return [
      csvEscape(w.word),
      csvEscape(w.translation),
      w.level || 'L3',
      w.category || 'learning',
      csvEscape(w.sourceTitle || ''),
      date
    ].join(',');
  }).join('\n');

  const blob = new Blob(['\uFEFF' + header + rows], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vocabulary_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ===== 工具 =====

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function csvEscape(str) {
  const s = String(str || '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Start
init();
initCustomDropdowns();
