// AdaptiveTranslation Content Core
// Pure helpers shared by the browser content script and Node regression tests.

(function (root, factory) {
  'use strict';

  const createAdaptiveTranslationCore = factory;
  const core = createAdaptiveTranslationCore();

  if (root) {
    root.AdaptiveTranslationCore = core;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createAdaptiveTranslationCore };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAdaptiveTranslationCore() {
  'use strict';

  function isEnglishText(text) {
    const source = String(text || '');
    const englishChars = source.replace(/[^a-zA-Z]/g, '').length;
    return source.length > 0 && englishChars / source.length > 0.30;
  }

  // Detect each paragraph independently so bilingual pages do not need a global language setting.
  function detectTextLanguage(text) {
    const source = String(text || '');
    const han = (source.match(/\p{Script=Han}/gu) || []).length;
    const latin = (source.match(/[A-Za-z]/g) || []).length;
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(source)) return null;
    if (han >= 2 && han / Math.max(1, han + latin) >= 0.2) return 'zh';
    return isEnglishText(source) ? 'en' : null;
  }

  function escapeRegex(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function splitIntoSentences(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];

    let segments = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const segmenter = new Intl.Segmenter(detectTextLanguage(normalized) || 'en', { granularity: 'sentence' });
        segments = Array.from(segmenter.segment(normalized), item => item.segment.trim());
      } catch {
        segments = [];
      }
    }

    if (segments.length === 0) {
      segments = normalized
        .split(/(?<=[。！？])\s*|(?<=[.!?])\s+(?=[A-Z0-9"“'(\[])/)
        .map(item => item.trim());
    }

    return segments
      .filter(item => /[A-Za-z\p{Script=Han}]/u.test(item))
      .flatMap(item => {
        const chunks = [];
        let rest = item;
        const limit = detectTextLanguage(item) === 'zh' ? 400 : 1600;
        while (rest.length > limit) {
          const space = rest.lastIndexOf(' ', limit);
          const end = space > limit / 2 ? space : limit;
          chunks.push(rest.slice(0, end));
          rest = rest.slice(end).trimStart();
        }
        if (rest) chunks.push(rest);
        return chunks;
      })
      .map((item, index) => ({
        id: index + 1,
        text: item
      }));
  }

  function countQueuedItemsForRun(highPriorityQueue, lowPriorityQueue, runId) {
    const highCount = Array.isArray(highPriorityQueue)
      ? highPriorityQueue.filter(item => item && item.runId === runId).length
      : 0;
    const lowCount = Array.isArray(lowPriorityQueue)
      ? lowPriorityQueue.filter(item => item && item.runId === runId).length
      : 0;
    return highCount + lowCount;
  }

  function shouldForceAnnotationOnlyForCollect(pageState) {
    return false;
  }

  return {
    countQueuedItemsForRun,
    shouldForceAnnotationOnlyForCollect,
    isEnglishText,
    detectTextLanguage,
    escapeRegex,
    splitIntoSentences
  };
});
