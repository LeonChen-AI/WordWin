// WordWin Content Script v5
// 负责：按段独立处理、视口优先调度，并在关闭时整轮清空标注

(function () {
  'use strict';

  if (window.__wordwin_initialized) return;
  window.__wordwin_initialized = true;

  const SEMANTIC_SELECTORS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption';
  const CONTAINER_TEXT_SELECTORS = 'article, section, div, span, a, button';
  const ALL_SELECTORS = SEMANTIC_SELECTORS + ', ' + CONTAINER_TEXT_SELECTORS;
  const BASE_EXCLUDED_ANCESTOR_SELECTOR = [
    '.wordwin-annotation',
    '.wordwin-translation',
    '[hidden]',
    '[aria-hidden="true"]',
    'script',
    'style',
    'noscript',
    'svg',
    'canvas',
    'pre',
    'code',
    'kbd',
    'samp',
    'textarea',
    'input',
    'select',
    '[contenteditable="true"]'
  ].join(', ');
  const ARTICLE_EXCLUDED_ANCESTOR_SELECTOR = [
    BASE_EXCLUDED_ANCESTOR_SELECTOR,
    'nav',
    'header',
    'footer',
    'aside',
    '.sidebar',
    '.infobox',
    '.navbox',
    '.vertical-navbox',
    '.shortdescription',
    '.mw-editsection',
    '.mw-cite-backlink',
    '.reflist',
    '.references',
    '.reference',
    '.toc',
    '#toc',
    '.noprint',
    '.portal',
    '.sistersitebox',
    'button'
  ].join(', ');
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'BLOCKQUOTE',
    'UL', 'OL', 'DL', 'TABLE', 'FIGURE', 'FORM', 'FIELDSET',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'FOOTER', 'NAV', 'PRE', 'DETAILS'
  ]);
  const DEFAULT_CONCURRENCY = 5;
  const MAX_RETRY_COUNT = 2;
  const RETRY_DELAY_MS = 900;
  const MAX_NEW_ITEMS_PER_COLLECT = 50;
  const BACKGROUND_COLLECT_DELAY_MS = 1800;

  let isRunning = false;
  let activeRunId = 0;
  let scrollHandler = null;
  let mutationObserver = null;
  let mutationDebounceTimer = null;
  let paragraphStates = new WeakMap();
  let highPriorityQueue = [];
  let lowPriorityQueue = [];
  const inFlightRequests = new Set();
  const retryTimers = new Set();
  let maxConcurrentRequests = DEFAULT_CONCURRENCY;
  let desiredEnabled = false;
  let scanMode = 'full';
  let pendingCollectTimer = null;
  let annotatedCount = 0;
  let failedCount = 0;
  let skippedRenderCount = 0;
  let pageStatus = {
    state: 'off',
    message: '未开启',
    annotatedCount: 0,
    failedCount: 0,
    pendingCount: 0,
    updatedAt: Date.now()
  };
  // 渲染期间暂停 observer 回调，避免自身 DOM 变更触发无效 collectParagraphs
  let isRendering = false;
  let ignoreMutationsUntil = 0;

  function isEnglishText(text) {
    const englishChars = text.replace(/[^a-zA-Z]/g, '').length;
    return text.length > 0 && englishChars / text.length > 0.45;
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function normalizeConcurrency(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_CONCURRENCY;
    return Math.min(10, Math.max(1, parsed));
  }

  function normalizeScanMode(value) {
    return value === 'article' ? 'article' : 'full';
  }

  function isElementHidden(el) {
    if (!el || el.hidden) return true;
    const style = window.getComputedStyle(el);
    return style.display === 'none' || style.visibility === 'hidden';
  }

  function isExcludedElement(el) {
    const selector = scanMode === 'article'
      ? ARTICLE_EXCLUDED_ANCESTOR_SELECTOR
      : BASE_EXCLUDED_ANCESTOR_SELECTOR;
    return Boolean(el.closest(selector));
  }

  function getContextType(el) {
    if (!el || !el.tagName) return 'paragraph';

    const tagName = el.tagName.toUpperCase();
    if (el.closest('nav, header')) return 'nav';
    if (el.closest('footer')) return 'footer';
    if (el.closest('aside, .toc, #toc, [aria-label*="Table of Contents" i], [class*="TableOfContents"]')) return 'toc';
    if (tagName === 'BUTTON') return 'button';
    if (tagName === 'A') return 'link';
    if (tagName === 'LI') return 'list_item';
    if (tagName === 'FIGCAPTION') return 'caption';
    if (tagName === 'TD' || tagName === 'TH') return 'table_cell';
    if (tagName === 'BLOCKQUOTE') return 'quote';
    if (/^H[1-6]$/.test(tagName)) return 'heading';
    if (tagName === 'DIV') return 'block';
    return 'paragraph';
  }

  function updateStatus(state, message, extra = {}) {
    pageStatus = {
      state,
      message,
      annotatedCount,
      failedCount,
      skippedRenderCount,
      pendingCount: highPriorityQueue.length + lowPriorityQueue.length + countInFlightForRun(activeRunId),
      updatedAt: Date.now(),
      ...extra
    };
  }

  function getDirectTextLength(el) {
    let length = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        length += node.textContent.trim().length;
      }
    }
    return length;
  }

  function collectTextNodes(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      if (node.textContent.trim().length > 0) {
        nodes.push(node);
      }
    }
    return nodes;
  }

  function renderAnnotations(el, annotations) {
    if (!annotations || annotations.length === 0) return 0;

    let insertedCount = 0;
    isRendering = true;

    try {
      const sorted = [...annotations]
        .filter(item => item && item.word && item.translation)
        .sort((a, b) => b.word.length - a.word.length);

      for (const { word, translation } of sorted) {
        const textNodes = collectTextNodes(el);

        for (const textNode of textNodes) {
          const parentElement = textNode.parentElement;
          if (!parentElement ||
              parentElement.classList.contains('wordwin-annotation') ||
              parentElement.classList.contains('wordwin-translation')) {
            continue;
          }

          const text = textNode.textContent;
          const boundary = /^[A-Za-z0-9' -]+$/.test(word) ? '\\b' : '';
          const regex = new RegExp(`${boundary}(${escapeRegex(word)})${boundary}`, 'i');
          const match = text.match(regex);

          if (match) {
            const before = text.substring(0, match.index);
            const matched = match[1];
            const after = text.substring(match.index + matched.length);

            const span = document.createElement('span');
            span.className = 'wordwin-annotation';
            span.textContent = matched;

            const trans = document.createElement('span');
            trans.className = 'wordwin-translation';
            trans.textContent = `(${translation})`;

            const parent = textNode.parentNode;
            if (!parent) continue;
            if (before) parent.insertBefore(document.createTextNode(before), textNode);
            parent.insertBefore(span, textNode);
            parent.insertBefore(trans, textNode);
            if (after) parent.insertBefore(document.createTextNode(after), textNode);
            parent.removeChild(textNode);

            insertedCount += 1;
            break;
          }
        }
      }
    } finally {
      isRendering = false;
      ignoreMutationsUntil = Date.now() + 1000;
    }

    return insertedCount;
  }

  function countInFlightForRun(runId) {
    let count = 0;
    for (const request of inFlightRequests) {
      if (request.runId === runId) {
        count += 1;
      }
    }
    return count;
  }

  function isNearViewport(el) {
    const rect = el.getBoundingClientRect();
    return rect.top < window.innerHeight + 500 && rect.bottom > -500;
  }

  function enqueueParagraph(el, text, runId, priority, retryCount = 0, contextType = getContextType(el)) {
    const state = paragraphStates.get(el);
    if (state === 'queued-high' || state === 'queued-low' || state === 'processing' || state === 'done' || state === 'ignored' || state === 'retrying') {
      if (priority === 'high' && state === 'queued-low') {
        lowPriorityQueue = lowPriorityQueue.filter(item => item.el !== el);
        highPriorityQueue.push({ el, text, runId, retryCount, contextType });
        paragraphStates.set(el, 'queued-high');
      }
      return;
    }

    if (priority === 'high') {
      highPriorityQueue.push({ el, text, runId, retryCount, contextType });
      paragraphStates.set(el, 'queued-high');
    } else {
      lowPriorityQueue.push({ el, text, runId, retryCount, contextType });
      paragraphStates.set(el, 'queued-low');
    }
  }

  // 判断元素是否有块级子元素（用于过滤容器级元素）
  function hasBlockChildren(el) {
    for (const child of el.children) {
      if (BLOCK_TAGS.has(child.tagName)) return true;
    }
    return false;
  }

  function isSemanticElement(el) {
    return el.matches(SEMANTIC_SELECTORS);
  }

  function isContainerTextElement(el) {
    return el.matches(CONTAINER_TEXT_SELECTORS);
  }

  function shouldCollectElement(el) {
    if (isExcludedElement(el) || isElementHidden(el)) {
      return false;
    }

    if (isSemanticElement(el)) {
      return true;
    }

    if (!isContainerTextElement(el)) {
      return false;
    }

    if (hasBlockChildren(el)) {
      return false;
    }

    const directTextLength = getDirectTextLength(el);
    const totalTextLength = el.textContent.trim().length;
    if (scanMode === 'full') {
      return directTextLength >= 2 || totalTextLength >= 2;
    }
    return directTextLength >= 20 || totalTextLength >= 30;
  }

  // 收集所有应处理的文本元素：语义标签 + 叶子级文本容器
  // querySelectorAll 返回树序（父在子前），利用这一点去重：如果父已收集，跳过子
  function getTextElements() {
    const collected = new Set();
    const result = [];
    const all = document.body ? document.body.querySelectorAll(ALL_SELECTORS) : [];

    for (const el of all) {
      if (!shouldCollectElement(el)) {
        continue;
      }

      // 如果某个已收集祖先覆盖当前节点，跳过，避免重复标注同一段文本。
      let dominated = false;
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        if (collected.has(parent)) {
          dominated = true;
          break;
        }
        parent = parent.parentElement;
      }
      if (dominated) continue;

      collected.add(el);
      result.push(el);
    }

    return result;
  }

  function scheduleRetry(item, runId) {
    if (!isRunning || runId !== activeRunId) {
      return false;
    }

    const nextRetryCount = (item.retryCount || 0) + 1;
    if (nextRetryCount > MAX_RETRY_COUNT) {
      return false;
    }

    paragraphStates.set(item.el, 'retrying');

    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!isRunning || runId !== activeRunId) return;

      paragraphStates.delete(item.el);
      enqueueParagraph(
        item.el,
        item.text,
        runId,
        isNearViewport(item.el) ? 'high' : 'low',
        nextRetryCount,
        item.contextType
      );
      pumpQueue(runId);
    }, RETRY_DELAY_MS * nextRetryCount);

    retryTimers.add(timer);
    return true;
  }

  function clearPendingCollect() {
    if (pendingCollectTimer) {
      clearTimeout(pendingCollectTimer);
      pendingCollectTimer = null;
    }
  }

  function scheduleBackgroundCollect(runId) {
    if (!isRunning || runId !== activeRunId || pendingCollectTimer) {
      return;
    }

    pendingCollectTimer = setTimeout(() => {
      pendingCollectTimer = null;
      collectParagraphs(runId);
    }, BACKGROUND_COLLECT_DELAY_MS);
  }

  function hasPendingWork(runId) {
    return countInFlightForRun(runId) > 0 || highPriorityQueue.length > 0 || lowPriorityQueue.length > 0;
  }

  function updateSettledStatus(runId) {
    if (hasPendingWork(runId)) return;

    if (failedCount > 0) {
      const message = annotatedCount > 0
        ? `已标注 ${annotatedCount} 处，${failedCount} 段失败`
        : '标注失败，请检查 API 设置或网络';
      updateStatus('error', message);
      return;
    }

    updateStatus('completed', annotatedCount > 0 ? `已完成，已标注 ${annotatedCount} 处` : '已完成，当前页面没有可标注内容');
    scheduleBackgroundCollect(runId);
  }

  function collectParagraphs(runId) {
    if (!isRunning || runId !== activeRunId) return;

    const elements = getTextElements();
    const candidates = [];

    for (const el of elements) {
      const state = paragraphStates.get(el);
      if (state === 'processing' || state === 'done' || state === 'error' || state === 'ignored' || state === 'queued-high' || state === 'queued-low' || state === 'retrying') {
        continue;
      }

      const text = el.textContent.trim();
      const contextType = getContextType(el);
      const minTextLength = scanMode === 'full' ? 2 : 20;
      if (text.length < minTextLength || !isEnglishText(text)) {
        paragraphStates.set(el, 'ignored');
        continue;
      }

      const rect = el.getBoundingClientRect();
      candidates.push({
        el,
        text,
        contextType,
        priority: isNearViewport(el) ? 'high' : 'low',
        distance: Math.min(Math.abs(rect.top), Math.abs(rect.bottom))
      });
    }

    candidates.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1;
      return a.distance - b.distance;
    });

    let addedCount = 0;
    for (const item of candidates) {
      if (addedCount >= MAX_NEW_ITEMS_PER_COLLECT) break;
      enqueueParagraph(item.el, item.text, runId, item.priority, 0, item.contextType);
      addedCount += 1;
    }

    if (addedCount > 0) {
      updateStatus('running', '正在标注当前页面');
    } else {
      updateSettledStatus(runId);
    }

    pumpQueue(runId);
  }

  function pumpQueue(runId) {
    if (!isRunning || runId !== activeRunId) return;

    while (countInFlightForRun(runId) < maxConcurrentRequests) {
      let item = null;
      let nextIndex = highPriorityQueue.findIndex(queueItem => queueItem.runId === runId);
      if (nextIndex !== -1) {
        [item] = highPriorityQueue.splice(nextIndex, 1);
      } else {
        nextIndex = lowPriorityQueue.findIndex(queueItem => queueItem.runId === runId);
        if (nextIndex !== -1) {
          [item] = lowPriorityQueue.splice(nextIndex, 1);
        }
      }

      if (!item) break;
      annotateParagraph(item, runId);
    }
  }

  async function annotateParagraph(item, runId) {
    const request = { runId };
    inFlightRequests.add(request);
    paragraphStates.set(item.el, 'processing');

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'annotate',
        text: item.text,
        contextType: item.contextType,
        scanMode
      });

      if (!isRunning || runId !== activeRunId) return;

      if (result && result.error) {
        if (result.retryable && scheduleRetry(item, runId)) {
          return;
        }
        paragraphStates.set(item.el, 'error');
        failedCount += 1;
        updateStatus('error', result.error || '标注失败');
        return;
      }

      const annotations = result?.annotations || [];
      if (annotations.length > 0) {
        const insertedCount = renderAnnotations(item.el, annotations);
        if (insertedCount > 0) {
          annotatedCount += insertedCount;
        } else {
          skippedRenderCount += 1;
        }
      }
      paragraphStates.set(item.el, 'done');
    } catch {
      if (isRunning && runId === activeRunId && scheduleRetry(item, runId)) {
        return;
      }
      if (runId === activeRunId) {
        paragraphStates.set(item.el, 'error');
        failedCount += 1;
        updateStatus('error', '标注请求失败');
      }
    } finally {
      inFlightRequests.delete(request);
      if (isRunning && runId === activeRunId) {
        pumpQueue(runId);
        updateSettledStatus(runId);
      }
    }
  }

  async function startAnnotating() {
    if (isRunning) return;

    if (!desiredEnabled) return;

    isRunning = true;
    activeRunId += 1;
    paragraphStates = new WeakMap();
    highPriorityQueue = [];
    lowPriorityQueue = [];
    annotatedCount = 0;
    failedCount = 0;
    skippedRenderCount = 0;
    clearPendingCollect();
    const runId = activeRunId;

    updateStatus('running', '正在扫描当前页面');
    collectParagraphs(runId);

    let scrollTimer = null;
    scrollHandler = () => {
      if (scrollTimer) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        collectParagraphs(runId);
      }, 500);
    };
    window.addEventListener('scroll', scrollHandler, { passive: true });

    mutationObserver = new MutationObserver(() => {
      if (isRendering) return;
      if (Date.now() < ignoreMutationsUntil) return;
      if (mutationDebounceTimer) return;
      mutationDebounceTimer = setTimeout(() => {
        mutationDebounceTimer = null;
        collectParagraphs(runId);
      }, 800);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }

  function stopAnnotating({ clearAnnotations = true, statusState = 'off', statusMessage = '未开启' } = {}) {
    activeRunId += 1;
    isRunning = false;
    paragraphStates = new WeakMap();
    highPriorityQueue = [];
    lowPriorityQueue = [];
    clearPendingCollect();

    if (scrollHandler) {
      window.removeEventListener('scroll', scrollHandler);
      scrollHandler = null;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (mutationDebounceTimer) {
      clearTimeout(mutationDebounceTimer);
      mutationDebounceTimer = null;
    }
    for (const timer of retryTimers) {
      clearTimeout(timer);
    }
    retryTimers.clear();

    if (clearAnnotations) {
      // 先删翻译括号，再还原加粗词
      document.querySelectorAll('.wordwin-translation').forEach(el => {
        el.remove();
      });
      document.querySelectorAll('.wordwin-annotation').forEach(el => {
        const text = document.createTextNode(el.textContent);
        el.parentNode.replaceChild(text, el);
      });
      document.body.normalize();
      annotatedCount = 0;
      failedCount = 0;
      skippedRenderCount = 0;
    }

    updateStatus(statusState, statusMessage);
  }

  function restartAnnotating() {
    if (!isRunning) return;
    stopAnnotating();
    startAnnotating();
  }

  // 设置变化只影响当前正在处理的页面，不再使用全局 enabled 自动启动。
  chrome.storage.onChanged.addListener((changes) => {
    let shouldRestart = false;

    if (changes.concurrency) {
      maxConcurrentRequests = normalizeConcurrency(changes.concurrency.newValue);
      if (isRunning) {
        pumpQueue(activeRunId);
      }
    }
    if (changes.level) {
      shouldRestart = true;
    }
    if (changes.scanMode) {
      scanMode = normalizeScanMode(changes.scanMode.newValue);
      shouldRestart = true;
    }
    if (shouldRestart) {
      restartAnnotating();
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'getPageStatus') {
      sendResponse(pageStatus);
      return true;
    }
    if (message.type === 'startPageAnnotating') {
      desiredEnabled = true;
      startAnnotating()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: err.message || '启动失败' }));
      return true;
    }
    if (message.type === 'stopPageAnnotating') {
      desiredEnabled = false;
      stopAnnotating();
      sendResponse({ ok: true });
      return true;
    }
  });

  async function init() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: 'getSettings' });
      if (settings) {
        maxConcurrentRequests = normalizeConcurrency(settings.concurrency);
        scanMode = normalizeScanMode(settings.scanMode);
        desiredEnabled = false;
      }
    } catch {}
  }

  init();
})();
