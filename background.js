// AdaptiveTranslation Background Service Worker 0.9.1
// 负责：API 调用、单段标注、对照翻译、校准、设置读取与生词本管理

if (typeof importScripts === 'function') {
  importScripts('background-core.js');
}

const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_MODEL = 'qwen3.5-flash';
const DEFAULT_SERVICE_PROVIDER = 'aliyun';
const DEFAULT_THINKING_MODE = 'off';
const DEFAULT_SCAN_MODE = 'full';
const DEFAULT_PARAGRAPH_TRANSLATION_MODE = 'on';
const REQUEST_TIMEOUT_MS = 45000;
const FULL_COVERAGE_CONTEXT_TYPES = new Set(['nav', 'footer', 'toc', 'button', 'link', 'heading', 'caption']);
const TOKEN_USAGE_BUCKET_MS = 60 * 1000;
const TOKEN_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_USAGE_MAX_BUCKETS = 10000;

let tokenUsageWriteChain = Promise.resolve();
const backgroundCore = globalThis.AdaptiveTranslationBackgroundCore;

// Track tabs that are actively translating for "continue translating" behavior
const translatingTabs = new Set();

// --- 翻译结果缓存 ---
const TRANSLATION_CACHE_MAX = 500;
const translationCache = new Map(); // key -> { annotations, sentenceTranslations, ts }

function hashCachePart(value) {
  const input = String(value || '');
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

function getCacheSignature(settings) {
  const provider = normalizeServiceProvider(settings.serviceProvider, settings.baseUrl);
  const promptTemplate = resolvePromptTemplate(settings.customPrompt);
  return [
    provider,
    String(settings.baseUrl || '').replace(/\/+$/, ''),
    settings.model || DEFAULT_MODEL,
    normalizeThinkingMode(settings.thinkingMode),
    hashCachePart(promptTemplate)
  ].join('|');
}

function getCacheKey(text, level, scanMode, paragraphTranslationMode, settings) {
  return [
    getCacheSignature(settings),
    level,
    scanMode,
    paragraphTranslationMode,
    hashCachePart(text)
  ].join('|');
}

function getCachedTranslation(text, level, scanMode, paragraphTranslationMode, settings) {
  const key = getCacheKey(text, level, scanMode, paragraphTranslationMode, settings);
  const entry = translationCache.get(key);
  if (!entry) return null;
  // Move to end (most recently used)
  translationCache.delete(key);
  translationCache.set(key, entry);
  return { annotations: entry.annotations, sentenceTranslations: entry.sentenceTranslations };
}

function setCachedTranslation(text, level, scanMode, paragraphTranslationMode, settings, result) {
  const key = getCacheKey(text, level, scanMode, paragraphTranslationMode, settings);
  // Evict oldest if at capacity
  if (translationCache.size >= TRANSLATION_CACHE_MAX) {
    const oldestKey = translationCache.keys().next().value;
    translationCache.delete(oldestKey);
  }
  translationCache.set(key, {
    annotations: result.annotations || [],
    sentenceTranslations: result.sentenceTranslations || [],
    ts: Date.now()
  });
}

const SERVICE_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  aliyun: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.5-flash'
  },
  volcengine: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-0-pro-260215'
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash'
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6'
  },
  minimax: {
    baseUrl: 'https://api.minimaxi.chat/v1',
    model: 'MiniMax-M3'
  }
};

