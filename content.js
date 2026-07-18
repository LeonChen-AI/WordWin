// AdaptiveTranslation Content Script 0.9.1
// 负责：按段独立处理、视口优先调度、对照翻译，并在关闭时整轮清空标注

(function () {
  'use strict';

  if (window.__adaptiveTranslation_initialized) return;
  window.__adaptiveTranslation_initialized = true;

  const SEMANTIC_SELECTORS = 'p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, figcaption, dd, dt, label, legend, details, time, strong, b, em, i';
  const CONTAINER_TEXT_SELECTORS = 'article, section, div, span, a, button';
  const ALL_SELECTORS = SEMANTIC_SELECTORS + ', ' + CONTAINER_TEXT_SELECTORS;
  const BASE_EXCLUDED_ANCESTOR_SELECTOR = [
    '.adaptive-translation-annotation',
    '.adaptive-translation-translation',
    '.adaptive-translation-paragraph-translation',
    '[hidden]',
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
    'button',
    'summary',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[contenteditable]'
  ].join(', ');
  const ARTICLE_EXCLUDED_ANCESTOR_SELECTOR = [
    BASE_EXCLUDED_ANCESTOR_SELECTOR,
    '[aria-hidden="true"]',
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
    '.sister-bar',
    '.hatnote',
    '.refbegin',
    '.side-box'
  ].join(', ');
  const BLOCK_TAGS = new Set([
    'P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'ASIDE', 'BLOCKQUOTE',
    'UL', 'OL', 'DL', 'DD', 'DT', 'TABLE', 'FIGURE', 'FORM', 'FIELDSET', 'LEGEND',
    'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'HEADER', 'FOOTER', 'NAV', 'PRE', 'DETAILS'
  ]);
  const DEFAULT_CONCURRENCY = 3;
  const MAX_RETRY_COUNT = 2;
  const RETRY_DELAY_MS = 900;
  const MAX_NEW_ITEMS_PER_COLLECT = 100;
  const BACKGROUND_COLLECT_DELAY_MS = 1800;
  const TRANSLATABLE_CONTEXT_TYPES = new Set(['paragraph', 'quote', 'list_item', 'block', 'heading', 'table_cell', 'caption']);
  const contentCore = window.AdaptiveTranslationCore;
  const runStateFactory = window.AdaptiveTranslationRunState;

  if (!contentCore || !runStateFactory) {
    console.warn('AdaptiveTranslation: content core 未完整加载，当前页面不会启动标注');
    return;
  }

  const runState = runStateFactory.createAdaptiveTranslationRunState();
  let scrollHandler = null;
  let mutationObserver = null;
  let mutationDebounceTimer = null;
  let paragraphStates = new WeakMap();
  let highPriorityQueue = [];
  let lowPriorityQueue = [];
  const inFlightRequests = new Set();
  const retryTimers = new Set();
  let maxConcurrentRequests = DEFAULT_CONCURRENCY;
  let scanMode = 'full';
  let paragraphTranslationMode = 'on';
  let pendingCollectTimer = null;
  let annotatedCount = 0;
  let translatedParagraphCount = 0;
  let failedCount = 0;
  let skippedRenderCount = 0;
  let pageStatus = {
    state: 'off',
    message: '未开启',
    annotatedCount: 0,
    translatedParagraphCount: 0,
    failedCount: 0,
    pendingCount: 0,
    updatedAt: Date.now()
  };
  // 渲染期间暂停 observer 回调，避免自身 DOM 变更触发无效 collectParagraphs
  let isRendering = false;
  let ignoreMutationsUntil = 0;
  let fontSize = 100;
  let translationColor = '#818cf8';
  let autoTranslate = false;
  let level = 'L3';
  const savedWords = new Set();

  function iconSvgMarkup(name, size = 16) {
    const paths = {
      volume: '<path d="M4 9V15H8L13 19V5L8 9H4Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 9.5C16.8 10.2 17.25 11.1 17.25 12C17.25 12.9 16.8 13.8 16 14.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M18.4 7.2C19.7 8.5 20.5 10.15 20.5 12C20.5 13.85 19.7 15.5 18.4 16.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    };
    return `<svg class="at-inline-icon at-inline-icon-${name}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" aria-hidden="true">${paths[name] || ''}</svg>`;
  }

  // 预加载已保存的单词和当前等级，让已收录的词在页面加载时即显示"已收录"状态
  chrome.storage.local.get(['vocabulary', 'level'], (data) => {
    if (data.level) level = data.level;
    const vocab = data.vocabulary || [];
    vocab.forEach(w => {
      if (w.word) savedWords.add(w.word.toLowerCase());
    });
  });
  let activeWordPopup = null;

  function isEnglishText(text) {
    return contentCore.isEnglishText(text);
  }

  function escapeRegex(str) {
    return contentCore.escapeRegex(str);
  }

  function normalizeConcurrency(value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return DEFAULT_CONCURRENCY;
    return Math.min(10, Math.max(1, parsed));
  }

  function normalizeScanMode(value) {
    return value === 'article' ? 'article' : 'full';
  }

  function normalizeParagraphTranslationMode(value) {
    return value === 'off' ? 'off' : 'on';
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
      translatedParagraphCount,
      failedCount,
      skippedRenderCount,
      pendingCount: contentCore.countQueuedItemsForRun(highPriorityQueue, lowPriorityQueue, runState.getRunId()) + countInFlightForRun(runState.getRunId()),
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

  function getSourceTextNodes(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.adaptive-translation-translation, .adaptive-translation-paragraph-translation')) {
          return NodeFilter.FILTER_REJECT;
        }
        return node.textContent.length > 0
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) {
      nodes.push(node);
    }
    return nodes;
  }

  function splitIntoSentences(text) {
    return contentCore.splitIntoSentences(text);
  }

  function shouldRequestParagraphTranslation(contextType, text, sentences) {
    if (paragraphTranslationMode !== 'on') return false;
    if (!TRANSLATABLE_CONTEXT_TYPES.has(contextType)) return false;
    if (!Array.isArray(sentences) || sentences.length === 0) return false;
    return String(text || '').trim().length >= 40;
  }

  function collectTextLayout(el) {
    let text = '';
    const nodes = getSourceTextNodes(el).map(node => {
      const start = text.length;
      text += node.textContent;
      return {
        node,
        start,
        end: text.length
      };
    });
    return { text, nodes };
  }

  function findTextPosition(nodes, index) {
    for (const item of nodes) {
      if (index >= item.start && index <= item.end) {
        return {
          node: item.node,
          offset: index - item.start
        };
      }
    }
    return null;
  }

  function wrapTextRange(el, start, end, sentenceId) {
    if (end <= start) return false;

    const layout = collectTextLayout(el);
    const startPos = findTextPosition(layout.nodes, start);
    const endPos = findTextPosition(layout.nodes, end);
    if (!startPos || !endPos) return false;

    const range = document.createRange();
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);

    const span = document.createElement('span');
    span.className = 'adaptive-translation-source-sentence';
    span.dataset.adaptiveTranslationSentenceId = String(sentenceId);
    span.appendChild(range.extractContents());
    range.insertNode(span);
    return true;
  }

  function normalizeTextWithMap(text) {
    let normalized = '';
    const map = [];
    let pendingSpaceIndex = -1;

    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (/\s/.test(char)) {
        if (normalized.length > 0 && pendingSpaceIndex === -1) {
          pendingSpaceIndex = i;
        }
        continue;
      }

      if (pendingSpaceIndex !== -1) {
        normalized += ' ';
        map.push(pendingSpaceIndex);
        pendingSpaceIndex = -1;
      }

      normalized += char;
      map.push(i);
    }

    return { normalized: normalized.trim(), map };
  }

  function wrapSourceSentences(el, sentences) {
    const layout = collectTextLayout(el);
    const normalizedLayout = normalizeTextWithMap(layout.text);
    const ranges = [];
    let cursor = 0;

    for (const sentence of sentences) {
      const index = normalizedLayout.normalized.indexOf(sentence.text, cursor);
      if (index === -1) continue;
      const mappedStart = normalizedLayout.map[index];
      const mappedEnd = normalizedLayout.map[index + sentence.text.length - 1] + 1;
      if (!Number.isInteger(mappedStart) || !Number.isInteger(mappedEnd)) continue;
      ranges.push({
        id: sentence.id,
        start: mappedStart,
        end: mappedEnd
      });
      cursor = index + sentence.text.length;
    }

    let wrappedCount = 0;
    for (const range of ranges.reverse()) {
      if (wrapTextRange(el, range.start, range.end, range.id)) {
        wrappedCount += 1;
      }
    }
    return wrappedCount;
  }

  function clearActiveSentence(sourceEl, translationBlock) {
    sourceEl.querySelectorAll('.adaptive-translation-sentence-active').forEach(el => {
      el.classList.remove('adaptive-translation-sentence-active');
    });
    translationBlock.querySelectorAll('.adaptive-translation-sentence-active').forEach(el => {
      el.classList.remove('adaptive-translation-sentence-active');
    });
  }

  function setActiveSentence(sourceEl, translationBlock, sentenceId) {
    clearActiveSentence(sourceEl, translationBlock);
    sourceEl.querySelectorAll(`[data-adaptive-translation-sentence-id="${sentenceId}"]`).forEach(el => {
      el.classList.add('adaptive-translation-sentence-active');
    });
    translationBlock.querySelectorAll(`[data-adaptive-translation-sentence-id="${sentenceId}"]`).forEach(el => {
      el.classList.add('adaptive-translation-sentence-active');
    });
  }

  function attachSentenceHover(sourceEl, translationBlock) {
    const isInsidePair = (node) => Boolean(node && (
      sourceEl.contains(node) || translationBlock.contains(node)
    ));
    const clear = (event) => {
      if (event && isInsidePair(event.relatedTarget)) return;
      clearActiveSentence(sourceEl, translationBlock);
    };
    sourceEl.querySelectorAll('.adaptive-translation-source-sentence').forEach(span => {
      span.addEventListener('mouseenter', () => setActiveSentence(sourceEl, translationBlock, span.dataset.adaptiveTranslationSentenceId));
      span.addEventListener('mouseleave', clear);
    });
    translationBlock.querySelectorAll('.adaptive-translation-target-sentence').forEach(span => {
      span.addEventListener('mouseenter', () => setActiveSentence(sourceEl, translationBlock, span.dataset.adaptiveTranslationSentenceId));
      span.addEventListener('mouseleave', clear);
    });
  }

  // --- Color contrast utilities ---

  function parseColor(colorStr) {
    const source = String(colorStr || '').trim();
    if (!source || source === 'transparent' || source === 'rgba(0, 0, 0, 0)') return null;

    const hex = source.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const value = hex[1].length === 3
        ? hex[1].split('').map(char => char + char).join('')
        : hex[1];
      return [
        Number.parseInt(value.slice(0, 2), 16),
        Number.parseInt(value.slice(2, 4), 16),
        Number.parseInt(value.slice(4, 6), 16)
      ];
    }

    const m = source.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h, s, l];
  }

  function hslToRgb(h, s, l) {
    if (s === 0) {
      const v = Math.round(l * 255);
      return [v, v, v];
    }
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return [
      Math.round(hue2rgb(p, q, h + 1/3) * 255),
      Math.round(hue2rgb(p, q, h) * 255),
      Math.round(hue2rgb(p, q, h - 1/3) * 255)
    ];
  }

  function getLuminance(r, g, b) {
    const toLinear = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
  }

  function getContrastRatio(rgb1, rgb2) {
    const l1 = getLuminance(...rgb1);
    const l2 = getLuminance(...rgb2);
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
  }

  function getEffectiveBgColor(el) {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = window.getComputedStyle(node).backgroundColor;
      const rgb = parseColor(bg);
      if (rgb) return rgb;
      node = node.parentElement;
    }
    return [255, 255, 255]; // default white
  }

  function getContrastSafeColor(fgHex, bgRgb) {
    const fgRgb = parseColor(fgHex);
    if (!fgRgb) return fgHex;

    const contrast = getContrastRatio(fgRgb, bgRgb);
    if (contrast >= 3.0) return fgHex; // WCAG AA for large text

    // Adjust lightness to meet 3:1 contrast while preserving hue
    const [h, s] = rgbToHsl(...fgRgb);
    const bgLum = getLuminance(...bgRgb);

    // Try darkening first (works on light backgrounds)
    for (let l = 0.5; l >= 0.05; l -= 0.03) {
      const candidate = hslToRgb(h, s, l);
      if (getContrastRatio(candidate, bgRgb) >= 3.0) {
        return `rgb(${candidate[0]}, ${candidate[1]}, ${candidate[2]})`;
      }
    }

    // If background is dark, try lightening
    if (bgLum < 0.5) {
      for (let l = 0.5; l <= 0.95; l += 0.03) {
        const candidate = hslToRgb(h, s, l);
        if (getContrastRatio(candidate, bgRgb) >= 3.0) {
          return `rgb(${candidate[0]}, ${candidate[1]}, ${candidate[2]})`;
        }
      }
    }

    return fgHex; // fallback to original
  }

  function getInsertionContext(el) {
    // Check if element is inside a table cell
    let parent = el.parentElement;
    while (parent && parent.tagName !== 'TABLE') {
      if (parent.tagName === 'TD' || parent.tagName === 'TH') {
        return 'table-cell';
      }
      parent = parent.parentElement;
    }

    // Check if element's direct parent is flex or grid
    if (el.parentElement) {
      const parentDisplay = window.getComputedStyle(el.parentElement).display;
      if (parentDisplay === 'flex' || parentDisplay === 'inline-flex' ||
          parentDisplay === 'grid' || parentDisplay === 'inline-grid') {
        return 'flex-grid';
      }
    }

    return 'normal';
  }

  function syncTranslationBlockLayout(sourceEl, block) {
    if (block.classList.contains('in-source-element')) {
      block.style.boxSizing = 'border-box';
      block.style.width = '100%';
      block.style.maxWidth = '100%';
      block.style.marginLeft = '';
      block.style.marginRight = '';
      return;
    }

    const rect = sourceEl.getBoundingClientRect();
    if (rect.width <= 0) return;

    const sourceStyle = window.getComputedStyle(sourceEl);
    block.style.boxSizing = 'border-box';
    block.style.width = `${Math.round(rect.width)}px`;
    block.style.maxWidth = '100%';

    if (sourceEl.tagName !== 'LI') {
      block.style.marginLeft = sourceStyle.marginLeft;
      block.style.marginRight = sourceStyle.marginRight;
    }
  }

  function canAppendTranslationInside(el) {
    if (!el || !el.tagName || el.isContentEditable) return false;

    const forbiddenTags = new Set([
      'A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'LABEL',
      'SCRIPT', 'STYLE', 'SVG', 'IMG', 'VIDEO', 'AUDIO', 'CANVAS',
      'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'UL', 'OL'
    ]);
    if (forbiddenTags.has(el.tagName)) return false;

    const display = window.getComputedStyle(el).display;
    if (!display || display.startsWith('inline') || display === 'contents') {
      return false;
    }

    return true;
  }

  function renderParagraphTranslation(el, sentences, sentenceTranslations) {
    if (!sentenceTranslations || sentenceTranslations.length === 0) return 0;

    isRendering = true;
    try {
      const translationById = new Map(
        sentenceTranslations.map(item => [Number(item.id), item.translation])
      );
      const matched = sentences.filter(sentence => translationById.has(sentence.id));
      if (matched.length === 0) return 0;

      const wrappedCount = wrapSourceSentences(el, matched);
      if (wrappedCount === 0) return 0;

      const block = document.createElement('span');
      block.className = 'adaptive-translation-paragraph-translation';
      block.dataset.adaptiveTranslationBlock = 'true';

      // Insert based on layout context
      const context = getInsertionContext(el);
      let insertTarget;
      let insertInsideSource = canAppendTranslationInside(el);

      if (insertInsideSource) {
        insertTarget = el;
        block.classList.add('in-source-element');
      } else if (context === 'table-cell') {
        // Find the td/th ancestor and append inside it
        let cell = el.parentElement;
        while (cell && cell.tagName !== 'TD' && cell.tagName !== 'TH') {
          cell = cell.parentElement;
        }
        if (!cell) return 0;
        insertTarget = cell;
        block.classList.add('in-table-cell');
      } else if (context === 'flex-grid') {
        // Append inside source element to avoid creating a new flex/grid item
        insertTarget = el;
        block.classList.add('in-flex-container');
      } else {
        // Normal flow: insert as sibling after source element
        if (!el.parentNode) return 0;
        insertTarget = el;
        block.classList.add('in-normal-flow');
      }

      syncTranslationBlockLayout(insertTarget, block);

      for (const sentence of matched) {
        const span = document.createElement('span');
        span.className = 'adaptive-translation-target-sentence';
        span.dataset.adaptiveTranslationSentenceId = String(sentence.id);
        span.textContent = translationById.get(sentence.id);
        block.appendChild(span);
      }

      if (!insertInsideSource && context === 'normal' && el.tagName !== 'LI') {
        el.parentNode.insertBefore(block, el.nextSibling);
      } else {
        insertTarget.appendChild(block);
      }

      attachSentenceHover(el, block);
      return matched.length;
    } finally {
      isRendering = false;
      ignoreMutationsUntil = Date.now() + 1000;
    }
  }

  function renderAnnotations(el, annotations) {
    if (!annotations || annotations.length === 0) return 0;

    let insertedCount = 0;
    isRendering = true;

    try {
      const sorted = [...annotations]
        .filter(item => item && item.word && item.translation && !isSameAnnotationGloss(item.word, item.translation))
        .sort((a, b) => b.word.length - a.word.length);

      for (const { word, translation } of sorted) {
        const textNodes = collectTextNodes(el);

        for (const textNode of textNodes) {
          const parentElement = textNode.parentElement;
          if (!parentElement ||
              parentElement.classList.contains('adaptive-translation-annotation') ||
              parentElement.classList.contains('adaptive-translation-translation') ||
              parentElement.closest('.adaptive-translation-paragraph-translation')) {
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
            span.className = 'adaptive-translation-annotation';
            span.textContent = matched;

            const trans = document.createElement('span');
            trans.className = 'adaptive-translation-translation';
            trans.textContent = `(${translation})`;

            const parent = textNode.parentNode;
            if (!parent) continue;
            if (before) parent.insertBefore(document.createTextNode(before), textNode);
            parent.insertBefore(span, textNode);
            parent.insertBefore(trans, textNode);
            if (after) parent.insertBefore(document.createTextNode(after), textNode);
            parent.removeChild(textNode);

            // Adjust translation color for background contrast
            const bgRgb = getEffectiveBgColor(trans);
            const safeColor = getContrastSafeColor(translationColor, bgRgb);
            if (safeColor !== translationColor) {
              trans.style.color = safeColor;
            }

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

  function normalizeAnnotationComparableText(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .replace(/^[（(【\[]+|[）)】\]]+$/g, '')
      .replace(/[\s·・,，.。;；:：'"“”‘’_-]+/g, '');
  }

  function isSameAnnotationGloss(word, translation) {
    const normalizedWord = normalizeAnnotationComparableText(word);
    const normalizedTranslation = normalizeAnnotationComparableText(translation);
    return Boolean(normalizedWord && normalizedWord === normalizedTranslation);
  }

  function applyFontScale() {
    document.documentElement.style.setProperty('--at-font-scale', (fontSize / 100));
    document.documentElement.style.setProperty('--at-translation-color', translationColor);
  }

  function hideWordPopup() {
    if (activeWordPopup) {
      activeWordPopup.remove();
      activeWordPopup = null;
    }
  }

  function getSelectionAnchor(range, fallbackEvent) {
    const rect = range && typeof range.getBoundingClientRect === 'function'
      ? range.getBoundingClientRect()
      : null;

    if (rect && (rect.width > 0 || rect.height > 0)) {
      return { getBoundingClientRect: () => rect };
    }

    const x = fallbackEvent?.clientX || window.innerWidth / 2;
    const y = fallbackEvent?.clientY || window.innerHeight / 2;
    return {
      getBoundingClientRect: () => ({
        left: x,
        right: x,
        top: y,
        bottom: y,
        width: 0,
        height: 0
      })
    };
  }

  function showWordPopup(annotationEl, word, translation) {
    hideWordPopup();

    const isSaved = savedWords.has(word.toLowerCase());

    // 已收录的词显示专属气泡
    if (isSaved) {
      showSavedWordPopup(annotationEl, word);
      return;
    }

    const popup = document.createElement('div');
    popup.className = 'adaptive-translation-word-popup';

    const wordEl = document.createElement('div');
    wordEl.className = 'at-popup-word';
    wordEl.textContent = word;
    popup.appendChild(wordEl);

    const transEl = document.createElement('div');
    transEl.className = 'at-popup-translation';
    transEl.textContent = translation;
    popup.appendChild(transEl);

    const btnRow = document.createElement('div');
    btnRow.className = 'at-popup-btn-row';

    // 发音按钮
    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'at-popup-tts-btn';
    ttsBtn.innerHTML = iconSvgMarkup('volume');
    ttsBtn.title = '发音';
    ttsBtn.setAttribute('aria-label', '发音');
    ttsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakWord(word);
    });
    btnRow.appendChild(ttsBtn);

    const btn = document.createElement('button');
    btn.className = 'at-popup-btn';
    btn.textContent = '加入生词本';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      saveWordFromPopup(word, translation, annotationEl, btn);
    });
    btnRow.appendChild(btn);

    popup.appendChild(btnRow);

    // Position above the annotation
    positionPopup(popup, annotationEl);
    document.body.appendChild(popup);
    activeWordPopup = popup;
    adjustPopupPosition(popup, annotationEl);
  }

  function saveWordFromPopup(word, translation, annotationEl, btn) {
    const contextEl = annotationEl.closest('p, li, div, blockquote, h1, h2, h3, h4, h5, h6');
    const context = contextEl ? contextEl.textContent.trim().slice(0, 200) : '';

    chrome.runtime.sendMessage({
      type: 'saveWord',
      word: {
        word: word,
        translation: translation,
        level: level,
        context: context,
        sourceUrl: window.location.href,
        sourceTitle: document.title.slice(0, 100)
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        btn.textContent = '保存失败，请重试';
        btn.style.background = '#ef4444';
        btn.style.borderColor = '#ef4444';
        setTimeout(() => {
          btn.textContent = '加入生词本';
          btn.style.background = '';
          btn.style.borderColor = '';
        }, 1500);
        return;
      }
      if (response && response.ok) {
        savedWords.add(word.toLowerCase());
        annotationEl.classList.add('adaptive-translation-annotation-saved');
        btn.textContent = '已收录';
        btn.classList.add('at-popup-btn-saved');
        btn.disabled = true;
        setTimeout(hideWordPopup, 800);
      } else {
        btn.textContent = '保存失败，请重试';
        btn.style.background = '#ef4444';
        btn.style.borderColor = '#ef4444';
        setTimeout(() => {
          btn.textContent = '加入生词本';
          btn.style.background = '';
          btn.style.borderColor = '';
        }, 1500);
      }
    });
  }

  function attachAnnotationClick() {
    document.addEventListener('click', (e) => {
      // Close popup on any outside click
      if (activeWordPopup && !activeWordPopup.contains(e.target) &&
          !e.target.classList.contains('adaptive-translation-annotation')) {
        hideWordPopup();
        return;
      }

      const annotation = e.target.closest('.adaptive-translation-annotation');
      if (!annotation) return;

      e.preventDefault();
      e.stopPropagation();

      const word = annotation.textContent.trim();
      // Find the adjacent translation span
      const translationEl = annotation.nextElementSibling;
      let translation = '';
      if (translationEl && translationEl.classList.contains('adaptive-translation-translation')) {
        translation = translationEl.textContent.replace(/^\(|\)$/g, '');
      }

      if (word) {
        showWordPopup(annotation, word, translation);
      }
    });
  }

  function attachPopupDismissal() {
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') hideWordPopup();
    });
    window.addEventListener('scroll', hideWordPopup, { passive: true });
    window.addEventListener('resize', hideWordPopup);
  }

  // Attach click handler once
  attachAnnotationClick();
  attachDoubleClickCapture();
  attachPopupDismissal();

  function extractEnglishWord(node, offset) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return null;
    const text = node.textContent;
    if (!text || offset < 0 || offset > text.length) return null;

    // 向左右扩展找到完整单词边界
    let start = offset;
    let end = offset;
    while (start > 0 && /[A-Za-z']/.test(text[start - 1])) start--;
    while (end < text.length && /[A-Za-z']/.test(text[end])) end++;

    const word = text.slice(start, end).replace(/^'+|'+$/g, '');
    if (!word || word.length < 2 || !/^[A-Za-z][A-Za-z'-]*$/.test(word)) return null;
    return word;
  }

  function attachDoubleClickCapture() {
    document.addEventListener('dblclick', (e) => {
      // 忽略标注元素上的双击（标注元素走 click 逻辑）
      if (e.target.closest('.adaptive-translation-annotation')) return;
      // 忽略输入框等可编辑区域
      if (e.target.closest('input, textarea, [contenteditable="true"]')) return;

      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;

      const range = sel.getRangeAt(0);
      let word = sel.toString().trim();

      // 如果选区不是有效单词，尝试从点击位置提取
      if (!word || !/^[A-Za-z][A-Za-z'-]*$/.test(word)) {
        word = extractEnglishWord(range.startContainer, range.startOffset);
      }
      if (!word) return;

      e.preventDefault();
      const anchorEl = getSelectionAnchor(range, e);
      sel.removeAllRanges();

      const isSaved = savedWords.has(word.toLowerCase());
      if (isSaved) {
        showSavedWordPopupAt(e.target, word, anchorEl);
      } else {
        showQuickCapturePopupAt(e.target, word, anchorEl);
      }
    });
  }

  function showQuickCapturePopup(targetEl, word) {
    showQuickCapturePopupAt(targetEl, word, targetEl);
  }

  function showQuickCapturePopupAt(targetEl, word, anchorEl) {
    hideWordPopup();

    const popup = document.createElement('div');
    popup.className = 'adaptive-translation-word-popup at-popup-quick-capture';

    const wordEl = document.createElement('div');
    wordEl.className = 'at-popup-word';
    wordEl.textContent = word;
    popup.appendChild(wordEl);

    // Detail area — starts with loading, filled by API
    const detailEl = document.createElement('div');
    detailEl.className = 'at-popup-details';
    detailEl.innerHTML = '<span class="at-popup-loading">查询中…</span>';
    popup.appendChild(detailEl);

    const btnRow = document.createElement('div');
    btnRow.className = 'at-popup-btn-row';

    // 发音按钮
    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'at-popup-tts-btn';
    ttsBtn.innerHTML = iconSvgMarkup('volume');
    ttsBtn.title = '发音';
    ttsBtn.setAttribute('aria-label', '发音');
    ttsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakWord(word);
    });
    btnRow.appendChild(ttsBtn);

    // 保存按钮
    const saveBtn = document.createElement('button');
    saveBtn.className = 'at-popup-btn';
    saveBtn.textContent = '收录';
    saveBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      quickSaveWord(word, fetchedDetails, targetEl, saveBtn);
    });
    btnRow.appendChild(saveBtn);

    popup.appendChild(btnRow);
    positionPopup(popup, anchorEl);
    document.body.appendChild(popup);
    activeWordPopup = popup;
    adjustPopupPosition(popup, anchorEl);

    // Async fetch word details
    let fetchedDetails = {};

    chrome.runtime.sendMessage({ type: 'getWordDetails', word: word }, (response) => {
      if (!document.body.contains(popup)) return; // popup was closed

      if (chrome.runtime.lastError || !response?.ok || !response?.details) {
        // Fallback: try page annotation
        const pageTranslation = lookupTranslationFromPage(word);
        detailEl.innerHTML = pageTranslation
          ? `<div class="at-popup-translation">${escapeContent(pageTranslation)}</div>`
          : '<div class="at-popup-hint">暂无释义，收录后可在生词本编辑</div>';
        if (pageTranslation) fetchedDetails.translation = pageTranslation;
        return;
      }

      const d = response.details;
      fetchedDetails = d;

      let html = '';
      if (d.phonetic) html += `<span class="at-popup-phonetic">${escapeContent(d.phonetic)}</span>`;
      if (d.pos) html += `<span class="at-popup-pos">${escapeContent(d.pos)}</span>`;
      if (d.translation) html += `<div class="at-popup-translation">${escapeContent(d.translation)}</div>`;
      if (d.example) html += `<div class="at-popup-example">"${escapeContent(d.example)}"</div>`;
      detailEl.innerHTML = html || '<div class="at-popup-hint">暂无释义</div>';

      // Re-adjust popup position after content change
      adjustPopupPosition(popup, anchorEl);
    });
  }

  function escapeContent(text) {
    const el = document.createElement('span');
    el.textContent = text || '';
    return el.innerHTML;
  }

  function lookupTranslationFromPage(word) {
    const lower = word.toLowerCase();
    const annotations = document.querySelectorAll('.adaptive-translation-annotation');
    for (const ann of annotations) {
      if (ann.textContent.trim().toLowerCase() === lower) {
        const next = ann.nextElementSibling;
        if (next && next.classList.contains('adaptive-translation-translation')) {
          return next.textContent.replace(/^\(|\)$/g, '').trim();
        }
      }
    }
    return '';
  }

  function quickSaveWord(word, details, targetEl, btn) {
    const contextEl = targetEl.closest ? targetEl.closest('p, li, div, blockquote, h1, h2, h3, h4, h5, h6') : null;
    const context = contextEl ? contextEl.textContent.trim().slice(0, 200) : '';
    const d = details || {};

    chrome.runtime.sendMessage({
      type: 'saveWord',
      word: {
        word: word,
        translation: d.translation || '',
        phonetic: d.phonetic || '',
        pos: d.pos || '',
        example: d.example || '',
        level: level,
        context: context,
        sourceUrl: window.location.href,
        sourceTitle: document.title.slice(0, 100)
      }
    }, (response) => {
      if (chrome.runtime.lastError) {
        btn.textContent = '保存失败';
        btn.style.background = '#ef4444';
        setTimeout(() => {
          btn.textContent = '收录';
          btn.style.background = '';
        }, 1500);
        return;
      }
      if (response && response.ok) {
        savedWords.add(word.toLowerCase());
        btn.textContent = '已收录';
        btn.classList.add('at-popup-btn-saved');
        btn.disabled = true;
        setTimeout(hideWordPopup, 800);
      } else {
        btn.textContent = '保存失败';
        btn.style.background = '#ef4444';
        setTimeout(() => {
          btn.textContent = '收录';
          btn.style.background = '';
        }, 1500);
      }
    });
  }

  function showSavedWordPopup(targetEl, word) {
    showSavedWordPopupAt(targetEl, word, targetEl);
  }

  function showSavedWordPopupAt(targetEl, word, anchorEl) {
    hideWordPopup();

    const popup = document.createElement('div');
    popup.className = 'adaptive-translation-word-popup at-popup-saved-word';

    const wordEl = document.createElement('div');
    wordEl.className = 'at-popup-word';
    wordEl.textContent = word;
    popup.appendChild(wordEl);

    // 音标 + 发音按钮行
    const phoneticRow = document.createElement('div');
    phoneticRow.className = 'at-popup-phonetic-row';

    const phoneticEl = document.createElement('span');
    phoneticEl.className = 'at-popup-phonetic';
    phoneticRow.appendChild(phoneticEl);

    const ttsBtn = document.createElement('button');
    ttsBtn.className = 'at-popup-tts-btn';
    ttsBtn.innerHTML = iconSvgMarkup('volume');
    ttsBtn.title = '发音';
    ttsBtn.setAttribute('aria-label', '发音');
    ttsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      speakWord(word);
    });
    phoneticRow.appendChild(ttsBtn);
    phoneticRow.hidden = true;
    popup.appendChild(phoneticRow);

    // 翻译行
    const transEl = document.createElement('div');
    transEl.className = 'at-popup-translation';
    transEl.textContent = '正在读取生词本...';
    popup.appendChild(transEl);

    // 词性行
    const posEl = document.createElement('div');
    posEl.className = 'at-popup-pos';
    posEl.hidden = true;
    popup.appendChild(posEl);

    // 例句行
    const exampleEl = document.createElement('div');
    exampleEl.className = 'at-popup-example';
    exampleEl.hidden = true;
    popup.appendChild(exampleEl);

    // 详情按钮
    const detailBtn = document.createElement('button');
    detailBtn.className = 'at-popup-detail-btn';
    detailBtn.textContent = '加载更多详情';
    detailBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      loadWordDetails(word, phoneticEl, transEl, posEl, exampleEl, detailBtn);
    });
    popup.appendChild(detailBtn);

    // 已收录标签
    const savedTag = document.createElement('div');
    savedTag.className = 'at-popup-saved-tag';
    savedTag.textContent = '已收录';
    popup.appendChild(savedTag);

    positionPopup(popup, anchorEl);
    document.body.appendChild(popup);
    activeWordPopup = popup;
    adjustPopupPosition(popup, anchorEl);

    // 立即加载已有数据
    chrome.storage.local.get(['vocabulary'], (data) => {
      const vocab = data.vocabulary || [];
      const found = vocab.find(w => w.word.toLowerCase() === word.toLowerCase());
      if (found) {
        transEl.textContent = found.translation || '已收录，暂无释义';
        if (found.phonetic) {
          phoneticEl.textContent = found.phonetic;
          phoneticRow.hidden = false;
        }
        if (found.pos) {
          posEl.textContent = found.pos;
          posEl.hidden = false;
        }
        if (found.example) {
          exampleEl.textContent = found.example;
          exampleEl.hidden = false;
        }
        // 如果已有完整详情，隐藏加载按钮
        if (found.phonetic && found.pos && found.example) {
          detailBtn.hidden = true;
        }
      } else {
        transEl.textContent = '已收录，详情暂未同步';
      }
      adjustPopupPosition(popup, anchorEl);
    });
  }

  function loadWordDetails(word, phoneticEl, transEl, posEl, exampleEl, btn) {
    btn.textContent = '加载中...';
    btn.disabled = true;

    chrome.runtime.sendMessage({
      type: 'getWordDetails',
      word: word
    }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        btn.textContent = '加载失败，点击重试';
        btn.disabled = false;
        return;
      }

      const details = response.details || {};
      const phoneticRow = phoneticEl.closest('.at-popup-phonetic-row');
      if (details.phonetic) {
        phoneticEl.textContent = details.phonetic;
        if (phoneticRow) phoneticRow.hidden = false;
      }
      if (details.translation) transEl.textContent = details.translation;
      if (details.pos) {
        posEl.textContent = details.pos;
        posEl.hidden = false;
      }
      if (details.example) {
        exampleEl.textContent = details.example;
        exampleEl.hidden = false;
      }
      btn.hidden = true;

      // 缓存到 vocabulary 数据中
      if (details.phonetic || details.pos || details.example) {
        chrome.runtime.sendMessage({
          type: 'updateWordDetails',
          word: word,
          details: details
        });
      }
    });
  }

  let cachedEnglishVoice = null;

  function findEnglishVoice() {
    if (cachedEnglishVoice) return cachedEnglishVoice;
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices();
    // Prefer natural/neural US English voices
    const preferred = voices.find(v => /en[-_]US/i.test(v.lang) && /natural|neural|samantha|alex|victoria|karen|daniel|google/i.test(v.name));
    const fallback = voices.find(v => /en[-_]US/i.test(v.lang));
    const anyEnglish = voices.find(v => /^en/i.test(v.lang));
    cachedEnglishVoice = preferred || fallback || anyEnglish || null;
    return cachedEnglishVoice;
  }

  // Voices may load async; refresh cache when they become available
  if (window.speechSynthesis) {
    window.speechSynthesis.onvoiceschanged = () => { cachedEnglishVoice = null; };
  }

  function speakWord(word) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(word);
    utterance.lang = 'en-US';
    utterance.rate = 0.9;
    const voice = findEnglishVoice();
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
  }

  function positionPopup(popup, targetEl) {
    const rect = targetEl.getBoundingClientRect();
    popup.style.position = 'fixed';
    popup.style.left = `${rect.left}px`;
    popup.style.top = `${rect.top - 8}px`;
    popup.style.transform = 'translateY(-100%)';
  }

  function adjustPopupPosition(popup, targetEl) {
    const rect = targetEl.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    if (popupRect.right > window.innerWidth - 8) {
      popup.style.left = `${window.innerWidth - popupRect.width - 8}px`;
    }
    if (popupRect.top < 8) {
      popup.style.left = `${rect.left}px`;
      popup.style.top = `${rect.bottom + 8}px`;
      popup.style.transform = 'none';
    }
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

  function enqueueParagraph(el, text, runId, priority, retryCount = 0, contextType = getContextType(el), sentences = [], forceAnnotationOnly = false) {
    const state = paragraphStates.get(el);
    if (state === 'queued-high' || state === 'queued-low' || state === 'processing' || state === 'done' || state === 'ignored' || state === 'retrying') {
      if (priority === 'high' && state === 'queued-low') {
        lowPriorityQueue = lowPriorityQueue.filter(item => item.el !== el);
        highPriorityQueue.push({ el, text, runId, retryCount, contextType, sentences, forceAnnotationOnly });
        paragraphStates.set(el, 'queued-high');
      }
      return;
    }

    if (priority === 'high') {
      highPriorityQueue.push({ el, text, runId, retryCount, contextType, sentences, forceAnnotationOnly });
      paragraphStates.set(el, 'queued-high');
    } else {
      lowPriorityQueue.push({ el, text, runId, retryCount, contextType, sentences, forceAnnotationOnly });
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

  // 判断元素是否为纯交互容器（子元素全是 button/input/select/a，自身几乎无文本）
  function isInteractiveOnlyContainer(el) {
    if (!el.children || el.children.length === 0) return false;
    const INTERACTIVE_TAGS = new Set(['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
    for (const child of el.children) {
      if (INTERACTIVE_TAGS.has(child.tagName) || child.closest('a[href]')) continue;
      return false;
    }
    return getDirectTextLength(el) <= 5;
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

    // 跳过纯交互容器（如按钮组 div），避免把按钮文本当成段落翻译
    if (isInteractiveOnlyContainer(el)) {
      return false;
    }

    const directTextLength = getDirectTextLength(el);
    const totalTextLength = el.textContent.trim().length || (el.getAttribute && (el.getAttribute('aria-label') || '').trim().length);
    if (scanMode === 'full') {
      // 容器元素最低 4 字符，过滤 OK / Go 等 UI 微文案；语义元素不受影响
      return directTextLength >= 4 || totalTextLength >= 4;
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
    if (!runState.shouldAccept(runId)) {
      return false;
    }

    const nextRetryCount = (item.retryCount || 0) + 1;
    if (nextRetryCount > MAX_RETRY_COUNT) {
      return false;
    }

    paragraphStates.set(item.el, 'retrying');

    const timer = setTimeout(() => {
      retryTimers.delete(timer);
      if (!runState.shouldAccept(runId)) return;

      paragraphStates.delete(item.el);
      enqueueParagraph(
        item.el,
        item.text,
        runId,
        isNearViewport(item.el) ? 'high' : 'low',
        nextRetryCount,
        item.contextType,
        item.sentences,
        item.forceAnnotationOnly
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
    if (!runState.shouldAccept(runId) || pendingCollectTimer) {
      return;
    }

    pendingCollectTimer = setTimeout(() => {
      pendingCollectTimer = null;
      collectParagraphs(runId);
    }, BACKGROUND_COLLECT_DELAY_MS);
  }

  function hasPendingWork(runId) {
    return countInFlightForRun(runId) > 0 ||
      contentCore.countQueuedItemsForRun(highPriorityQueue, lowPriorityQueue, runId) > 0;
  }

  function updateSettledStatus(runId) {
    if (hasPendingWork(runId)) return;

    if (failedCount > 0) {
      const message = annotatedCount > 0 || translatedParagraphCount > 0
        ? `已完成部分内容：标注 ${annotatedCount} 处，翻译 ${translatedParagraphCount} 段；${failedCount} 段未成功`
        : '标注失败，请检查接口配置或网络后重试';
      updateStatus('error', message);
      return;
    }

    updateStatus(
      'completed',
      annotatedCount > 0 || translatedParagraphCount > 0
        ? `已完成，已标注 ${annotatedCount} 处，已翻译 ${translatedParagraphCount} 段`
        : '已完成，当前页面没有可标注内容'
    );
    scheduleBackgroundCollect(runId);
  }

  function collectParagraphs(runId) {
    if (!runState.shouldAccept(runId)) return;

    const forceAnnotationOnly = contentCore.shouldForceAnnotationOnlyForCollect(pageStatus.state);
    const elements = getTextElements();
    const candidates = [];

    for (const el of elements) {
      const state = paragraphStates.get(el);
      if (state === 'processing' || state === 'done' || state === 'error' || state === 'ignored' || state === 'queued-high' || state === 'queued-low' || state === 'retrying') {
        continue;
      }

      // Skip elements no longer in the DOM (dynamic content that was removed)
      if (!document.contains(el)) {
        paragraphStates.set(el, 'ignored');
        continue;
      }

      // Skip hidden elements (carousel items, tabs, collapsed sections)
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        paragraphStates.set(el, 'ignored');
        continue;
      }

      let text = el.textContent.trim();
      if (!text && el.getAttribute) {
        text = (el.getAttribute('aria-label') || '').trim();
      }
      const contextType = getContextType(el);
      const minTextLength = scanMode === 'full' ? 2 : 20;
      if (text.length < minTextLength || !isEnglishText(text)) {
        paragraphStates.set(el, 'ignored');
        continue;
      }

      const rect = el.getBoundingClientRect();

      // Skip zero-dimension elements (likely in CSS transition or hidden overflow)
      if (rect.width < 10 || rect.height < 5) {
        paragraphStates.set(el, 'ignored');
        continue;
      }

      const sentences = splitIntoSentences(text);
      candidates.push({
        el,
        text,
        sentences,
        contextType,
        forceAnnotationOnly,
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
      enqueueParagraph(item.el, item.text, runId, item.priority, 0, item.contextType, item.sentences, item.forceAnnotationOnly);
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
    if (!runState.shouldAccept(runId)) return;

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
    // Skip if element was removed from DOM while waiting in queue
    if (!document.contains(item.el)) {
      paragraphStates.delete(item.el);
      return;
    }

    const request = { runId };
    inFlightRequests.add(request);
    paragraphStates.set(item.el, 'processing');
    const shouldTranslateParagraph =
      !item.forceAnnotationOnly &&
      shouldRequestParagraphTranslation(item.contextType, item.text, item.sentences);

    try {
      const result = await chrome.runtime.sendMessage({
        type: 'annotate',
        text: item.text,
        contextType: item.contextType,
        scanMode,
        paragraphTranslationMode: shouldTranslateParagraph ? 'on' : 'off',
        sentences: shouldTranslateParagraph ? item.sentences : []
      });

      if (!runState.shouldAccept(runId)) return;

      // 元素可能在 await 期间被页面移除，避免渲染到脱离 DOM 的节点
      if (!document.contains(item.el)) {
        paragraphStates.set(item.el, 'done');
        return;
      }

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
      const sentenceTranslations = result?.sentenceTranslations || [];
      if (shouldTranslateParagraph && sentenceTranslations.length > 0) {
        const translatedCount = renderParagraphTranslation(item.el, item.sentences, sentenceTranslations);
        if (translatedCount > 0) {
          translatedParagraphCount += 1;
        }
      }
      if (annotations.length > 0) {
        const insertedCount = renderAnnotations(item.el, annotations);
        if (insertedCount > 0) {
          annotatedCount += insertedCount;
        } else {
          skippedRenderCount += 1;
        }
      }
      paragraphStates.set(item.el, 'done');
    } catch (err) {
      console.warn('AdaptiveTranslation: annotation request failed', err);
      if (runState.shouldAccept(runId) && scheduleRetry(item, runId)) {
        return;
      }
      if (runId === runState.getRunId()) {
        paragraphStates.set(item.el, 'error');
        failedCount += 1;
        updateStatus('error', '标注请求失败，请检查接口配置或网络后重试');
      }
    } finally {
      inFlightRequests.delete(request);
      if (runState.shouldAccept(runId)) {
        pumpQueue(runId);
        updateSettledStatus(runId);
      }
    }
  }

  async function startAnnotating() {
    if (runState.isRunning()) return;

    

    const startedRunId = runState.start();
    if (!startedRunId) return;
    // Register this tab so navigation auto-translates the next page
    chrome.runtime.sendMessage({ type: 'registerTranslatingTab' });
    paragraphStates = new WeakMap();
    highPriorityQueue = [];
    lowPriorityQueue = [];
    annotatedCount = 0;
    translatedParagraphCount = 0;
    failedCount = 0;
    skippedRenderCount = 0;
    clearPendingCollect();
    const runId = startedRunId;

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
    runState.stop();
    // Unregister this tab from auto-translate tracking
    chrome.runtime.sendMessage({ type: 'unregisterTranslatingTab' });
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
      document.querySelectorAll('.adaptive-translation-paragraph-translation').forEach(el => {
        el.remove();
      });
      // 先删翻译括号，再还原加粗词
      document.querySelectorAll('.adaptive-translation-translation').forEach(el => {
        el.remove();
      });
      document.querySelectorAll('.adaptive-translation-annotation').forEach(el => {
        const text = document.createTextNode(el.textContent);
        if (el.parentNode) el.parentNode.replaceChild(text, el);
      });
      document.querySelectorAll('.adaptive-translation-source-sentence').forEach(unwrapElement);
      document.body.normalize();
      annotatedCount = 0;
      failedCount = 0;
      skippedRenderCount = 0;
      translatedParagraphCount = 0;
    }

    updateStatus(statusState, statusMessage);
  }

  function restartAnnotating() {
    if (!runState.isRunning()) return;
    stopAnnotating();
    startAnnotating();
  }

  function unwrapElement(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) {
      parent.insertBefore(el.firstChild, el);
    }
    parent.removeChild(el);
  }

  // 设置变化只影响当前正在处理的页面，不再使用全局 enabled 自动启动。
  chrome.storage.onChanged.addListener((changes) => {
    let shouldRestart = false;

    if (changes.concurrency) {
      maxConcurrentRequests = normalizeConcurrency(changes.concurrency.newValue);
      if (runState.isRunning()) {
        pumpQueue(runState.getRunId());
      }
    }
    if (changes.level) {
      level = changes.level.newValue || 'L3';
      shouldRestart = true;
    }
    if (changes.scanMode) {
      scanMode = normalizeScanMode(changes.scanMode.newValue);
      shouldRestart = true;
    }
    if (changes.paragraphTranslationMode) {
      paragraphTranslationMode = normalizeParagraphTranslationMode(changes.paragraphTranslationMode.newValue);
      if (paragraphTranslationMode === 'off') {
        document.querySelectorAll('.adaptive-translation-paragraph-translation').forEach(el => {
          el.style.display = 'none';
        });
      } else {
        const existing = document.querySelectorAll('.adaptive-translation-paragraph-translation');
        if (existing.length > 0) {
          // 已有段落翻译 DOM，直接显示
          existing.forEach(el => { el.style.display = ''; });
        } else if (runState.isRunning()) {
          // 正在翻译但没有段落翻译 DOM（之前 mode=off），需要重翻
          shouldRestart = true;
        }
      }
    }
    if (changes.fontSize) {
      fontSize = changes.fontSize.newValue || 100;
      applyFontScale();
    }
    if (changes.translationColor) {
      translationColor = changes.translationColor.newValue || '#818cf8';
      applyFontScale();
    }
    if (changes.autoTranslate) {
      autoTranslate = changes.autoTranslate.newValue || false;
      if (autoTranslate && !runState.isRunning()) {
        runState.setDesiredEnabled(true);
        startAnnotating();
      } else if (!autoTranslate) {
        // 只有 translationEnabled 也为 false 时才停止
        chrome.storage.local.get(['translationEnabled'], (data) => {
          if (!data.translationEnabled && runState.isRunning()) {
            runState.setDesiredEnabled(false);
            stopAnnotating();
          }
        });
      }
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
      runState.setDesiredEnabled(true);
      if (!runState.isRunning() && pageStatus.state && pageStatus.state !== 'off') {
        stopAnnotating({ clearAnnotations: true, statusState: 'off', statusMessage: '准备重新翻译' });
      }
      startAnnotating()
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ error: err.message || '启动失败' }));
      return true;
    }
    if (message.type === 'stopPageAnnotating') {
      runState.setDesiredEnabled(false);
      stopAnnotating();
      sendResponse({ ok: true });
      return true;
    }
    if (message.type === 'autoStartTranslation') {
      // Background detected this tab navigated from a translating page
      if (!runState.isRunning()) {
        runState.setDesiredEnabled(true);
        startAnnotating();
      }
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
        paragraphTranslationMode = normalizeParagraphTranslationMode(settings.paragraphTranslationMode);
        fontSize = settings.fontSize || 100;
        translationColor = settings.translationColor || '#818cf8';
        autoTranslate = settings.autoTranslate || false;
        level = settings.level || 'L3';
        applyFontScale();
        runState.setDesiredEnabled(false);

        // 跨页面持久化 + 翻译续翻：只依赖 background 的判断
        const autoResult = await chrome.runtime.sendMessage({ type: 'checkAutoTranslate' });
        const shouldAutoTranslate = autoResult && autoResult.shouldTranslate;
        if (shouldAutoTranslate) {
          runState.setDesiredEnabled(true);
          startAnnotating();
        }
      }
    } catch {}
  }

  init();
})();
