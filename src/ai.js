/**
 * ai.js —— AI 增强模块（多供应商 + 环境变量优先）
 *
 * ═══════════════════════════════════════════════════════════════
 * 安全设计（重点）：
 *   1. API Key 只从环境变量读取，不写入任何数据文件
 *   2. 只有当设置 JOB_MATCHER_ALLOW_FILE_KEY=1 时才允许从本地文件读
 *   3. 所有 provider 都走 OpenAI 兼容协议，所以一套代码通吃
 *   4. Key 永远不会返回给前端（只返回"已配置/未配置"）
 * ═══════════════════════════════════════════════════════════════
 *
 * 支持的免费模型来源（详见 docs/FREE-MODELS.md）：
 *   - OpenRouter   → :free 后缀的模型（如 meta-llama/llama-3.3-70b-instruct:free）
 *   - NVIDIA NIM   → build.nvidia.com 的免费额度模型
 *   - 本地 Ollama  → 完全免费，无需联网
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE_KEY_PATH = resolve(__dirname, '../data/ai-config.json');

/**
 * 供应商预设
 * baseUrl 和默认 model 都预置好，用户只需填 Key
 */
export const PROVIDERS = {
  openrouter: {
    label: 'OpenRouter（有免费模型）',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'meta-llama/llama-3.3-70b-instruct:free',
    freeNote: '模型名带 :free 后缀即为免费额度，详见 docs/FREE-MODELS.md',
    envKeys: ['OPENROUTER_API_KEY'],
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/yourname/job-matcher',
      'X-Title': 'Job Matcher',
    },
  },
  nvidia: {
    label: 'NVIDIA NIM（有免费额度）',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    freeNote: 'build.nvidia.com 注册后每个模型有免费调用额度',
    envKeys: ['NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY'],
  },
  deepseek: {
    label: 'DeepSeek（便宜）',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    envKeys: ['DEEPSEEK_API_KEY'],
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    envKeys: ['OPENAI_API_KEY'],
  },
  qwen: {
    label: '通义千问（阿里云）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    defaultModel: 'qwen-plus',
    envKeys: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY'],
  },
  moonshot: {
    label: 'Moonshot（Kimi）',
    baseUrl: 'https://api.moonshot.cn/v1',
    defaultModel: 'moonshot-v1-8k',
    envKeys: ['MOONSHOT_API_KEY'],
  },
  ollama: {
    label: '本地 Ollama（完全免费）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    defaultModel: 'qwen2.5:7b',
    freeNote: '需本地先 `ollama pull qwen2.5:7b`，无需 Key',
    envKeys: [],
  },
};

/** 按顺序尝试从环境变量找 Key */
function findEnvKey(provider) {
  const cfg = PROVIDERS[provider];
  if (!cfg) return '';
  for (const k of cfg.envKeys) {
    if (process.env[k]) return process.env[k];
  }
  return '';
}

/** 从 provider 的通用环境变量找 Key（如用户只设了 OPENAI_API_KEY） */
function findAnyEnvKey() {
  const candidates = [
    'OPENROUTER_API_KEY', 'NVIDIA_API_KEY', 'NVIDIA_NIM_API_KEY',
    'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'DASHSCOPE_API_KEY',
    'QWEN_API_KEY', 'MOONSHOT_API_KEY', 'JOB_MATCHER_AI_KEY',
  ];
  for (const k of candidates) if (process.env[k]) return { key: process.env[k], envName: k };
  return { key: '', envName: '' };
}

/**
 * 解析当前 AI 配置
 *
 * 优先级（越靠前越安全）：
 *   ① 环境变量 JOB_MATCHER_PROVIDER + 对应的 API Key 环境变量
 *   ② 环境变量 JOB_MATCHER_AI_KEY（通用，需同时指定 baseUrl/model）
 *   ③ 本地文件 data/ai-config.json（仅当 ALLOW_FILE_KEY=1）
 */