const LEVEL_PROFILES = {
  L1: {
    reference: '基础词汇，约1500词。',
    maxPerParagraph: 30,
    strategy: `参考义务教育英语课程标准词汇范围，用户实际有效掌握通常低于大纲标准。
认识的词：日常生活最基本的动词（go, come, eat, see, want）、名词（water, food, book, school）、形容词（good, bad, big, small）和功能词（the, a, is, in, to, and）。简单数字、颜色、家庭成员。
不认识的词：超出最基础口语范围的大部分实义词，包括稍长的多音节词（convenient, environment, available, improve）、常见搭配短语（in terms of, as a result, take into account）、有抽象含义的词（significant, approach, potential, consider）。
标注策略：绝大多数实义词和短语都需要标注，通常每段 10-20 个词左右。`
  },
  L2: {
    reference: '进阶词汇，约3500词。',
    maxPerParagraph: 30,
    strategy: `参考普通高中英语课程标准词汇范围，用户实际有效掌握通常低于大纲标准。
认识的词：日常高频词汇，包括常见动词（make, work, help, think, use）、常见名词（people, problem, information, system）、常见形容词（important, different, possible）和基础短语（such as, because of, in order to）。
不认识的词：高中词汇表中较难的部分（comprehensive, substantial, demonstrate, evaluate）、学术性词汇（hypothesis, methodology）、正式书面用语（consequently, whereas, furthermore）、较长多音节词（infrastructure, interdisciplinary, acknowledgment）和不常见短语搭配。
标注策略：中低频词、抽象表达和正式用语需要标注，日常高频词不标。通常每段标注 6-12 个词左右。`
  },
  L3: {
    reference: '大学四级词汇，约4500词。',
    maxPerParagraph: 30,
    strategy: `参考CET-4考试大纲词汇范围，用户实际有效掌握通常低于大纲标准。
认识的词：日常英文阅读中的高频词汇，包括常见学术词（research, evidence, analysis）、社会话题词（economy, government, education）和中等难度形容词（important, possible, different）。新闻报道和科普文章的主体词汇基本能读懂。
不认识的词：四级词汇表中较难的部分（initiative, substantial, comprehensive, accommodate）、学术专用词（autonomous, paradigm, empirical, hypothesis）、正式书面表达（consequently, furthermore, whereas, notwithstanding）、专业领域短语（peer review, statistical significance）和较长多音节词。
标注策略：只标注中低频学术词、正式书面表达和语义不直观的专业短语。通常每段标注 3-6 个词左右。`
  },
  L4: {
    reference: '六级或考研词汇，约5500词。',
    maxPerParagraph: 30,
    strategy: `参考CET-6/考研英语大纲词汇范围，用户实际有效掌握通常低于大纲标准。
认识的词：能阅读大部分英文内容，涵盖新闻报道、科普文章、一般性学术摘要等。常见高级词汇（significant, approach, demonstrate）、多数学术高频词和常见短语搭配都在掌握范围内。
不认识的词：六级/考研词汇表中较难的部分（proliferation, ubiquitous, exacerbate）、低频专业术语（特定学科领域的专有表达）、罕见书面用语（古典文学或法律文本中的古旧词汇）、强语境依赖的词（某词在特定语境下有非常规含义）。
标注策略：简单段落通常不需要标注，复杂段落标注 1-2 个词，最多不超过 3 个。`
  },
  L5: {
    reference: '专业或留学词汇，约10000词以上。',
    maxPerParagraph: 30,
    strategy: `参考英语专业TEM-4/TEM-8大纲词汇范围，用户实际有效掌握通常低于大纲标准。
认识的词：覆盖文学、语言学、政治经济、自然科学等广泛专业领域。能直接阅读学术论文、专业评论等高难度文本，包括大量低频词和跨学科术语。
不认识的词：极罕见的专业术语（冷门学科分支的专有名词）、高度生僻的方言或古旧表达。
标注策略：绝大多数段落返回空数组。只标注真正极罕见的术语，通常每段最多 1 个词，宁可不标也绝不多标。`
  }
};

const LEGACY_LEVEL_MAP = {
  '初中英语': 'L1',
  '高中英语': 'L2',
  '四级 CET-4': 'L3',
  '六级 CET-6': 'L4',
  '考研/雅思': 'L4',
  'GRE/专业': 'L5'
};

const LEGACY_DEFAULT_PROMPT = `你是一个英语学习助手。用户当前的阅读等级是【{{level_code}}】。

等级参考：{{level_reference}}
标注策略：{{level_strategy}}

【硬性约束】本段最多返回 {{max_per_paragraph}} 个标注。超出此数量的一律丢弃。如果没有符合条件的词，返回空数组 []。

请阅读以下英文段落，找出该水平用户可能不认识的单词或短语，并给出简短的中文释义（基于上下文语义）。

规则：
1. 严格控制数量：标注数不得超过上面的硬性约束
2. 宁少勿多：用户更怕被打扰，而不是怕漏掉一个词
3. 释义简短（2-4个字），贴合当前上下文
4. 可以标注短语（如 "in terms of"），不局限于单词
5. 优先标注对理解全句最关键的词，次要的词宁可不标

返回 JSON 数组格式，不要返回其他内容：
[{"word": "单词或短语", "translation": "中文释义"}]

段落：
{{text}}`;

const DEFAULT_PROMPT = `你是一个英语阅读标注助手。根据用户的词汇水平，从英文段落中找出用户可能不认识的词或短语，给出简短中文释义。

用户等级：{{level_code}}
词汇水平：{{level_reference}}
标注策略：{{level_strategy}}
文本类型：{{context_hint}}

【数量约束】没有符合条件的词时返回 []。

规则：
1. 释义简短，2-5 个字，贴合当前上下文语义
2. 可以标注短语（如 "in terms of"、"by and large"），不限于单词
3. 优先标注对理解段落最关键的词，次要词宁可不标
4. 跳过专有名词（人名、地名、机构名、产品名、纯缩写），但其中有普通含义且用户大概率不认识的词除外（如 "Apex" 作为普通词意为"顶点"）
5. 专有名词多不代表整段跳过——跳过专有名词后，继续检查剩余普通词中是否有用户不认识的

返回 JSON 数组：
[{"word": "单词或短语", "translation": "中文释义"}]

段落：
{{text}}`;

const SUPPLEMENTAL_RECHECK_PROMPT = `

补漏复查：如果你倾向返回空数组，请按以下步骤再次检查：
1. 跳过所有专有名词（人名、地名、机构名、产品名）
2. 检查剩余普通词中是否有该等级用户可能不认识的词或短语
3. 对于短文本（列表项、图注、表格），尤其不要因为专有名词多就整段跳过
4. 确认仍然没有可标注的词后，才返回 []
`;

