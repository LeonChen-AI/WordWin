// AdaptiveTranslation Options 0.9.1 设置页逻辑

const $ = (sel) => document.querySelector(sel);
const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'];
let lastFocusedBeforeUsageModal = null;
const LEVEL_INFO = {
  L1: { name: '初中', desc: '约1500基础词汇，标注大部分常见词，适合英语基础薄弱者' },
  L2: { name: '高中', desc: '约3500常用词汇，简单词不标，中等难度词会被标注' },
  L3: { name: '四级', desc: '约4500词汇，日常阅读基本无障碍，主要标注学术词和正式表达' },
  L4: { name: '六级/考研', desc: '约6000词汇，大部分英文内容可流畅阅读，仅标注低频专业术语' },
  L5: { name: '英专/留学', desc: '10000+词汇，接近母语阅读体验，极少标注' },
};
const SERVICE_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '使用 OpenAI 官方 Chat Completions 接口。'
  },
  aliyun: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen3.5-flash',
    hint: '阿里云百炼 OpenAI 兼容接口。推理/思考模式会映射为 enable_thinking。'
  },
  volcengine: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-0-pro-260215',
    hint: '火山方舟 OpenAI 兼容接口。Coding Plan 用户请将地址改为 https://ark.cn-beijing.volces.com/api/coding/v3'
  },
  zhipu: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-5.2',
    hint: '智谱AI OpenAI 兼容接口，支持 GLM 系列模型。'
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    hint: 'DeepSeek 官方接口，支持 DeepSeek-V4 等模型。'
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2.6',
    hint: '月之暗面 Kimi OpenAI 兼容接口，支持长上下文。'
  },
  minimax: {
    baseUrl: 'https://api.minimaxi.chat/v1',
    model: 'MiniMax-M3',
    hint: 'MiniMax OpenAI 兼容接口，支持 M 系列模型。'
  }
};
const THINKING_MODES = ['off', 'on'];
const SCAN_MODES = ['full', 'article'];
const PARAGRAPH_TRANSLATION_MODES = ['on', 'off'];
const USAGE_WINDOWS = [
  { key: '1h', label: '最近 1 小时', ms: 60 * 60 * 1000 },
  { key: '24h', label: '最近 24 小时', ms: 24 * 60 * 60 * 1000 },
  { key: '7d', label: '最近 7 日', ms: 7 * 24 * 60 * 60 * 1000 },
  { key: '30d', label: '最近 30 日', ms: 30 * 24 * 60 * 60 * 1000 }
];
const CALIBRATE_SAMPLES = [
  {
    title: '科技',
    text: `Artificial intelligence is increasingly being used to analyze medical images, identify subtle patterns, and support doctors in making earlier diagnoses. While these systems can improve efficiency, researchers still debate how to ensure transparency, reduce bias, and define responsibility when automated recommendations influence clinical decisions.`
  },
  {
    title: '人文',
    text: `Language does more than transmit information. It shapes how communities preserve memory, express identity, and negotiate social change. Even small differences in wording can alter the emotional tone of a public discussion and influence how people interpret shared values.`
  },
  {
    title: '历史',
    text: `Many historians argue that technological innovation alone does not explain major social transformation. Institutions, trade networks, and cultural expectations often determine whether a new invention remains marginal or becomes a force that reshapes daily life across generations.`
  },
  {
    title: '生活',
    text: `Sleep researchers have found that regular evening routines can improve both sleep quality and daytime concentration. Simple habits such as reducing screen exposure, keeping a consistent bedtime, and avoiding stimulants late in the day often have a cumulative effect over time.`
  }
];
const LEGACY_LEVEL_MAP = {
  '初中英语': 'L1',
  '高中英语': 'L2',
  '四级 CET-4': 'L3',
  '六级 CET-6': 'L4',
  '考研/雅思': 'L4',
  'GRE/专业': 'L5'
};

function normalizeLevel(level) {
  if (LEVELS.includes(level)) return level;
  return LEGACY_LEVEL_MAP[level] || 'L3';
}

function normalizeConcurrency(value) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return 3;
  return Math.min(10, Math.max(1, parsed));
}

function inferServiceProvider(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('api.openai.com')) return 'openai';
  if (url.includes('dashscope') || url.includes('aliyuncs.com/compatible-mode')) return 'aliyun';
  if (url.includes('volces.com/api/v3') || url.includes('volces.com/api/coding') || url.includes('ark.cn-beijing.volces.com')) return 'volcengine';
  if (url.includes('bigmodel.cn') || url.includes('open.bigmodel')) return 'zhipu';
  if (url.includes('deepseek.com') || url.includes('api.deepseek')) return 'deepseek';
  if (url.includes('moonshot.cn') || url.includes('api.moonshot')) return 'kimi';
  if (url.includes('minimaxi.chat') || url.includes('minimax.chat')) return 'minimax';
  return 'openai';
}

function normalizeProvider(provider, baseUrl) {
  if (SERVICE_PRESETS[provider]) return provider;
  return inferServiceProvider(baseUrl);
}

