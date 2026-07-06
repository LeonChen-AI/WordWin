// AdaptiveTranslation Background Core
// Pure helpers shared by the extension service worker and Node regression tests.

(function (root, factory) {
  'use strict';

  const createAdaptiveTranslationBackgroundCore = factory;
  const core = createAdaptiveTranslationBackgroundCore();

  if (root) {
    root.AdaptiveTranslationBackgroundCore = core;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { createAdaptiveTranslationBackgroundCore };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAdaptiveTranslationBackgroundCore() {
  'use strict';

  function extractBalancedJSON(content) {
    const source = String(content || '').trim();
    const start = source.search(/[\[{]/);
    if (start === -1) return source;

    const open = source[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const char = source[i];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === '\\') {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }

      if (char === '"') {
        inString = true;
      } else if (char === open) {
        depth += 1;
      } else if (char === close) {
        depth -= 1;
        if (depth === 0) {
          return source.slice(start, i + 1);
        }
      }
    }

    return source;
  }

  // 轻量修复 LLM 常见的 JSON 格式问题：尾逗号、多余逗号
  function repairLooseJSON(str) {
    return String(str || '')
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/\{\s*,/g, '{')
      .replace(/,\s*$/g, '');
  }

  function parseJSONValue(content) {
    const source = String(content || '').trim();
    const codeBlockMatch = source.match(/```(?:json)?\s*([\s\S]*?)```/);
    const jsonStr = codeBlockMatch
      ? codeBlockMatch[1].trim()
      : extractBalancedJSON(source);

    try {
      return JSON.parse(jsonStr);
    } catch {
      // 尝试轻量修复后再解析
      return JSON.parse(repairLooseJSON(jsonStr));
    }
  }

  function normalizeAnnotations(items) {
    if (!Array.isArray(items)) {
      throw new Error('annotations must be an array');
    }

    const seenWords = new Set();

    return items
      .filter(item =>
        item &&
        typeof item.word === 'string' &&
        typeof item.translation === 'string' &&
        item.word.trim() &&
        item.translation.trim() &&
        !/[\r\n]/.test(item.word)
      )
      .map(item => ({
        word: item.word.trim().replace(/\s+/g, ' '),
        translation: item.translation.trim().replace(/\s+/g, ' ')
      }))
      .filter(item =>
        item.word.length <= 80 &&
        item.translation.length <= 40 &&
        !isSameAnnotationGloss(item.word, item.translation)
      )
      .filter(item => {
        const key = item.word.toLowerCase();
        if (seenWords.has(key)) return false;
        seenWords.add(key);
        return true;
      });
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

  function buildAnnotationOnlyFallback(annotations, error, fallbackError) {
    const warning = error && error.message ? error.message : String(error || 'Paragraph translation failed');
    const fallbackWarning = fallbackError && fallbackError.message ? fallbackError.message : '';

    return {
      annotations: Array.isArray(annotations) ? annotations : [],
      sentenceTranslations: [],
      warning,
      fallbackWarning
    };
  }

  return {
    parseJSONValue,
    repairLooseJSON,
    normalizeAnnotations,
    isSameAnnotationGloss,
    buildAnnotationOnlyFallback
  };
});