const FULL_COVERAGE_PROMPT = `

全面翻译模式补充规则：
1. 当前文本属于短文本（导航、按钮、目录、标题等），不只按”生词”判断
2. 只要是英文可见文案，尽量返回 1-4 个有助于中文用户理解的词或短语
3. 常见 UI 词也可标注，例如 Research、Learn、News、Continue reading
4. 专有名词中有普通含义的词应标注，例如 Project（项目）、Preview（预览）
5. 全大写标题按普通英文处理
`;

const FULL_COVERAGE_RECHECK_PROMPT = `

全面模式补漏：
1. 重新检查文本，短文本（导航、按钮、标题等）通常至少可返回 1 个可解释的词或短语
2. 只有完全没有英文含义时才返回 []
`;

function createAdaptiveTranslationError(message, { retryable = false } = {}) {
  const error = new Error(message);
  error.retryable = retryable;
  return error;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function normalizeContextType(contextType) {
  const normalized = String(contextType || '').toLowerCase();
  if (['paragraph', 'list_item', 'caption', 'table_cell', 'heading', 'quote', 'block', 'nav', 'footer', 'toc', 'button', 'link'].includes(normalized)) {
    return normalized;
  }
  return 'paragraph';
}

function normalizeScanMode(value) {
  return value === 'article' ? 'article' : 'full';
}

function normalizeParagraphTranslationMode(value) {
  return value === 'off' ? 'off' : 'on';
}

function getContextHint(contextType) {
  switch (normalizeContextType(contextType)) {
    case 'heading':
    case 'nav':
    case 'footer':
    case 'toc':
    case 'button':
    case 'link':
      return '短文本（标题/导航/按钮等），通常标注 1-3 个关键词即可。';
    case 'list_item':
    case 'caption':
    case 'table_cell':
      return '短文本（列表项/图注/表格），可能含专有名词，跳过专名后检查普通词。';
    default:
      return '普通正文段落。';
  }
}

function resolvePromptTemplate(customPrompt) {
  if (!customPrompt || customPrompt === LEGACY_DEFAULT_PROMPT) {
    return DEFAULT_PROMPT;
  }
  return customPrompt;
}

function shouldRunSupplementalCheck(text, level, contextType, annotations) {
  if (annotations.length > 0) return false;
  if (!['L1', 'L2', 'L3'].includes(level)) return false;

  const words = text.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || [];
  const longWords = words.filter(word => word.length >= 9);
  const normalizedContextType = normalizeContextType(contextType);

  if (normalizedContextType === 'list_item' || normalizedContextType === 'caption' || normalizedContextType === 'table_cell') {
    return words.length >= 8;
  }

  return words.length >= 14 && longWords.length >= 3;
}

function shouldUseFullCoverage(scanMode, contextType, text) {
  if (normalizeScanMode(scanMode) !== 'full') return false;

  const normalizedContextType = normalizeContextType(contextType);
  if (FULL_COVERAGE_CONTEXT_TYPES.has(normalizedContextType)) return true;

  const words = text.match(/\b[A-Za-z][A-Za-z'-]*\b/g) || [];
  return text.trim().length <= 90 && words.length > 0;
}

// 消息路由
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'annotate') {
    handleAnnotate(
      message.text,
      message.contextType,
      message.scanMode,
      message.paragraphTranslationMode,
      message.sentences
    )
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'calibrate') {
    handleCalibrate(message.text, message.level)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'getSettings') {
    chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'level', 'concurrency', 'serviceProvider', 'thinkingMode', 'scanMode', 'paragraphTranslationMode', 'fontSize', 'autoTranslate', 'translationEnabled', 'translationColor', 'providerConfigs'], (data) => {
      sendResponse(buildContentSettings(data));
    });
    return true;
  }

  if (message.type === 'saveWord') {
    handleSaveWord(message.word)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'removeWord') {
    handleRemoveWord(message.word)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'getVocabulary') {
    chrome.storage.local.get(['vocabulary'], (data) => {
      sendResponse({ vocabulary: data.vocabulary || [] });
    });
    return true;
  }

  if (message.type === 'updateWordCategory') {
    handleUpdateWordCategory(message.word, message.category)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'exportVocabulary') {
    chrome.storage.local.get(['vocabulary'], (data) => {
      sendResponse({ vocabulary: data.vocabulary || [] });
    });
    return true;
  }

  if (message.type === 'getWordDetails') {
    handleGetWordDetails(message.word)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'updateWordDetails') {
    handleUpdateWordDetails(message.word, message.details)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }

  // Tab translation tracking
  if (message.type === 'registerTranslatingTab') {
    if (sender.tab) translatingTabs.add(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'unregisterTranslatingTab') {
    if (sender.tab) translatingTabs.delete(sender.tab.id);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'checkAutoTranslate') {
    const tabId = sender.tab ? sender.tab.id : null;
    const wasTranslating = tabId !== null && translatingTabs.has(tabId);
    chrome.storage.local.get(['autoTranslate'], (data) => {
      const persistent = data.autoTranslate || false;
      sendResponse({ shouldTranslate: wasTranslating || persistent });
    });
    return true;
  }
});

// Auto-translate on navigation from translating tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' && translatingTabs.has(tabId)) {
    // Tab navigated while it was translating — auto-translate the new page
    chrome.tabs.sendMessage(tabId, { type: 'autoStartTranslation' }).catch(() => {});
  }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  translatingTabs.delete(tabId);
});