function getProviderPreset(provider) {
  return SERVICE_PRESETS[provider] || SERVICE_PRESETS.openai;
}

function normalizeThinkingMode(value) {
  return THINKING_MODES.includes(value) ? value : 'off';
}

function normalizeScanMode(value) {
  return SCAN_MODES.includes(value) ? value : 'full';
}

function normalizeParagraphTranslationMode(value) {
  return PARAGRAPH_TRANSLATION_MODES.includes(value) ? value : 'on';
}

function getApiConfigFromForm() {
  const serviceProvider = normalizeProvider($('#select-provider').value, $('#input-baseurl').value);
  const preset = getProviderPreset(serviceProvider);
  return {
    serviceProvider,
    thinkingMode: normalizeThinkingMode($('#select-thinking').value),
    apiKey: $('#input-apikey').value.trim(),
    baseUrl: ($('#input-baseurl').value.trim() || preset.baseUrl).replace(/\/+$/, ''),
    model: $('#input-model').value.trim() || preset.model,
    concurrency: normalizeConcurrency($('#input-concurrency').value)
  };
}

function buildChatCompletionsUrl(baseUrl) {
  const normalized = String(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(normalized)) return normalized;
  return `${normalized}/chat/completions`;
}

function getOpenAIReasoningEffort(model, thinkingMode) {
  if (!/(^o\d|^o[1-9]|^gpt-5)/i.test(model || '')) return null;
  if (thinkingMode === 'on') return 'medium';
  if (/^gpt-5\.?1/i.test(model || '')) return 'none';
  return 'minimal';
}

function buildTestRequestBody(serviceProvider, model, thinkingMode, content) {
  const body = {
    model,
    messages: [{ role: 'user', content }],
    max_tokens: 5
  };

  if (serviceProvider === 'openai') {
    const effort = getOpenAIReasoningEffort(model, thinkingMode);
    if (effort) body.reasoning_effort = effort;
  }

  if (serviceProvider === 'aliyun') {
    body.enable_thinking = thinkingMode === 'on';
  }

  if (serviceProvider === 'volcengine') {
    body.thinking = { type: thinkingMode === 'on' ? 'enabled' : 'disabled' };
  }

  return body;
}

function extractApiErrorMessage(errorText) {
  const raw = String(errorText || '').trim();
  if (!raw) return '';

  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message || parsed?.message || parsed?.msg || '';
    if (message) return String(message);
  } catch (e) {
    // Non-JSON responses are common for gateway/network errors.
  }

  return raw.replace(/\s+/g, ' ').slice(0, 160);
}

function describeApiFailure(status, errorText) {
  const message = extractApiErrorMessage(errorText);
  if (message) return `失败 ${status}：${message}`;
  if (status === 401 || status === 403) return '认证失败：请检查接口密钥';
  if (status === 404) return '接口不存在：请检查接口地址';
  if (status === 429) return '请求受限：额度不足或频率过高';
  if (status >= 500) return '服务暂不可用：请稍后重试';
  return `连接失败：HTTP ${status}`;
}

function applyProviderPreset(provider) {
  // Clear all API fields when switching to an unconfigured provider
  $('#input-apikey').value = '';
  $('#input-baseurl').value = '';
  $('#input-model').value = '';
  updateAllClearBtns();
  updateConnectionIndicator();
}

// --- Per-provider config persistence ---
// providerConfigs = { openai: {apiKey, baseUrl, model}, zhipu: {...}, ... }
// Only saved on successful test connection. Never auto-saved on blur.

function getFormApiConfig() {
  return {
    apiKey: $('#input-apikey').value.trim(),
    baseUrl: $('#input-baseurl').value.trim(),
    model: $('#input-model').value.trim()
  };
}

function loadProviderConfig(provider, configs) {
  const saved = configs && configs[provider];
  const preset = getProviderPreset(provider);
  if (saved) {
    $('#input-apikey').value = saved.apiKey || '';
    $('#input-baseurl').value = saved.baseUrl || preset.baseUrl || '';
    $('#input-model').value = saved.model || preset.model || '';
  } else {
    $('#input-apikey').value = '';
    $('#input-baseurl').value = preset.baseUrl || '';
    $('#input-model').value = preset.model || '';
  }
  updateAllClearBtns();
  updateConnectionIndicator();
}

function syncGlobalApiConfigFromProvider(provider, configs) {
  const saved = configs && configs[provider];
  if (!saved || !saved.apiKey) return;
  const normalizedProvider = normalizeProvider(provider, saved.baseUrl);
  const preset = getProviderPreset(normalizedProvider);
  chrome.storage.local.set({
    serviceProvider: normalizedProvider,
    apiKey: saved.apiKey || '',
    baseUrl: (saved.baseUrl || preset.baseUrl).replace(/\/+$/, ''),
    model: saved.model || preset.model
  });
}

