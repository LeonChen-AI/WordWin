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
      .map(item => {
        const difficulty = normalizeDifficultyLevel(item.difficulty);
        return {
          word: item.word.trim().replace(/\s+/g, ' '),
          translation: item.translation.trim().replace(/\s+/g, ' '),
          ...(difficulty ? { difficulty } : {})
        };
      })
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

  function normalizeDifficultyLevel(value) {
    const match = String(value || '').toUpperCase().match(/\bL([1-6])\b/);
    return match ? `L${match[1]}` : '';
  }

  function countEnglishWords(text) {
    return (String(text || '').match(/\b[A-Za-z][A-Za-z'-]*\b/g) || []).length;
  }

  const KNOWN_TERMS_L2 = new Set([
    'about', 'account', 'blog', 'contact', 'docs', 'download', 'help', 'home',
    'learn', 'log in', 'login', 'menu', 'news', 'pricing', 'privacy', 'product',
    'products', 'search', 'settings', 'sign in', 'support', 'terms', 'user',
    'users', 'work'
  ]);

  const KNOWN_TERMS_L3 = new Set([
    'analysis', 'article', 'business', 'careers', 'commitment', 'commitments',
    'company', 'community', 'continue', 'data', 'development', 'education',
    'enterprise', 'evidence', 'explore', 'features', 'generation', 'government',
    'information', 'intelligence', 'language', 'model', 'models', 'overview',
    'performance', 'policy', 'policies', 'research', 'resources', 'safety',
    'science', 'security', 'service', 'services', 'system', 'systems', 'technology'
  ]);

  function normalizeEnglishTerm(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/[’]/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function isKnownAtOrBelowUserLevel(term, userRank) {
    const normalized = normalizeEnglishTerm(term);
    if (userRank >= 2 && KNOWN_TERMS_L2.has(normalized)) return true;
    return userRank >= 3 && KNOWN_TERMS_L3.has(normalized);
  }

  function sourceContainsTerm(source, term) {
    const normalizedSource = normalizeEnglishTerm(source);
    const normalizedTerm = normalizeEnglishTerm(term);
    if (!normalizedTerm) return false;

    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, 'i').test(normalizedSource);
  }

  function isShortStandaloneText(text, contextType) {
    const shortContexts = new Set([
      'nav', 'footer', 'toc', 'button', 'link', 'heading', 'caption',
      'list_item', 'table_cell', 'block', 'quote'
    ]);
    const normalizedContext = String(contextType || '').toLowerCase();
    const source = String(text || '').trim();
    const wordCount = countEnglishWords(source);
    if (!source || source.length > 120 || wordCount === 0) return false;
    if (wordCount <= 2) return true;
    return shortContexts.has(normalizedContext) && wordCount <= 8;
  }

  function filterAnnotationsByLevel(items, userLevel, text, contextType) {
    const normalizedUserLevel = normalizeDifficultyLevel(userLevel) || 'L3';
    const userRank = Number(normalizedUserLevel.slice(1));
    const requireDifficulty = isShortStandaloneText(text, contextType);

    return (Array.isArray(items) ? items : []).filter(item => {
      const normalizedWord = normalizeEnglishTerm(item && item.word);
      if (!sourceContainsTerm(text, normalizedWord)) return false;
      if (isKnownAtOrBelowUserLevel(normalizedWord, userRank)) return false;
      const difficulty = normalizeDifficultyLevel(item && item.difficulty);
      if (!difficulty) return !requireDifficulty;
      return Number(difficulty.slice(1)) > userRank;
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
    normalizeDifficultyLevel,
    isShortStandaloneText,
    isKnownAtOrBelowUserLevel,
    sourceContainsTerm,
    filterAnnotationsByLevel,
    isSameAnnotationGloss,
    buildAnnotationOnlyFallback
  };
});