// --- 生词本操作 ---
async function handleSaveWord(wordData) {
  const data = await chrome.storage.local.get(['vocabulary']);
  const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];

  const existingIndex = vocabulary.findIndex(
    item => item.word.toLowerCase() === wordData.word.toLowerCase()
  );

  if (existingIndex >= 0) {
    vocabulary[existingIndex] = {
      ...vocabulary[existingIndex],
      ...wordData,
      word: wordData.word,
      createdAt: vocabulary[existingIndex].createdAt
    };
  } else {
    vocabulary.unshift({
      word: wordData.word || '',
      translation: wordData.translation || '',
      level: wordData.level || 'L3',
      category: wordData.category || 'learning',
      sourceUrl: wordData.sourceUrl || '',
      sourceTitle: wordData.sourceTitle || '',
      context: wordData.context || '',
      phonetic: wordData.phonetic || '',
      pos: wordData.pos || '',
      example: wordData.example || '',
      createdAt: Date.now(),
      reviewCount: 0
    });
  }

  await chrome.storage.local.set({ vocabulary });

  // Auto-enrich: if phonetic/pos/example are missing, fetch from API in background
  const savedItem = existingIndex >= 0
    ? vocabulary[existingIndex]
    : vocabulary[0];
  const needsEnrich = !savedItem.phonetic || !savedItem.pos || !savedItem.example;

  if (needsEnrich) {
    enrichWordInBackground(savedItem.word).catch(() => {});
  }

  return { ok: true, count: vocabulary.length };
}

async function enrichWordInBackground(word) {
  try {
    const result = await handleGetWordDetails(word);
    if (!result.ok || !result.details) return;

    const data = await chrome.storage.local.get(['vocabulary']);
    const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];
    const item = vocabulary.find(
      v => v.word.toLowerCase() === word.toLowerCase()
    );
    if (!item) return;

    const d = result.details;
    if (d.phonetic && !item.phonetic) item.phonetic = d.phonetic;
    if (d.pos && !item.pos) item.pos = d.pos;
    if (d.translation && !item.translation) item.translation = d.translation;
    if (d.example && !item.example) item.example = d.example;

    await chrome.storage.local.set({ vocabulary });
  } catch {
    // Silent fail — enrichment is best-effort
  }
}

async function handleRemoveWord(word) {
  const data = await chrome.storage.local.get(['vocabulary']);
  const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];
  const filtered = vocabulary.filter(
    item => item.word.toLowerCase() !== (word || '').toLowerCase()
  );
  await chrome.storage.local.set({ vocabulary: filtered });
  return { ok: true, count: filtered.length };
}

async function handleUpdateWordCategory(word, category) {
  const data = await chrome.storage.local.get(['vocabulary']);
  const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];
  const item = vocabulary.find(
    item => item.word.toLowerCase() === (word || '').toLowerCase()
  );
  if (item) {
    item.category = category || 'learning';
    await chrome.storage.local.set({ vocabulary });
  }
  return { ok: true };
}

async function handleGetWordDetails(word) {
  const settings = resolveStoredApiSettings(await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'serviceProvider', 'thinkingMode', 'providerConfigs']));
  if (!settings.apiKey) return { ok: false, error: '请先在设置中配置接口密钥' };

  const prompt = `请为英文单词 "${word}" 提供以下信息，返回 JSON 格式：
{
  "phonetic": "音标（美式，如 /ˈeksəmpl/）",
  "pos": "词性（如 n. / v. / adj.，多个词性用逗号分隔）",
  "translation": "中文释义（贴合常见用法，简短）",
  "example": "一个简短的英文例句（含该词，10-15个单词）"
}
只返回 JSON，不要其他内容。`;

  try {
    const details = await requestJSON(prompt, settings, { maxTokens: 800 });
    return { ok: true, details };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleUpdateWordDetails(word, details) {
  const data = await chrome.storage.local.get(['vocabulary']);
  const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];
  const item = vocabulary.find(
    item => item.word.toLowerCase() === (word || '').toLowerCase()
  );
  if (item && details) {
    if ('phonetic' in details) item.phonetic = details.phonetic;
    if ('pos' in details) item.pos = details.pos;
    if ('translation' in details) item.translation = details.translation;
    if ('example' in details) item.example = details.example;
    if ('level' in details) item.level = details.level;
    await chrome.storage.local.set({ vocabulary });
  }
  return { ok: true };
}

