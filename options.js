// WordWin Options v5 设置页逻辑

const $ = (sel) => document.querySelector(sel);
const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5'];
const SERVICE_PRESETS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    hint: '使用 OpenAI 官方 Chat Completions 接口。'
  },
  aliyun: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    hint: '阿里云百炼 OpenAI 兼容接口。推理/思考模式会映射为 enable_thinking。'
  },
  volcengine: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-1-5-pro-32k-250115',
    hint: '火山方舟 OpenAI 兼容接口。模型名也可以填写你的方舟推理接入点 ID。'
  }
};
const THINKING_MODES = ['off', 'on'];
const SCAN_MODES = ['full', 'article'];
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
  if (Number.isNaN(parsed)) return 5;
  return Math.min(10, Math.max(1, parsed));
}

function inferServiceProvider(baseUrl) {
  const url = String(baseUrl || '').toLowerCase();
  if (url.includes('dashscope') || url.includes('aliyuncs.com/compatible-mode')) return 'aliyun';
  if (url.includes('volces.com/api/v3') || url.includes('ark.cn-beijing.volces.com')) return 'volcengine';
  if (url.includes('api.openai.com')) return 'openai';
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

function updateProviderHint() {
  const provider = normalizeProvider($('#select-provider').value, $('#input-baseurl').value);
  const preset = getProviderPreset(provider);
  $('#provider-hint').textContent = preset.hint;
}

function applyProviderPreset(provider) {
  const preset = getProviderPreset(provider);
  $('#input-baseurl').value = preset.baseUrl;
  $('#input-model').value = preset.model;
  updateProviderHint();
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

// --- 标签切换 ---
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'usage') {
      loadTokenUsage();
    }
  });
});

// --- Level 说明展开 ---
$('#btn-level-help').addEventListener('click', () => {
  const panel = $('#level-help-panel');
  const button = $('#btn-level-help');
  const isHidden = panel.hasAttribute('hidden');

  if (isHidden) {
    panel.removeAttribute('hidden');
    button.setAttribute('aria-expanded', 'true');
  } else {
    panel.setAttribute('hidden', '');
    button.setAttribute('aria-expanded', 'false');
  }
});

// --- 加载设置 ---
chrome.storage.local.get(['apiKey', 'baseUrl', 'model', 'level', 'customPrompt', 'concurrency', 'serviceProvider', 'thinkingMode', 'scanMode'], (data) => {
  const level = normalizeLevel(data.level);
  const concurrency = normalizeConcurrency(data.concurrency);
  const serviceProvider = normalizeProvider(data.serviceProvider, data.baseUrl);
  const thinkingMode = normalizeThinkingMode(data.thinkingMode);
  const scanMode = normalizeScanMode(data.scanMode);
  const preset = getProviderPreset(serviceProvider);
  const promptTemplate = (!data.customPrompt || data.customPrompt === LEGACY_DEFAULT_PROMPT)
    ? DEFAULT_PROMPT
    : data.customPrompt;
  $('#select-provider').value = serviceProvider;
  $('#select-thinking').value = thinkingMode;
  $('#select-scan-mode').value = scanMode;
  $('#input-apikey').value = data.apiKey || '';
  $('#input-baseurl').value = data.baseUrl || preset.baseUrl;
  $('#input-model').value = data.model || preset.model;
  $('#input-concurrency').value = concurrency;
  $('#select-level').value = level;
  $('#test-level-value').textContent = level;
  $('#prompt-editor').value = promptTemplate;
  currentTestLevel = level;

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
  if (data.customPrompt !== promptTemplate) {
    chrome.storage.local.set({ customPrompt: promptTemplate });
  }

  updateProviderHint();
  updateLevelTestBoundaryButtons();
});

$('#select-provider').addEventListener('change', () => {
  applyProviderPreset($('#select-provider').value);
});

$('#input-baseurl').addEventListener('input', updateProviderHint);

