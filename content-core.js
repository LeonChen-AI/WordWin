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

  function escapeRegex(str) {
    return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function splitIntoSentences(text) {
    const normalized = String(text || '').replace(/\s+/g, ' ').trim();
    if (!normalized) return [];

    let segments = [];
    if (typeof Intl !== 'undefined' && Intl.Segmenter) {
      try {
        const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });
        segments = Array.from(segmenter.segment(normalized), item => item.segment.trim());
      } catch {
        segments = [];
      }
    }

    if (segments.length === 0) {
      segments = normalized
        .split(/(?<=[.!?])\s+(?=[A-Z0-9"“'(\[])/)
        .map(item => item.trim());
    }

    return segments
      .filter(item => item.length >= 8 && /[A-Za-z]/.test(item))
      .slice(0, 12)
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
    return pageState === 'completed';
  }

  return {
    countQueuedItemsForRun,
    shouldForceAnnotationOnlyForCollect,
    isEnglishText,
    escapeRegex,
    splitIntoSentences
  };
});