// 首次安装或更新时同步 Prompt 模板
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      enabled: false,
      translationEnabled: false,
      level: 'L3',
      concurrency: 3,
      scanMode: DEFAULT_SCAN_MODE,
      paragraphTranslationMode: DEFAULT_PARAGRAPH_TRANSLATION_MODE,
      serviceProvider: DEFAULT_SERVICE_PROVIDER,
      thinkingMode: DEFAULT_THINKING_MODE,
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      apiKey: '',
      customPrompt: DEFAULT_PROMPT,
      fontSize: 100,
      autoTranslate: false,
      vocabulary: []
    });
  } else if (details.reason === 'update') {
    chrome.storage.local.get(['customPrompt', 'baseUrl', 'model', 'concurrency', 'level', 'serviceProvider', 'thinkingMode', 'scanMode', 'paragraphTranslationMode', 'fontSize', 'autoTranslate', 'vocabulary'], (data) => {
      const updates = {};
      if (!data.customPrompt || data.customPrompt === LEGACY_DEFAULT_PROMPT) {
        updates.customPrompt = DEFAULT_PROMPT;
      }
      if (!data.baseUrl) updates.baseUrl = DEFAULT_BASE_URL;
      if (!data.model) updates.model = DEFAULT_MODEL;
      if (!data.concurrency) updates.concurrency = 3;
      if (!data.level) updates.level = 'L3';
      if (!data.serviceProvider) updates.serviceProvider = inferServiceProvider(data.baseUrl);
      if (!data.thinkingMode) updates.thinkingMode = DEFAULT_THINKING_MODE;
      if (!data.scanMode) updates.scanMode = DEFAULT_SCAN_MODE;
      if (!data.paragraphTranslationMode) updates.paragraphTranslationMode = DEFAULT_PARAGRAPH_TRANSLATION_MODE;
      if (data.fontSize === undefined) updates.fontSize = 100;
      if (data.autoTranslate === undefined) updates.autoTranslate = false;
      if (!Array.isArray(data.vocabulary)) updates.vocabulary = [];
      if (Object.keys(updates).length > 0) {
        chrome.storage.local.set(updates);
      }
    });
  }
});

// --- 单段落标注 ---
async function handleAnnotate(text, contextType, scanMode, paragraphTranslationMode, sentences) {
  const settings = resolveStoredApiSettings(await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'level', 'customPrompt', 'serviceProvider', 'thinkingMode', 'providerConfigs']));
  if (!settings.apiKey) return { error: '请先在插件设置中填写接口密钥' };
  if (text.trim().length < 2) return { annotations: [] };

  const level = normalizeLevel(settings.level);
  const normalizedScanMode = normalizeScanMode(scanMode);
  const normalizedPTM = normalizeParagraphTranslationMode(paragraphTranslationMode);

  // 检查缓存
  const cached = getCachedTranslation(text, level, normalizedScanMode, normalizedPTM, settings);
  if (cached) {
    return { annotations: cached.annotations, sentenceTranslations: cached.sentenceTranslations };
  }

  try {
    const shouldTranslateParagraph =
      normalizedPTM === 'on' &&
      Array.isArray(sentences) &&
      sentences.length > 0;

    if (shouldTranslateParagraph) {
      try {
        const result = await callRichLLM(text, sentences, level, settings, contextType, scanMode);
        setCachedTranslation(text, level, normalizedScanMode, normalizedPTM, settings, result);
        return result;
      } catch (richErr) {
        console.warn('AdaptiveTranslation: 对照翻译失败，降级为生词标注', richErr);
        try {
          const annotations = await callLLM(text, level, settings, contextType, scanMode);
          const fallback = backgroundCore.buildAnnotationOnlyFallback(annotations, richErr);
          setCachedTranslation(text, level, normalizedScanMode, normalizedPTM, settings, fallback);
          return fallback;
        } catch (fallbackErr) {
          console.warn('AdaptiveTranslation: 生词标注降级也失败', fallbackErr);
          const message = fallbackErr?.message || richErr?.message || '标注失败，请检查 API 设置或网络';
          return {
            error: message,
            retryable: Boolean(fallbackErr?.retryable || richErr?.retryable)
          };
        }
      }
    }

    const annotations = await callLLM(text, level, settings, contextType, scanMode);
    const result = { annotations, sentenceTranslations: [] };
    setCachedTranslation(text, level, normalizedScanMode, normalizedPTM, settings, result);
    return result;
  } catch (err) {
    return {
      error: err.message,
      retryable: Boolean(err.retryable)
    };
  }
}

// --- 校准处理 ---
async function handleCalibrate(text, level) {
  const settings = resolveStoredApiSettings(await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'customPrompt', 'serviceProvider', 'thinkingMode', 'providerConfigs']));
  if (!settings.apiKey) return { error: '请先在设置页配置接口密钥' };

  try {
    const annotations = await callLLM(text, level, settings, 'paragraph');
    return { annotations };
  } catch (err) {
    return {
      error: err.message,
      retryable: Boolean(err.retryable)
    };
  }
}

// --- 单段落 LLM 调用 ---
function buildPrompt(promptTemplate, text, level, profile, contextType, extraPrompt = '') {
  return promptTemplate
    .replaceAll('{{level}}', level)
    .replaceAll('{{level_code}}', level)
    .replaceAll('{{level_reference}}', profile.reference)
    .replaceAll('{{level_strategy}}', profile.strategy)
    .replaceAll('{{max_per_paragraph}}', String(profile.maxPerParagraph))
    .replaceAll('{{context_hint}}', getContextHint(contextType))
    .replace('{{text}}', text) + extraPrompt;
}