// --- 保存设置 ---
$('#btn-save').addEventListener('click', () => {
  const apiConfig = getApiConfigFromForm();
  const settings = {
    ...apiConfig,
    level: $('#select-level').value,
    scanMode: normalizeScanMode($('#select-scan-mode').value)
  };

  chrome.storage.local.set(settings, () => {
    showStatus('#save-status', '已保存', 'success');
  });
});

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

$('#btn-refresh-usage').addEventListener('click', () => {
  loadTokenUsage();
});

$('#btn-clear-usage').addEventListener('click', () => {
  const confirmed = window.confirm('确定要清空全部 token 用量统计吗？清空后不可恢复。');
  if (!confirmed) return;

  chrome.storage.local.remove(['tokenUsageBuckets'], () => {
    showStatus('#usage-status', '统计已清空', 'success');
    renderTokenUsage([]);
  });
});

// --- 测试连接 ---
$('#btn-test').addEventListener('click', async () => {
  const btn = $('#btn-test');
  btn.disabled = true;
  showStatus('#test-status', '连接中...', 'loading');
  showStatus('#concurrency-status', '', '');

  const { serviceProvider, thinkingMode, apiKey, baseUrl, model } = getApiConfigFromForm();

  if (!apiKey) {
    showStatus('#test-status', '请填写 API Key', 'error');
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
      showStatus('#test-status', '连接成功', 'success');
    } else {
      const errText = await response.text();
      showStatus('#test-status', `失败 (${response.status}): ${errText.slice(0, 80)}`, 'error');
    }
  } catch (err) {
    showStatus('#test-status', `连接失败: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-test-concurrency').addEventListener('click', async () => {
  const btn = $('#btn-test-concurrency');
  btn.disabled = true;
  showStatus('#concurrency-status', '并发测试中...', 'loading');
  showStatus('#test-status', '', '');

  const { serviceProvider, thinkingMode, apiKey, baseUrl, model, concurrency } = getApiConfigFromForm();

  if (!apiKey) {
    showStatus('#concurrency-status', '请填写 API Key', 'error');
    btn.disabled = false;
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
    showStatus('#concurrency-status', `并发测试成功：${concurrency}/${concurrency} 个请求全部成功`, 'success');
  } else {
    const detail = failure?.status
      ? `失败 ${concurrency - successCount} 个，首个错误为 ${failure.status}`
      : `失败 ${concurrency - successCount} 个`;
    showStatus('#concurrency-status', `并发测试未通过：成功 ${successCount}/${concurrency}，${detail}`, 'error');
  }

  btn.disabled = false;
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
  $('#test-level-value').textContent = currentTestLevel;
  updateLevelTestBoundaryButtons();
  generateLevelTestSample(currentTestLevel);
});

$('#btn-test-harder').addEventListener('click', () => {
  const idx = LEVELS.indexOf(currentTestLevel);
  if (idx >= LEVELS.length - 1) return;
  currentTestLevel = LEVELS[idx + 1];
  $('#test-level-value').textContent = currentTestLevel;
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
    html += `<span class="wordwin-annotation">${escapeHtml(text.slice(range.start, range.end))}</span>`;
    html += `<span class="wordwin-translation">(${escapeHtml(range.translation)})</span>`;
    cursor = range.end;
  }
  html += escapeHtml(text.slice(cursor));

  return html;
}

function renderLevelTestSample(samples) {
  $('#level-test-content').innerHTML = samples.map(sample => `
    <div class="sample-item">
      <strong>${escapeHtml(sample.title)}</strong>
      <div>${sample.html}</div>
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
      <section class="usage-panel">
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

function loadTokenUsage() {
  chrome.storage.local.get(['tokenUsageBuckets'], (data) => {
    renderTokenUsage(data.tokenUsageBuckets || []);
  });
}

// --- 工具函数 ---
function showStatus(selector, text, type) {
  const el = $(selector);
  el.textContent = text;
  el.className = `status ${type}`;
  if (type !== 'loading') {
    setTimeout(() => { el.textContent = ''; }, 4000);
  }
}
