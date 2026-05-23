// WordWin Background Service Worker v5
// 负责：API 调用、单段标注、校准与设置读取

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_SERVICE_PROVIDER = 'openai';
const DEFAULT_THINKING_MODE = 'off';
const DEFAULT_SCAN_MODE = 'full';
const REQUEST_TIMEOUT_MS = 45000;
const FULL_COVERAGE_CONTEXT_TYPES = new Set(['nav', 'footer', 'toc', 'button', 'link', 'heading', 'caption']);
const TOKEN_USAGE_BUCKET_MS = 60 * 1000;
const TOKEN_USAGE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_USAGE_MAX_BUCKETS = 10000;

let tokenUsageWriteChain = Promise.resolve();

const SERVICE_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini'
  },
  aliyun: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus'
  },
  volcengine: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1-5-pro-32k-250115'
  }
};

const LEVEL_PROFILES = {
  L1: {
    reference: '约等于 IELTS 2 分及以下。',
    maxPerParagraph: 20,
    strategy: '几乎没有英语阅读基础。除了 the/a/is/in/to/and/of 等最基本的功能词和 I/you/he/she/it 等代词外，绝大多数实义词都需要标注。包括常见动词（improve, create）、常见名词（model, skill）、常见形容词（better, larger）和常见短语。每段标注 10-20 个词。'
  },
  L2: {
    reference: '约等于 IELTS 4 分。',
    maxPerParagraph: 12,
    strategy: '具备基础阅读能力，认识常见的简单词汇（如 good, make, work, people）。但中等难度的词（如 evaluate, comprehensive, demonstrate）和大部分短语都不认识。标注中低频词、抽象词、较长词和不常见短语。每段标注 6-12 个词。'
  },
  L3: {
    reference: '约等于 IELTS 5.5 分。',
    maxPerParagraph: 6,
    strategy: '能读懂大部分日常内容，但会被学术词汇、书面表达和不常见短语卡住。只标注中低频的学术词（如 autonomous, predecessor, multidisciplinary）、专业表达和语义不直观的短语。每段标注 3-6 个词。'
  },
  L4: {
    reference: '约等于 IELTS 7 分。',
    maxPerParagraph: 3,
    strategy: '能流畅阅读大部分英文内容，词汇量较大。只标注低频专业术语、罕见书面表达和强语境依赖的词。绝大多数段落只需标注 1-2 个词，简单段落应返回空数组。每段最多 3 个词。'
  },
  L5: {
    reference: '约等于 IELTS 8 分及以上。',
    maxPerParagraph: 1,
    strategy: '接近母语阅读水平，几乎所有英文内容都能直接理解。只标注极罕见的专业术语或生僻表达（如某个学科的专有名词）。绝大多数段落应返回空数组。每段最多 1 个词，宁可不标也绝不多标。'
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

const DEFAULT_PROMPT = `你是一个英语学习助手。用户当前的阅读等级是【{{level_code}}】。

等级参考：{{level_reference}}
标注策略：{{level_strategy}}
当前文本类型：{{context_hint}}

【硬性约束】本段最多返回 {{max_per_paragraph}} 个标注。超出此数量的一律丢弃。如果没有符合条件的词，返回空数组 []。

请阅读以下英文段落，找出该水平用户可能不认识的单词或短语，并给出简短的中文释义（基于上下文语义）。

规则：
1. 严格控制数量：标注数不得超过上面的硬性约束
2. 宁少勿多：用户更怕被打扰，而不是怕漏掉一个词
3. 释义简短（2-4个字），贴合当前上下文
4. 可以标注短语（如 "in terms of"），不局限于单词
5. 优先标注对理解全句最关键的词，次要的词宁可不标
6. 不要把人名、地名、机构名、模型名、评测名、产品名、纯缩写当成优先标注对象，除非它本身就是理解核心且该等级用户大概率不认识
7. 即使一段里专有名词很多，也不要因此整段返回空。跳过这些专有名词后，继续检查剩余普通词里是否仍有 1-2 个真正会卡住用户的词
8. 对于列表项、脚注、图注、表格说明这类短文本，只要还有会影响理解的普通难词，应尽量标出 1-2 个

返回 JSON 数组格式，不要返回其他内容：
[{"word": "单词或短语", "translation": "中文释义"}]

段落：
{{text}}`;

const SUPPLEMENTAL_RECHECK_PROMPT = `

补漏复查：
如果你第一次倾向返回空数组，请先做一次二次检查：
1. 先忽略所有人名、地名、机构名、模型名、评测名、产品名、纯缩写
2. 再从剩余普通词或短语里，尽量找出 1-2 个该等级用户仍可能卡住的点
3. 对于列表项、脚注、图注、表格说明，尤其不要因为专有名词很多就整项返回空
4. 只有在重新检查后仍然没有合适对象时，才返回 []
`;

const FULL_COVERAGE_PROMPT = `

全面翻译模式补充：
当前文本如果是导航、按钮、目录、标题或较短页面文案，不要只按“生词”判断。只要是英文可见文案，尽量返回 1-4 个最有助于中文用户理解的词或短语。
常见 UI 词也可以标注，例如 Research、Learn、News、Continue reading。
专有名词可以跳过，但其中有普通含义的词可以标注，例如 Project、Preview、Security。
标题即使是全大写，也按普通英文标题处理。
`;

const FULL_COVERAGE_RECHECK_PROMPT = `

全面模式补漏：
如果刚才你倾向返回 []，请再检查一次。对于英文短文本、导航、按钮、目录和标题，通常至少返回 1 个可解释的词或短语；只有完全没有英文含义时才返回 []。
`;

function createWordwinError(message, { retryable = false } = {}) {
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

function getContextHint(contextType) {
  switch (normalizeContextType(contextType)) {
    case 'list_item':
      return '这是一个列表项或脚注型短文本，常含专有名词，但仍要检查是否有会卡住用户的普通难词。';
    case 'caption':
      return '这是一个图注或说明文字，文本通常较短，应优先找真正影响理解的普通难词。';
    case 'table_cell':
      return '这是一个表格或数据说明单元，可能夹杂专有名词，应跳过专名后再判断普通难词。';
    case 'heading':
      return '这是一个标题，优先标注帮助理解主题的关键词。';
    case 'quote':
      return '这是一个引用段落，按正文同样处理，但避免过度打扰。';
    case 'nav':
      return '这是页面导航或顶部区域的短文本，优先标注核心词或短语。';
    case 'footer':
      return '这是页脚链接或页脚说明，文本较短，优先标注核心词或短语。';
    case 'toc':
      return '这是目录或侧边栏短文本，常是标题摘要，优先标注核心词或短语。';
    case 'button':
    case 'link':
      return '这是按钮或链接短文本，优先标注动作词、名词或关键短语。';
    default:
      return '这是一个普通正文段落。';
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
    handleAnnotate(message.text, message.contextType, message.scanMode)
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
    chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'level', 'concurrency', 'serviceProvider', 'thinkingMode', 'scanMode'], sendResponse);
    return true;
  }
});