function migrateLegacyApiConfig(data) {
  const provider = normalizeProvider(data.serviceProvider, data.baseUrl);
  const configs = { ...(data.providerConfigs || {}) };
  const hasLegacyConfig = Boolean(data.apiKey || data.baseUrl || data.model);
  const hasProviderConfig = Boolean(configs[provider] && (configs[provider].apiKey || configs[provider].baseUrl || configs[provider].model));

  if (hasLegacyConfig && !hasProviderConfig) {
    configs[provider] = {
      apiKey: data.apiKey || '',
      baseUrl: data.baseUrl || '',
      model: data.model || ''
    };
  }

  return { provider, configs };
}

function updateConnectionIndicator() {
  if (window._apiTestInProgress) return;
  const provider = $('#select-provider').value;
  const configs = window._providerConfigs || {};
  const savedConfig = configs[provider];
  const formConfig = getFormApiConfig();
  const preset = getProviderPreset(provider);
  const savedBaseUrl = (savedConfig?.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  const formBaseUrl = (formConfig.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  const savedModel = savedConfig?.model || preset.model || '';
  const formModel = formConfig.model || preset.model || '';
  const savedThinkingMode = window._savedThinkingMode || 'off';
  const formThinkingMode = normalizeThinkingMode($('#select-thinking').value);
  const hasSavedConfig = !!(savedConfig && savedConfig.apiKey);
  const formHasApiKey = formConfig.apiKey.length > 0;
  const isSameAsSaved = hasSavedConfig
    && formConfig.apiKey === savedConfig.apiKey
    && formBaseUrl === savedBaseUrl
    && formModel === savedModel
    && formThinkingMode === savedThinkingMode;

  if (isSameAsSaved) {
    updateApiStatus('已连接', 'success');
  } else if (formHasApiKey) {
    updateApiStatus('未保存', 'unsaved');
  } else {
    updateApiStatus('未连接', 'disconnected');
  }
}

function updateApiStatus(text, type) {
  const group = $('#api-status-indicator');
  if (!group) return;
  const dot = group.querySelector('.status-dot');
  const textEl = group.querySelector('.status-dot-text');
  textEl.textContent = text;
  dot.className = `status-dot ${type || 'success'}`;
  group.className = `status-dot-group ${type || 'success'}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

let currentTestLevel = 'L3';

function persistLevel(level, { saveMessage = '等级已保存', testMessage = '' } = {}) {
  const normalizedLevel = normalizeLevel(level);
  currentTestLevel = normalizedLevel;
  $('#select-level').value = normalizedLevel;
  $('#test-level-value').textContent = normalizedLevel;
  updateLevelBar(normalizedLevel);

  chrome.storage.local.set({ level: normalizedLevel }, () => {
    showStatus('#save-status', saveMessage, 'success');
    if (testMessage) {
      showStatus('#level-test-status', testMessage, 'success');
    }
  });

  updateLevelTestBoundaryButtons();
}

function updateLevelTestBoundaryButtons() {
  const idx = LEVELS.indexOf(currentTestLevel);
  const btnEasier = $('#btn-test-easier');
  const btnHarder = $('#btn-test-harder');

  btnEasier.disabled = idx <= 0;
  btnHarder.disabled = idx >= LEVELS.length - 1;
}

// --- Level Bar 交互 ---
function updateLevelBar(level) {
  document.querySelectorAll('.level-bar-item').forEach(item => {
    item.classList.toggle('active', item.dataset.level === level);
  });
  const info = LEVEL_INFO[level];
  if (info) {
    $('#level-detail-title').textContent = `${level} ${info.name}`;
    $('#level-detail-desc').textContent = info.desc;
  }
}

document.querySelectorAll('.level-bar-item').forEach(item => {
  item.addEventListener('click', () => {
    const level = item.dataset.level;
    $('#select-level').value = level;
    $('#select-level').dispatchEvent(new Event('change', { bubbles: true }));
  });
});

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

// 默认 Prompt（必须与 background.js 中的 DEFAULT_PROMPT 保持一致）
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

// --- 侧栏导航切换 ---
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    item.classList.add('active');
    $(`#tab-${item.dataset.tab}`).classList.add('active');
    if (item.dataset.tab === 'usage') {
      loadTokenUsage();
    }
  });
});