export function resolveAIConfig() {
  // ── ① 明确指定了 provider ──
  const providerName = (process.env.JOB_MATCHER_PROVIDER || '').toLowerCase();
  if (providerName && PROVIDERS[providerName]) {
    const preset = PROVIDERS[providerName];
    const apiKey = process.env.JOB_MATCHER_AI_KEY || findEnvKey(providerName);

    // ollama 不需要 Key
    if (providerName !== 'ollama' && !apiKey) {
      return { enabled: false, reason: `已指定 ${preset.label}，但缺少 API Key 环境变量（${preset.envKeys.join(' 或 ') || 'JOB_MATCHER_AI_KEY'}）` };
    }

    return {
      enabled: true,
      source: 'env',
      provider: providerName,
      label: preset.label,
      baseUrl: process.env.JOB_MATCHER_BASE_URL || preset.baseUrl,
      model: process.env.JOB_MATCHER_MODEL || preset.defaultModel,
      apiKey,
      extraHeaders: preset.extraHeaders || {},
      timeoutMs: Number(process.env.JOB_MATCHER_TIMEOUT_MS) || 60000,
    };
  }

  // ── ② 通用 Key（用户自己指定 baseUrl/model）──
  const anyKey = findAnyEnvKey();
  if (anyKey.key) {
    // 从 Key 的环境变量名反推 provider
    const guess = Object.entries(PROVIDERS).find(([, p]) => p.envKeys.includes(anyKey.envName));
    const provider = guess ? guess[0] : 'custom';
    const preset = PROVIDERS[provider] || {};

    return {
      enabled: true,
      source: 'env',
      provider,
      label: preset.label || `自定义（${anyKey.envName}）`,
      baseUrl: process.env.JOB_MATCHER_BASE_URL || preset.baseUrl || '',
      model: process.env.JOB_MATCHER_MODEL || preset.defaultModel || '',
      apiKey: anyKey.key,
      extraHeaders: preset.extraHeaders || {},
      timeoutMs: Number(process.env.JOB_MATCHER_TIMEOUT_MS) || 60000,
    };
  }

  // ── ③ 本地文件（仅开发用，需显式开启）──
  if (process.env.JOB_MATCHER_ALLOW_FILE_KEY === '1' && existsSync(FILE_KEY_PATH)) {
    try {
      const cfg = JSON.parse(readFileSync(FILE_KEY_PATH, 'utf-8'));
      if (cfg.baseUrl && cfg.model) {
        return {
          enabled: true,
          source: 'file',
          provider: 'custom',
          label: '本地配置文件',
          baseUrl: cfg.baseUrl,
          model: cfg.model,
          apiKey: cfg.apiKey || '',
          extraHeaders: {},
          timeoutMs: cfg.timeoutMs || 60000,
          warning: '⚠️ 当前 Key 来自本地文件，生产环境建议改用环境变量',
        };
      }
    } catch { /* 忽略 */ }
  }

  return { enabled: false, reason: '未配置 AI（未检测到任何 API Key 环境变量）' };
}

export function isAIEnabled() {
  return resolveAIConfig().enabled;
}

/** 给前端看的脱敏状态（绝不返回 Key） */
export function getAIPublicStatus() {
  const cfg = resolveAIConfig();
  if (!cfg.enabled) {
    return {
      enabled: false,
      reason: cfg.reason,
      providers: Object.entries(PROVIDERS).map(([id, p]) => ({
        id, label: p.label, defaultModel: p.defaultModel,
        freeNote: p.freeNote || '', envKeys: p.envKeys,
      })),
    };
  }
  return {
    enabled: true,
    label: cfg.label,
    provider: cfg.provider,
    model: cfg.model,
    source: cfg.source,
    warning: cfg.warning || '',
    keyConfigured: Boolean(cfg.apiKey) || cfg.provider === 'ollama',
  };
}

/**
 * 调 OpenAI 兼容接口
 * 统一处理：超时、错误分类、重试
 */