// 首次安装或更新时同步 Prompt 模板
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    chrome.storage.local.set({
      enabled: false,
      level: 'L3',
      concurrency: 5,
      scanMode: DEFAULT_SCAN_MODE,
      serviceProvider: DEFAULT_SERVICE_PROVIDER,
      thinkingMode: DEFAULT_THINKING_MODE,
      baseUrl: DEFAULT_BASE_URL,
      model: DEFAULT_MODEL,
      apiKey: '',
      customPrompt: DEFAULT_PROMPT
    });
  } else if (details.reason === 'update') {
    chrome.storage.local.get(['customPrompt', 'baseUrl', 'model', 'concurrency', 'level', 'serviceProvider', 'thinkingMode', 'scanMode'], (data) => {
      const updates = {};
      if (!data.customPrompt || data.customPrompt === LEGACY_DEFAULT_PROMPT) {
        updates.customPrompt = DEFAULT_PROMPT;
      }
      if (!data.baseUrl) updates.baseUrl = DEFAULT_BASE_URL;
      if (!data.model) updates.model = DEFAULT_MODEL;
      if (!data.concurrency) updates.concurrency = 5;
      if (!data.level) updates.level = 'L3';
      if (!data.serviceProvider) updates.serviceProvider = inferServiceProvider(data.baseUrl);
      if (!data.thinkingMode) updates.thinkingMode = DEFAULT_THINKING_MODE;
      if (!data.scanMode) updates.scanMode = DEFAULT_SCAN_MODE;
      if (Object.keys(updates).length > 0) {
        chrome.storage.local.set(updates);
      }
    });
  }
});