// --- 加载设置 ---
chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'level', 'customPrompt', 'concurrency', 'serviceProvider', 'thinkingMode', 'scanMode', 'paragraphTranslationMode', 'fontSize', 'autoTranslate', 'translationColor', 'vocabulary', '_migrated_v091', '_migrated_v092', '_migrated_v091_safe', 'providerConfigs'], (data) => {
  const migrated = migrateLegacyApiConfig(data);
  if (!data._migrated_v091_safe) {
    chrome.storage.local.set({
      providerConfigs: migrated.configs,
      serviceProvider: migrated.provider,
      _migrated_v091_safe: true,
      _migrated_v091: true,
      _migrated_v092: true
    });
    data.providerConfigs = migrated.configs;
    data.serviceProvider = migrated.provider;
  }
  const level = normalizeLevel(data.level);
  const concurrency = normalizeConcurrency(data.concurrency);
  const serviceProvider = normalizeProvider(data.serviceProvider || migrated.provider, data.baseUrl);
  const thinkingMode = normalizeThinkingMode(data.thinkingMode);
  const scanMode = normalizeScanMode(data.scanMode);
  const paragraphTranslationMode = normalizeParagraphTranslationMode(data.paragraphTranslationMode);
  const fontSize = Number(data.fontSize) || 100;
  const autoTranslate = data.autoTranslate === true;
  const vocabulary = Array.isArray(data.vocabulary) ? data.vocabulary : [];
  const promptTemplate = (!data.customPrompt || data.customPrompt === LEGACY_DEFAULT_PROMPT)
    ? DEFAULT_PROMPT
    : data.customPrompt;
  const providerConfigs = data.providerConfigs || migrated.configs || {};

  // Store providerConfigs globally for change handler access
  window._providerConfigs = providerConfigs;
  window._savedThinkingMode = thinkingMode;

  $('#select-provider').value = serviceProvider;
  $('#select-provider').dataset.currentProvider = serviceProvider;
  $('#select-thinking').value = thinkingMode;
  $('#select-paragraph-translation-mode').value = paragraphTranslationMode;
  $('#select-scan-mode').value = scanMode;
  $('#select-auto-translate').value = String(autoTranslate);

  // Restore per-provider config (only from last successful test connection)
  loadProviderConfig(serviceProvider, providerConfigs);
  syncGlobalApiConfigFromProvider(serviceProvider, providerConfigs);
  $('#input-concurrency').value = concurrency;
  $('#select-level').value = level;
  $('#test-level-value').textContent = level;
  updateLevelBar(level);
  $('#prompt-editor').value = promptTemplate;
  currentTestLevel = level;

  updateFontSizeDisplay(fontSize);
  const translationColor = data.translationColor || '#818cf8';
  $('#input-translation-color').value = translationColor;
  updateActiveColorSwatch(translationColor);
  updateVocabCount(vocabulary.length);

  if (data.level !== level) {
    chrome.storage.local.set({ level });
  }
  if (data.concurrency !== concurrency) {
    chrome.storage.local.set({ concurrency });
  }
  if (data.serviceProvider !== serviceProvider) {
    chrome.storage.local.set({ serviceProvider });
  }
  if (data.thinkingMode !== thinkingMode) {
    chrome.storage.local.set({ thinkingMode });
  }
  if (data.scanMode !== scanMode) {
    chrome.storage.local.set({ scanMode });
  }
  if (data.paragraphTranslationMode !== paragraphTranslationMode) {
    chrome.storage.local.set({ paragraphTranslationMode });
  }
  if (data.customPrompt !== promptTemplate) {
    chrome.storage.local.set({ customPrompt: promptTemplate });
  }

  updateLevelTestBoundaryButtons();
});

$('#select-provider').addEventListener('change', () => {
  const newProvider = $('#select-provider').value;
  const configs = window._providerConfigs || {};

  // Load new provider's saved config (or preset-only fields if not configured).
  loadProviderConfig(newProvider, configs);

  // Only switch the active translation engine when this provider already has
  // a tested config. Unconfigured provider changes should stay as form edits.
  $('#select-provider').dataset.currentProvider = newProvider;
  if (configs[newProvider]?.apiKey) {
    syncGlobalApiConfigFromProvider(newProvider, configs);
    showStatus('#save-status', '已切换到已保存的服务商配置', 'success');
  } else {
    showStatus('#save-status', '当前服务商尚未保存，测试通过后才会用于翻译', 'loading');
  }
});

// API config is NOT auto-saved. Only saved on successful test connection.
$('#input-apikey').addEventListener('input', updateConnectionIndicator);
$('#input-baseurl').addEventListener('input', updateConnectionIndicator);
$('#input-model').addEventListener('input', updateConnectionIndicator);
$('#select-thinking').addEventListener('change', updateConnectionIndicator);

$('#select-level').addEventListener('change', () => {
  persistLevel($('#select-level').value, {
    saveMessage: '等级已保存，当前页面会自动重翻'
  });
});

$('#select-scan-mode').addEventListener('change', () => {
  chrome.storage.local.set({ scanMode: normalizeScanMode($('#select-scan-mode').value) }, () => {
    showStatus('#save-status', '翻译范围已保存，当前页面会自动重翻', 'success');
  });
});

$('#select-paragraph-translation-mode').addEventListener('change', () => {
  chrome.storage.local.set({ paragraphTranslationMode: normalizeParagraphTranslationMode($('#select-paragraph-translation-mode').value) }, () => {
    showStatus('#save-status', '对照翻译已保存，当前页面会自动重翻', 'success');
  });
});

$('#btn-refresh-usage').addEventListener('click', () => {
  loadTokenUsage();
});