function inferServiceProvider(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('dashscope') || url.includes('aliyuncs.com/compatible-mode')) return 'aliyun';
  if (url.includes('volces.com/api/v3') || url.includes('ark.cn-beijing.volces.com')) return 'volcengine';
  if (url.includes('bigmodel.cn') || url.includes('open.bigmodel')) return 'zhipu';
  if (url.includes('deepseek.com') || url.includes('api.deepseek')) return 'deepseek';
  if (url.includes('moonshot.cn') || url.includes('api.moonshot')) return 'kimi';
  if (url.includes('minimaxi.chat') || url.includes('minimax.chat')) return 'minimax';
  if (url.includes('api.openai.com')) return 'openai';
  return DEFAULT_SERVICE_PROVIDER;
}

function normalizeServiceProvider(provider, baseUrl) {
  if (SERVICE_PRESETS[provider]) return provider;
  return inferServiceProvider(baseUrl);
}

function normalizeThinkingMode(mode) {
  return mode === 'on' ? 'on' : 'off';
}

function normalizeProviderSettings(settings) {
  settings.serviceProvider = normalizeServiceProvider(settings.serviceProvider, settings.baseUrl);
  settings.thinkingMode = normalizeThinkingMode(settings.thinkingMode);
  const preset = SERVICE_PRESETS[settings.serviceProvider] || SERVICE_PRESETS.openai;
  settings.baseUrl = settings.baseUrl || preset.baseUrl || DEFAULT_BASE_URL;
  settings.model = settings.model || preset.model || DEFAULT_MODEL;
}

function resolveStoredApiSettings(settings = {}) {
  const configs = settings.providerConfigs || {};
  const preferredProvider = normalizeServiceProvider(settings.serviceProvider, settings.baseUrl);
  const preferredConfig = configs[preferredProvider];

  if (!settings.apiKey && preferredConfig?.apiKey) {
    settings.apiKey = preferredConfig.apiKey;
    settings.baseUrl = preferredConfig.baseUrl || settings.baseUrl;
    settings.model = preferredConfig.model || settings.model;
    settings.serviceProvider = preferredProvider;
  }

  if (!settings.apiKey) {
    const fallbackProvider = Object.keys(configs).find(provider => configs[provider]?.apiKey);
    if (fallbackProvider) {
      const fallbackConfig = configs[fallbackProvider];
      settings.apiKey = fallbackConfig.apiKey;
      settings.baseUrl = fallbackConfig.baseUrl || settings.baseUrl;
      settings.model = fallbackConfig.model || settings.model;
      settings.serviceProvider = fallbackProvider;
    }
  }

  normalizeProviderSettings(settings);
  delete settings.providerConfigs;
  return settings;
}

function buildContentSettings(settings = {}) {
  const apiSettings = resolveStoredApiSettings({ ...settings });
  return {
    level: settings.level || 'L3',
    concurrency: settings.concurrency || 3,
    scanMode: normalizeScanMode(settings.scanMode),
    paragraphTranslationMode: normalizeParagraphTranslationMode(settings.paragraphTranslationMode),
    fontSize: settings.fontSize === undefined ? 100 : settings.fontSize,
    autoTranslate: Boolean(settings.autoTranslate),
    translationEnabled: Boolean(settings.translationEnabled),
    translationColor: settings.translationColor || '#818cf8',
    hasApiConfig: Boolean(apiSettings.apiKey)
  };
}

function buildChatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function getOpenAIReasoningEffort(settings) {
  const model = settings.model || '';
  if (!/(^o\d|^o[1-9]|^gpt-5)/i.test(model)) return null;
  if (settings.thinkingMode === 'on') return 'medium';
  if (/^gpt-5\.?1/i.test(model)) return 'none';
  return 'minimal';
}

function buildRequestBody(prompt, settings, maxTokens = 600) {
  const body = {
    model: settings.model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens
  };

  if (settings.serviceProvider === 'openai') {
    const effort = getOpenAIReasoningEffort(settings);
    if (effort) {
      // Reasoning models (o1, o3, o4-mini, gpt-5) don't support temperature
      body.reasoning_effort = effort;
    } else {
      body.temperature = 0.1;
    }
  }

  if (settings.serviceProvider === 'aliyun') {
    body.enable_thinking = settings.thinkingMode === 'on';
  }

  if (settings.serviceProvider === 'volcengine') {
    body.thinking = { type: settings.thinkingMode === 'on' ? 'enabled' : 'disabled' };
  }

  return body;
}

function extractMessageContent(msg) {
  if (!msg) return '';
  // Some reasoning models return results in reasoning_content with empty content
  if (msg.content && msg.content.trim()) return msg.content.trim();
  if (msg.reasoning_content && msg.reasoning_content.trim()) return msg.reasoning_content.trim();
  return '';
}