async function chat(messages, { temperature = 0.4, maxTokens = 900, retries = 1 } = {}) {
  const cfg = resolveAIConfig();
  if (!cfg.enabled) throw new Error(cfg.reason || 'AI 未配置');

  const url = `${cfg.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', ...cfg.extraHeaders };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;

  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model: cfg.model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        const detail = body.slice(0, 300);

        // 错误分类：只有 5xx / 429 / 超时可以重试
        const retryable = res.status >= 500 || res.status === 429;
        const msg = explainHttpError(res.status, detail, cfg);

        if (retryable && attempt < retries) {
          lastErr = new Error(msg);
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));  // 退避
          continue;
        }
        throw new Error(msg);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('模型返回内容为空（可能是模型不支持该参数）');
      return content.trim();
    } catch (e) {
      lastErr = e;
      // 超时 / 网络错误可重试
      const retryable = e.name === 'AbortError' || e.code === 'ECONNRESET' || e.cause;
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
        continue;
      }
      if (e.name === 'AbortError') {
        throw new Error(`AI 请求超时（${cfg.timeoutMs}ms）。免费模型有时响应很慢，可以调大 JOB_MATCHER_TIMEOUT_MS`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr || new Error('AI 调用失败');
}

/** 把 HTTP 错误翻译成人话 */
function explainHttpError(status, detail, cfg) {
  const hints = {
    401: 'API Key 无效或已过期，检查环境变量',
    402: '账户余额不足，或者免费额度已用完',
    403: '没有权限访问该模型（免费模型有时需要先在页面同意条款）',
    404: `模型 "${cfg.model}" 不存在，检查模型名是否正确`,
    429: '请求太频繁被限流，稍后重试或降低并发',
    500: '模型服务端错误，重试或换模型',
    502: '网关错误，模型服务可能暂时不可用',
    503: '模型服务过载，稍后重试',
  };
  const hint = hints[status] || '未知错误';
  return `AI 接口 ${status}：${hint}\n原始响应：${detail}`;
}

// ═══════════════════════════════════════════
// 产品能力：打招呼语 + 投递建议
// ═══════════════════════════════════════════

/** 生成个性化打招呼语（可直接复制发送） */
export async function generateGreeting(job, profile, scoreResult) {
  const topStrengths = (scoreResult.strengths || [])
    .map((s) => `${s.name}（${(s.hits || []).slice(0, 3).join('、')}）`)
    .join('；');

  const system = `你是一位资深技术招聘顾问，帮候选人写一条发给 HR 的打招呼消息。

硬性要求：
1. 不超过 80 字，是可立即发送的成品，不要任何解释、不要加引号
2. 第一句点出与该岗位最相关的**一个具体战绩**，不要泛泛说"经验丰富"
3. 语气专业克制，不用"贵司"这类套话，不用感叹号
4. 必须提及岗位 JD 里出现的**至少一个具体技术或业务点**
5. 结尾用一个短问句引导回复

候选人真实背景（不得编造）：
${profile.profile.headline}，${profile.profile.years} 年经验
${(profile.resumeText || '').slice(0, 700)}`;

  const user = `岗位：${job.position}
公司：${job.company}
薪资：${job.salary}
匹配度：${scoreResult.total}/100
候选人强项：${topStrengths || '（无）'}

岗位描述：
${(job.text || '').slice(0, 1800)}

请写打招呼消息。`;

  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.6, maxTokens: 300 }
  );

  return raw.replace(/^["'「『]|["'」』]$/g, '').trim();
}

/** 生成投递建议（突出什么 / 准备什么 / 风险在哪） */
export async function generateAdvice(job, profile, scoreResult) {
  const weakList = (scoreResult.weaknesses || []).map((w) => w.name).join('、') || '无明显短板';

  const system = `你是资深前端面试官。基于岗位 JD 和候选人背景，给出 3 条极简投递建议。

严格按此格式输出（只输出三行，不要标题不要解释）：
突出：<简历里该重点讲哪段经历>
准备：<面试最可能被追问的技术点>
风险：<这个岗位对他最不利的地方>`;

  const user = `岗位：${job.position}｜公司：${job.company}｜匹配度 ${scoreResult.total}/100
短板维度：${weakList}
候选人背景：${(profile.resumeText || '').slice(0, 800)}

岗位描述：
${(job.text || '').slice(0, 1800)}`;

  const raw = await chat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    { temperature: 0.3, maxTokens: 400 }
  );

  const result = { highlight: '', prepare: '', risk: '', raw };
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (/^突出[:：]/.test(t)) result.highlight = t.replace(/^突出[:：]\s*/, '');
    else if (/^准备[:：]/.test(t)) result.prepare = t.replace(/^准备[:：]\s*/, '');
    else if (/^风险[:：]/.test(t)) result.risk = t.replace(/^风险[:：]\s*/, '');
  }
  return result;
}

/** 并发批处理（限制并发，避免打爆免费额度） */
export async function generateBatch(items, fn, concurrency = 2) {
  const results = [];
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const idx = cursor++;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (e) {
        results[idx] = { ok: false, error: e.message };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

/** 测试连接 */
export async function testConnection() {
  const cfg = resolveAIConfig();
  if (!cfg.enabled) return { ok: false, message: cfg.reason };

  try {
    const reply = await chat([{ role: 'user', content: '只回复两个字：可用' }], { maxTokens: 20 });
    return {
      ok: true,
      message: `连接正常 ｜ 供应商：${cfg.label} ｜ 模型：${cfg.model} ｜ 回复：${reply.slice(0, 40)}`,
    };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}

/** 供 docs 用：导出供应商列表 */
export function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id,
    label: p.label,
    baseUrl: p.baseUrl,
    defaultModel: p.defaultModel,
    freeNote: p.freeNote || '',
    envKeys: p.envKeys,
    needsKey: id !== 'ollama',
  }));
}