$('#btn-clear-usage').addEventListener('click', () => {
  openUsageClearModal();
});

$('#btn-usage-clear-cancel').addEventListener('click', closeUsageClearModal);
$('#btn-usage-clear-confirm').addEventListener('click', clearUsageStats);
$('#usage-clear-modal').addEventListener('click', (e) => {
  if (e.target.id === 'usage-clear-modal') closeUsageClearModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#usage-clear-modal').hidden) closeUsageClearModal();
});

// --- 测试连接 ---
$('#btn-test').addEventListener('click', async () => {
  const btn = $('#btn-test');
  btn.disabled = true;
  window._apiTestInProgress = true;
  showStatus('#save-status', '', '');
  updateApiStatus('连接中...', 'loading');

  const { serviceProvider, thinkingMode, apiKey, baseUrl, model } = getApiConfigFromForm();

  if (!apiKey) {
    updateApiStatus('请填写接口密钥', 'error');
    setTimeout(() => { window._apiTestInProgress = false; updateConnectionIndicator(); }, 2000);
    btn.disabled = false;
    return;
  }

  try {
    const response = await fetch(buildChatCompletionsUrl(baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(buildTestRequestBody(serviceProvider, model, thinkingMode, 'Hi'))
    });

    if (response.ok) {
      // Save on test success: global config (for translation) + per-provider config
      const provider = $('#select-provider').value;
      const formConfig = getFormApiConfig();
      const configs = window._providerConfigs || {};

      // Save this provider's tested config
      configs[provider] = { ...formConfig };
      window._providerConfigs = configs;

      // Save global settings for translation engine
      const allSettings = {
        ...getApiConfigFromForm(),
        providerConfigs: configs,
        level: $('#select-level').value,
        scanMode: normalizeScanMode($('#select-scan-mode').value),
        paragraphTranslationMode: normalizeParagraphTranslationMode($('#select-paragraph-translation-mode').value),
        autoTranslate: $('#select-auto-translate').value === 'true'
      };
      chrome.storage.local.set(allSettings);
      window._savedThinkingMode = normalizeThinkingMode($('#select-thinking').value);
      updateApiStatus('连接成功', 'success');
      showStatus('#save-status', '测试通过，配置已保存', 'success');
      setTimeout(() => { window._apiTestInProgress = false; updateConnectionIndicator(); }, 2000);
    } else {
      const errText = await response.text();
      updateApiStatus(`失败 (${response.status})`, 'error');
      showStatus('#save-status', describeApiFailure(response.status, errText), 'error');
      setTimeout(() => { window._apiTestInProgress = false; updateConnectionIndicator(); }, 3000);
    }
  } catch (err) {
    updateApiStatus('连接失败', 'error');
    showStatus('#save-status', `连接失败：${err.message || '请检查网络或接口地址'}`, 'error');
    setTimeout(() => { window._apiTestInProgress = false; updateConnectionIndicator(); }, 3000);
  } finally {
    btn.disabled = false;
  }
});

$('#btn-test-concurrency').addEventListener('click', async () => {
  const btn = $('#btn-test-concurrency');
  btn.disabled = true;
  window._apiTestInProgress = true;
  updateApiStatus('并发测试中...', 'loading');

  try {
    const { serviceProvider, thinkingMode, apiKey, baseUrl, model, concurrency } = getApiConfigFromForm();

    if (!apiKey) {
      updateApiStatus('请填写接口密钥', 'error');
      setTimeout(() => { window._apiTestInProgress = false; updateConnectionIndicator(); }, 2000);
      return;
    }

    const requestBody = buildTestRequestBody(serviceProvider, model, thinkingMode, 'Reply with OK only.');

    const tasks = Array.from({ length: concurrency }, () =>
      fetch(buildChatCompletionsUrl(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      })
        .then(async (response) => {
          if (response.ok) {
            return { ok: true };
          }
          const errorText = await response.text();
          return {
            ok: false,
            status: response.status,
            errorText
          };
        })
        .catch((error) => ({
          ok: false,
          errorText: error.message
        }))
    );

    const results = await Promise.all(tasks);
    const successCount = results.filter(result => result.ok).length;
    const failure = results.find(result => !result.ok);

    if (successCount === concurrency) {
      updateApiStatus(`并发测试成功：${concurrency}/${concurrency} 全部通过`, 'success');
      showStatus('#save-status', '并发测试通过', 'success');
    } else {
      const reason = failure?.status
        ? describeApiFailure(failure.status, failure.errorText)
        : (failure?.errorText ? `连接失败：${failure.errorText}` : '部分请求失败');
      const detail = failure?.status
        ? `失败 ${concurrency - successCount} 个`
        : `失败 ${concurrency - successCount} 个`;
      updateApiStatus(`并发未通过：${successCount}/${concurrency}，${detail}`, 'error');
      showStatus('#save-status', reason, 'error');
    }
    setTimeout(() => { window._apiTestInProgress = false; updateConnectionIndicator(); }, 3000);
  } finally {
    btn.disabled = false;
  }
});