async function requestAnnotations(prompt, settings, { maxTokens = 900 } = {}) {
  const url = buildChatCompletionsUrl(settings.baseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(buildRequestBody(prompt, settings, maxTokens))
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw createAdaptiveTranslationError('API 请求超时', { retryable: true });
    }
    throw createAdaptiveTranslationError(`API 请求失败：${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw createAdaptiveTranslationError(
      `API 请求失败 (${response.status}): ${errText}`,
      { retryable: isRetryableStatus(response.status) }
    );
  }

  const data = await response.json();
  recordTokenUsage(settings, data.usage);

  if (!data.choices || data.choices.length === 0) {
    throw createAdaptiveTranslationError('API 返回格式异常：choices 为空', { retryable: true });
  }
  const msg = data.choices[0].message;
  const content = extractMessageContent(msg);
  if (!content) {
    throw createAdaptiveTranslationError('API 返回格式异常：message 内容为空', { retryable: true });
  }

  return parseJSON(content);
}

async function requestJSON(prompt, settings, { maxTokens = 900 } = {}) {
  const url = buildChatCompletionsUrl(settings.baseUrl);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify(buildRequestBody(prompt, settings, maxTokens))
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw createAdaptiveTranslationError('API 请求超时', { retryable: true });
    }
    throw createAdaptiveTranslationError(`API 请求失败：${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw createAdaptiveTranslationError(
      `API 请求失败 (${response.status}): ${errText}`,
      { retryable: isRetryableStatus(response.status) }
    );
  }

  const data = await response.json();
  recordTokenUsage(settings, data.usage);

  if (!data.choices || data.choices.length === 0) {
    throw createAdaptiveTranslationError('API 返回格式异常：choices 为空', { retryable: true });
  }
  const msg = data.choices[0].message;
  const content = extractMessageContent(msg);
  if (!content) {
    throw createAdaptiveTranslationError('API 返回格式异常：message 内容为空', { retryable: true });
  }

  return parseJSONValue(content);
}

function normalizeTokenCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') {
    return {
      hasUsage: false,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0
    };
  }

  const hasAnyUsageField =
    usage.prompt_tokens !== undefined ||
    usage.input_tokens !== undefined ||
    usage.inputTokens !== undefined ||
    usage.completion_tokens !== undefined ||
    usage.output_tokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.total_tokens !== undefined ||
    usage.totalTokens !== undefined;
  const promptTokens = normalizeTokenCount(
    usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens
  );
  const completionTokens = normalizeTokenCount(
    usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens
  );
  const explicitTotal = normalizeTokenCount(usage.total_tokens ?? usage.totalTokens);
  const totalTokens = explicitTotal || promptTokens + completionTokens;

  return {
    hasUsage: hasAnyUsageField,
    promptTokens,
    completionTokens,
    totalTokens
  };
}

function recordTokenUsage(settings, rawUsage) {
  const now = Date.now();
  const bucketStart = Math.floor(now / TOKEN_USAGE_BUCKET_MS) * TOKEN_USAGE_BUCKET_MS;
  const provider = normalizeServiceProvider(settings.serviceProvider, settings.baseUrl);
  const model = String(settings.model || '').trim() || DEFAULT_MODEL;
  const usage = normalizeUsage(rawUsage);

  tokenUsageWriteChain = tokenUsageWriteChain
    .then(async () => {
      const data = await chrome.storage.local.get(['tokenUsageBuckets']);
      const cutoff = now - TOKEN_USAGE_RETENTION_MS;
      const buckets = Array.isArray(data.tokenUsageBuckets)
        ? data.tokenUsageBuckets.filter(item => item && Number(item.bucketStart) >= cutoff)
        : [];

      let bucket = buckets.find(item =>
        item.bucketStart === bucketStart &&
        item.provider === provider &&
        item.model === model
      );

      if (!bucket) {
        bucket = {
          bucketStart,
          provider,
          model,
          requestCount: 0,
          withUsageCount: 0,
          missingUsageCount: 0,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          lastAt: now
        };
        buckets.push(bucket);
      }

      bucket.requestCount += 1;
      bucket.lastAt = now;
      if (usage.hasUsage) {
        bucket.withUsageCount += 1;
        bucket.promptTokens += usage.promptTokens;
        bucket.completionTokens += usage.completionTokens;
        bucket.totalTokens += usage.totalTokens;
      } else {
        bucket.missingUsageCount += 1;
      }

      buckets.sort((a, b) => a.bucketStart - b.bucketStart);
      const compacted = buckets.length > TOKEN_USAGE_MAX_BUCKETS
        ? buckets.slice(buckets.length - TOKEN_USAGE_MAX_BUCKETS)
        : buckets;

      await chrome.storage.local.set({ tokenUsageBuckets: compacted });
    })
    .catch(err => {
      console.warn('AdaptiveTranslation: token usage 记录失败', err);
    });

  return tokenUsageWriteChain;
}

async function callLLM(text, level, settings, contextType, scanMode = DEFAULT_SCAN_MODE) {
  const normalizedLevel = normalizeLevel(level);
  const normalizedContextType = normalizeContextType(contextType);
  const profile = LEVEL_PROFILES[normalizedLevel] || LEVEL_PROFILES.L3;
  const promptTemplate = resolvePromptTemplate(settings.customPrompt);
  const fullCoverage = shouldUseFullCoverage(scanMode, normalizedContextType, text);
  const prompt = buildPrompt(
    promptTemplate,
    text,
    normalizedLevel,
    profile,
    normalizedContextType,
    fullCoverage ? FULL_COVERAGE_PROMPT : ''
  );

  let annotations = await requestAnnotations(prompt, settings);

  if (
    shouldRunSupplementalCheck(text, normalizedLevel, normalizedContextType, annotations) ||
    (fullCoverage && annotations.length === 0)
  ) {
    const supplementalPrompt = buildPrompt(
      promptTemplate,
      text,
      normalizedLevel,
      profile,
      normalizedContextType,
      fullCoverage
        ? FULL_COVERAGE_PROMPT + FULL_COVERAGE_RECHECK_PROMPT
        : SUPPLEMENTAL_RECHECK_PROMPT
    );
    annotations = await requestAnnotations(supplementalPrompt, settings);
  }

  return annotations.slice(0, 30);
}