// --- 单段落标注 ---
async function handleAnnotate(text, contextType, scanMode) {
  const settings = await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'level', 'customPrompt', 'serviceProvider', 'thinkingMode']);
  if (!settings.apiKey) return { error: '请先在插件设置中填写 API Key' };
  normalizeProviderSettings(settings);
  if (text.trim().length < 2) return { annotations: [] };

  try {
    const annotations = await callLLM(text, settings.level, settings, contextType, scanMode);
    return { annotations };
  } catch (err) {
    return {
      error: err.message,
      retryable: Boolean(err.retryable)
    };
  }
}

// --- 校准处理 ---
async function handleCalibrate(text, level) {
  const settings = await chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'customPrompt', 'serviceProvider', 'thinkingMode']);
  if (!settings.apiKey) return { error: '请先在设置页配置 API Key' };
  normalizeProviderSettings(settings);

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
  if (url.includes('api.openai.com')) return 'openai';
  return 'openai';
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

function buildRequestBody(prompt, settings) {
  const body = {
    model: settings.model,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 600
  };

  if (settings.serviceProvider === 'openai') {
    const effort = getOpenAIReasoningEffort(settings);
    if (effort) body.reasoning_effort = effort;
  }

  if (settings.serviceProvider === 'aliyun') {
    body.enable_thinking = settings.thinkingMode === 'on';
  }

  if (settings.serviceProvider === 'volcengine') {
    body.thinking = { type: settings.thinkingMode === 'on' ? 'enabled' : 'disabled' };
  }

  return body;
}

async function requestAnnotations(prompt, settings) {
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
      body: JSON.stringify(buildRequestBody(prompt, settings))
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw createWordwinError('API 请求超时', { retryable: true });
    }
    throw createWordwinError(`API 请求失败：${err.message}`, { retryable: true });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errText = await response.text();
    throw createWordwinError(
      `API 请求失败 (${response.status}): ${errText}`,
      { retryable: isRetryableStatus(response.status) }
    );
  }

  const data = await response.json();
  recordTokenUsage(settings, data.usage);

  if (!data.choices || data.choices.length === 0) {
    throw createWordwinError('API 返回格式异常：choices 为空', { retryable: true });
  }
  const msg = data.choices[0].message;
  if (!msg || !msg.content) {
    throw createWordwinError('API 返回格式异常：message 内容为空', { retryable: true });
  }

  return parseJSON(msg.content.trim());
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
      console.warn('WordWin: token usage 记录失败', err);
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

  return annotations.slice(0, profile.maxPerParagraph);
}

// --- JSON 解析（处理 markdown 代码块包裹） ---
function parseJSON(content) {
  let jsonStr = content;
  const codeBlockMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      throw createWordwinError('LLM 返回格式异常：不是 JSON 数组', { retryable: true });
    }

    return parsed
      .filter(item =>
        item &&
        typeof item.word === 'string' &&
        typeof item.translation === 'string' &&
        item.word.trim() &&
        item.translation.trim()
      )
      .map(item => ({
        word: item.word.trim().replace(/\s+/g, ' '),
        translation: item.translation.trim().replace(/\s+/g, ' ')
      }))
      .filter(item =>
        item.word.length <= 80 &&
        item.translation.length <= 40 &&
        !/[\r\n]/.test(item.word)
      );
  } catch (err) {
    if (err.retryable) {
      throw err;
    }
    console.error('WordWin: LLM 返回解析失败:', content);
    throw createWordwinError('LLM 返回解析失败：不是合法 JSON', { retryable: true });
  }
}

function normalizeLevel(level) {
  if (LEVEL_PROFILES[level]) return level;
  return LEGACY_LEVEL_MAP[level] || 'L3';
}