// --- Prompt 保存 ---
$('#btn-save-prompt').addEventListener('click', () => {
  const prompt = $('#prompt-editor').value.trim();
  chrome.storage.local.set({ customPrompt: prompt }, () => {
    showStatus('#prompt-status', '已保存', 'success');
  });
});

// --- Prompt 恢复默认 ---
$('#btn-reset-prompt').addEventListener('click', () => {
  $('#prompt-editor').value = DEFAULT_PROMPT;
  chrome.storage.local.set({ customPrompt: DEFAULT_PROMPT }, () => {
    showStatus('#prompt-status', '已恢复默认', 'success');
  });
});

// --- 阅读能力测试 ---
$('#btn-start-level-test').addEventListener('click', () => {
  $('#level-test-sample').removeAttribute('hidden');
  currentTestLevel = $('#select-level').value;
  $('#test-level-value').textContent = currentTestLevel;
  updateLevelTestBoundaryButtons();
  generateLevelTestSample(currentTestLevel);
});

$('#btn-test-easier').addEventListener('click', () => {
  const idx = LEVELS.indexOf(currentTestLevel);
  if (idx <= 0) return;
  currentTestLevel = LEVELS[idx - 1];
  $('#select-level').value = currentTestLevel;
  $('#test-level-value').textContent = currentTestLevel;
  updateLevelBar(currentTestLevel);
  updateLevelTestBoundaryButtons();
  generateLevelTestSample(currentTestLevel);
});

$('#btn-test-harder').addEventListener('click', () => {
  const idx = LEVELS.indexOf(currentTestLevel);
  if (idx >= LEVELS.length - 1) return;
  currentTestLevel = LEVELS[idx + 1];
  $('#select-level').value = currentTestLevel;
  $('#test-level-value').textContent = currentTestLevel;
  updateLevelBar(currentTestLevel);
  updateLevelTestBoundaryButtons();
  generateLevelTestSample(currentTestLevel);
});

$('#btn-test-ok').addEventListener('click', () => {
  persistLevel(currentTestLevel, {
    saveMessage: '等级已更新，当前页面会自动重翻',
    testMessage: '已应用这个等级'
  });
});

async function generateLevelTestSample(level) {
  $('#level-test-loading').removeAttribute('hidden');
  $('#level-test-content').innerHTML = '';
  showStatus('#level-test-status', '', '');

  // 禁用操作按钮，防止生成过程中重复触发
  setLevelTestButtons(true);

  try {
    const limit = Math.min(2, normalizeConcurrency($('#input-concurrency').value));
    const responses = await runWithLimit(CALIBRATE_SAMPLES, limit, sample =>
      chrome.runtime.sendMessage({
        type: 'calibrate',
        text: sample.text,
        level: level
      }).then(result => ({ sample, result }))
    );

    // 检查是否有错误
    for (const { result } of responses) {
      if (result.error) {
        $('#level-test-loading').setAttribute('hidden', '');
        showStatus('#level-test-status', `生成失败: ${result.error}`, 'error');
        setLevelTestButtons(false);
        return;
      }
    }

    const renderedSamples = responses.map(({ sample, result }) => ({
      title: sample.title,
      html: renderAnnotatedHtml(sample.text, result.annotations || [])
    }));

    $('#level-test-loading').setAttribute('hidden', '');
    renderLevelTestSample(renderedSamples);
  } catch (err) {
    $('#level-test-loading').setAttribute('hidden', '');
    showStatus('#level-test-status', `生成失败: ${err.message}`, 'error');
  } finally {
    setLevelTestButtons(false);
  }
}

async function runWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, runOne);
  await Promise.all(workers);
  return results;
}

function setLevelTestButtons(disabled) {
  $('#btn-test-easier').disabled = disabled;
  $('#btn-test-harder').disabled = disabled;
  $('#btn-test-ok').disabled = disabled;
  $('#btn-start-level-test').disabled = disabled;
  if (!disabled) {
    updateLevelTestBoundaryButtons();
  }
}

function renderAnnotatedHtml(text, annotations) {
  // 安全渲染：先在原文中确定非重叠区间，再统一转义输出。
  const sorted = [...annotations].sort((a, b) => b.word.length - a.word.length);
  const ranges = [];

  for (const { word, translation } of sorted) {
    const boundary = /^[A-Za-z0-9' -]+$/.test(word) ? '\\b' : '';
    const regex = new RegExp(`${boundary}(${escapeRegex(word)})${boundary}`, 'i');
    const match = text.match(regex);
    if (!match) continue;

    const start = match.index;
    const end = start + match[0].length;
    const overlaps = ranges.some(pos => start < pos.end && end > pos.start);
    if (overlaps) continue;

    ranges.push({ start, end, translation });
  }

  ranges.sort((a, b) => a.start - b.start);

  let cursor = 0;
  let html = '';
  for (const range of ranges) {
    html += escapeHtml(text.slice(cursor, range.start));
    html += `<span class="adaptive-translation-annotation">${escapeHtml(text.slice(range.start, range.end))}</span>`;
    html += `<span class="adaptive-translation-translation">(${escapeHtml(range.translation)})</span>`;
    cursor = range.end;
  }
  html += escapeHtml(text.slice(cursor));

  return html;
}

function renderLevelTestSample(samples) {
  $('#level-test-content').innerHTML = samples.map(sample => `
    <div class="sample-item">
      <span class="sample-tag">${escapeHtml(sample.title)}</span>
      <div class="sample-text">${sample.html}</div>
    </div>
  `).join('');
}

function getProviderLabel(provider) {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'aliyun':
      return '阿里云';
    case 'volcengine':
      return '火山';
    default:
      return provider || '未知服务商';
  }
}

function formatTokenNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function formatUsageTime(timestamp) {
  if (!timestamp) return '-';
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function aggregateUsage(buckets, windowMs) {
  const cutoff = Date.now() - windowMs;
  const groups = new Map();

  for (const bucket of buckets) {
    if (!bucket || Number(bucket.bucketStart) < cutoff) continue;
    const provider = bucket.provider || 'unknown';
    const model = bucket.model || 'unknown';
    const key = `${provider}::${model}`;
    const current = groups.get(key) || {
      provider,
      model,
      requestCount: 0,
      withUsageCount: 0,
      missingUsageCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      lastAt: 0
    };

    current.requestCount += Number(bucket.requestCount || 0);
    current.withUsageCount += Number(bucket.withUsageCount || 0);
    current.missingUsageCount += Number(bucket.missingUsageCount || 0);
    current.promptTokens += Number(bucket.promptTokens || 0);
    current.completionTokens += Number(bucket.completionTokens || 0);
    current.totalTokens += Number(bucket.totalTokens || 0);
    current.lastAt = Math.max(current.lastAt, Number(bucket.lastAt || bucket.bucketStart || 0));
    groups.set(key, current);
  }

  return [...groups.values()].sort((a, b) => b.totalTokens - a.totalTokens || b.requestCount - a.requestCount);
}

function getUsageTotals(groups) {
  return groups.reduce((totals, item) => {
    totals.requestCount += item.requestCount;
    totals.withUsageCount += item.withUsageCount;
    totals.missingUsageCount += item.missingUsageCount;
    totals.promptTokens += item.promptTokens;
    totals.completionTokens += item.completionTokens;
    totals.totalTokens += item.totalTokens;
    return totals;
  }, {
    requestCount: 0,
    withUsageCount: 0,
    missingUsageCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0
  });
}

function renderUsageRows(groups) {
  if (groups.length === 0) {
    return '<div class="usage-empty">暂无记录</div>';
  }

  return `
    <div class="usage-table">
      <div class="usage-row usage-row-head">
        <span>服务商 / 模型</span>
        <span>请求</span>
        <span>输入</span>
        <span>输出</span>
        <span>总计</span>
        <span>最近请求</span>
      </div>
      ${groups.map(item => `
        <div class="usage-row">
          <span>
            <strong>${escapeHtml(getProviderLabel(item.provider))}</strong>
            <small>${escapeHtml(item.model)}</small>
            ${item.missingUsageCount > 0 ? `<em>${item.missingUsageCount} 次未返回 usage</em>` : ''}
          </span>
          <span>${formatTokenNumber(item.requestCount)}</span>
          <span>${formatTokenNumber(item.promptTokens)}</span>
          <span>${formatTokenNumber(item.completionTokens)}</span>
          <span>${formatTokenNumber(item.totalTokens)}</span>
          <span>${formatUsageTime(item.lastAt)}</span>
        </div>
      `).join('')}
    </div>
  `;
}

function renderTokenUsage(buckets) {
  const safeBuckets = Array.isArray(buckets) ? buckets : [];
  $('#usage-updated').textContent = `更新时间：${new Date().toLocaleString('zh-CN')}`;

  $('#usage-panels').innerHTML = USAGE_WINDOWS.map(windowItem => {
    const groups = aggregateUsage(safeBuckets, windowItem.ms);
    const totals = getUsageTotals(groups);
    return `
      <section class="usage-panel usage-window-panel">
        <div class="usage-panel-header">
          <h3>${windowItem.label}</h3>
          <div class="usage-total">
            <span>总 token <strong>${formatTokenNumber(totals.totalTokens)}</strong></span>
            <span>请求 <strong>${formatTokenNumber(totals.requestCount)}</strong></span>
          </div>
        </div>
        <div class="usage-summary">
          <span>输入 ${formatTokenNumber(totals.promptTokens)}</span>
          <span>输出 ${formatTokenNumber(totals.completionTokens)}</span>
          <span>未返回 usage ${formatTokenNumber(totals.missingUsageCount)}</span>
        </div>
        ${renderUsageRows(groups)}
      </section>
    `;
  }).join('');
}

function openUsageClearModal() {
  lastFocusedBeforeUsageModal = document.activeElement;
  $('#usage-clear-modal').hidden = false;
  document.body.classList.add('modal-open');
  $('#btn-usage-clear-cancel').focus();
}

function closeUsageClearModal() {
  $('#usage-clear-modal').hidden = true;
  document.body.classList.remove('modal-open');
  if (lastFocusedBeforeUsageModal && typeof lastFocusedBeforeUsageModal.focus === 'function') {
    lastFocusedBeforeUsageModal.focus();
  }
  lastFocusedBeforeUsageModal = null;
}

function clearUsageStats() {
  const btn = $('#btn-usage-clear-confirm');
  btn.disabled = true;
  btn.textContent = '清空中...';

  chrome.storage.local.remove(['tokenUsageBuckets'], () => {
    btn.disabled = false;
    btn.textContent = '确认清空';
    closeUsageClearModal();
    showStatus('#usage-status', '统计已清空', 'success');
    renderTokenUsage([]);
  });
}

function loadTokenUsage() {
  chrome.storage.local.get(['tokenUsageBuckets'], (data) => {
    renderTokenUsage(data.tokenUsageBuckets || []);
  });
}

// --- 字号控制 ---
$('#btn-font-decrease').addEventListener('click', () => {
  chrome.storage.local.get(['fontSize'], (data) => {
    const current = Number(data.fontSize) || 100;
    const next = Math.max(80, current - 5);
    chrome.storage.local.set({ fontSize: next }, () => {
      updateFontSizeDisplay(next);
    });
  });
});

$('#btn-font-increase').addEventListener('click', () => {
  chrome.storage.local.get(['fontSize'], (data) => {
    const current = Number(data.fontSize) || 100;
    const next = Math.min(130, current + 5);
    chrome.storage.local.set({ fontSize: next }, () => {
      updateFontSizeDisplay(next);
    });
  });
});

function updateFontSizeDisplay(value) {
  $('#font-size-display').textContent = `${value}%`;
}

// --- 自动翻译 ---
$('#select-auto-translate').addEventListener('change', () => {
  const autoTranslate = $('#select-auto-translate').value === 'true';
  chrome.storage.local.set({ autoTranslate }, () => {
    showStatus('#save-status', '连续阅读设置已保存', 'success');
  });
});

// --- 翻译颜色 ---
document.querySelectorAll('.color-swatch').forEach(swatch => {
  swatch.addEventListener('click', () => {
    const color = swatch.dataset.color;
    chrome.storage.local.set({ translationColor: color }, () => {
      updateActiveColorSwatch(color);
      showStatus('#save-status', '翻译颜色已保存', 'success');
    });
  });
});

$('#input-translation-color').addEventListener('input', (e) => {
  const color = e.target.value;
  chrome.storage.local.set({ translationColor: color }, () => {
    updateActiveColorSwatch(color);
  });
});

function updateActiveColorSwatch(activeColor) {
  let presetMatched = false;
  document.querySelectorAll('.color-swatch').forEach(s => {
    const isMatch = s.dataset.color === activeColor;
    s.classList.toggle('active', isMatch);
    if (isMatch) presetMatched = true;
  });
  const customLabel = document.querySelector('.color-custom');
  if (customLabel) {
    customLabel.classList.toggle('active', !presetMatched);
    customLabel.style.setProperty('--custom-color', activeColor);
  }
}

// --- 生词本 ---
$('#btn-open-vocab').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('vocab.html') });
});