function buildRichPrompt(text, sentences, level, profile, contextType, scanMode) {
  const numberedSentences = sentences
    .map(item => `[${item.id}] ${item.text}`)
    .join('\n');

  return `你是一个英语阅读标注助手。用户当前阅读等级是 ${level}。

词汇水平：${profile.reference}
标注策略：${profile.strategy}
文本类型：${getContextHint(contextType)}

请完成两个任务：

任务一：生词标注
1. 找出该水平用户可能不认识的词或短语，给出简短中文释义（2-5 个字）
2. 可以标注短语，不限于单词
3. 优先标注对理解段落最关键的词，次要词宁可不标
4. 跳过专有名词（人名、地名、机构名、产品名、纯缩写），有普通含义的除外

任务二：逐句翻译
1. 将下面每个编号英文句子翻译成自然中文
2. 必须保留句子编号，不合并、不新增、不遗漏
3. 利用整段上下文，保证代词、术语和逻辑关系准确

只返回 JSON：
{
  "annotations": [{"word": "英文词或短语", "translation": "中文释义"}],
  "sentences": [{"id": 1, "translation": "第 1 句中文翻译"}]
}

完整段落：
${text}

编号句子：
${numberedSentences}`;
}

async function callRichLLM(text, sentences, level, settings, contextType, scanMode = DEFAULT_SCAN_MODE) {
  const normalizedLevel = normalizeLevel(level);
  const normalizedContextType = normalizeContextType(contextType);
  const profile = LEVEL_PROFILES[normalizedLevel] || LEVEL_PROFILES.L3;
  const normalizedSentences = normalizeInputSentences(sentences);

  if (normalizedSentences.length === 0) {
    const annotations = await callLLM(text, normalizedLevel, settings, normalizedContextType, scanMode);
    return { annotations, sentenceTranslations: [] };
  }

  const prompt = buildRichPrompt(
    text,
    normalizedSentences,
    normalizedLevel,
    profile,
    normalizedContextType,
    scanMode
  );
  const parsed = await requestJSON(prompt, settings, { maxTokens: 1400 });
  const annotations = normalizeAnnotations(parsed.annotations || [])
    .slice(0, 30);
  const sentenceTranslations = normalizeSentenceTranslations(parsed.sentences || [], normalizedSentences);

  return { annotations, sentenceTranslations };
}

// --- JSON 解析（处理 markdown 代码块包裹） ---
function parseJSONValue(content) {
  try {
    return backgroundCore.parseJSONValue(content);
  } catch {
    console.error('AdaptiveTranslation: LLM 返回解析失败:', content);
    throw createAdaptiveTranslationError('LLM 返回解析失败：不是合法 JSON', { retryable: true });
  }
}

function normalizeAnnotations(items) {
  try {
    return backgroundCore.normalizeAnnotations(items);
  } catch {
    throw createAdaptiveTranslationError('LLM 返回格式异常：annotations 不是数组', { retryable: true });
  }
}

function normalizeInputSentences(sentences) {
  if (!Array.isArray(sentences)) return [];

  return sentences
    .map(item => ({
      id: Number.parseInt(item.id, 10),
      text: String(item.text || '').trim()
    }))
    .filter(item => Number.isInteger(item.id) && item.id > 0 && item.text.length > 0)
    .slice(0, 12);
}

function normalizeSentenceTranslations(items, sourceSentences) {
  if (!Array.isArray(items)) {
    throw createAdaptiveTranslationError('LLM 返回格式异常：sentences 不是数组', { retryable: true });
  }

  const sourceIds = new Set(sourceSentences.map(item => item.id));
  const seen = new Set();
  return items
    .map(item => ({
      id: Number.parseInt(item.id, 10),
      translation: String(item.translation || '').trim().replace(/\s+/g, ' ')
    }))
    .filter(item => {
      if (!Number.isInteger(item.id) || !sourceIds.has(item.id) || seen.has(item.id)) return false;
      if (!item.translation || item.translation.length > 600) return false;
      seen.add(item.id);
      return true;
    });
}

function parseJSON(content) {
  try {
    const parsed = parseJSONValue(content);
    if (!Array.isArray(parsed)) {
      throw createAdaptiveTranslationError('LLM 返回格式异常：不是 JSON 数组', { retryable: true });
    }

    return normalizeAnnotations(parsed);
  } catch (err) {
    if (err.retryable) {
      throw err;
    }
    console.error('AdaptiveTranslation: LLM 返回解析失败:', content);
    throw createAdaptiveTranslationError('LLM 返回解析失败：不是合法 JSON', { retryable: true });
  }
}

function normalizeLevel(level) {
  if (LEVEL_PROFILES[level]) return level;
  return LEGACY_LEVEL_MAP[level] || 'L3';
}