function updateVocabCount(count) {
  const el = $('#vocab-count');
  if (count > 0) {
    el.textContent = `已收录 ${count} 词`;
  } else {
    el.textContent = '';
  }
}

// 监听 vocabulary 变化
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.vocabulary) {
    const vocabulary = changes.vocabulary.newValue || [];
    updateVocabCount(vocabulary.length);
  }
});

// --- 工具函数 ---
function showStatus(selector, text, type) {
  const el = $(selector);
  el.textContent = text;
  el.className = `status ${type}`;
  if (type !== 'loading') {
    setTimeout(() => { el.textContent = ''; }, 4000);
  }
}

// --- Clearable Inputs ---
function updateClearBtn(wrapper) {
  const input = wrapper.querySelector('.input');
  if (!input) return;
  wrapper.classList.toggle('has-value', input.value.length > 0);
}

function updateAllClearBtns() {
  document.querySelectorAll('.input-clearable').forEach(updateClearBtn);
}

document.querySelectorAll('.input-clearable').forEach(wrapper => {
  const input = wrapper.querySelector('.input');
  const clearBtn = wrapper.querySelector('.input-clear-btn');
  if (!input || !clearBtn) return;

  input.addEventListener('input', () => updateClearBtn(wrapper));
  clearBtn.addEventListener('click', () => {
    input.value = '';
    wrapper.classList.remove('has-value');
    input.focus();
    input.dispatchEvent(new Event('blur', { bubbles: true }));
  });
});

// Initial state
updateAllClearBtns();

initCustomDropdowns();
