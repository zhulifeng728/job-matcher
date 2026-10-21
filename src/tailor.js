/**
 * tailor.js —— 按岗位定制简历 + 生成复习知识
 *
 * 两个能力都先走规则（不依赖 AI），保证没配模型时也能用：
 *   ① tailorResume()  —— 按 JD 重排简历要点、指出要补的短板、生成针对性的简历摘要
 *   ② buildStudyPlan() —— 按 JD 涉及的知识点生成复习清单、面试问题、项目讲述建议
 *
 * 规则的价值在于可控、可解释、零成本；AI 是锦上添花的措辞优化。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_PATH = resolve(__dirname, '../data/presets/knowledge.json');

let knowledgeCache = null;

export function loadKnowledge() {
  if (knowledgeCache) return knowledgeCache;
  if (!existsSync(KNOWLEDGE_PATH)) return { dimensions: {}, keywordMap: {} };
  try {
    knowledgeCache = JSON.parse(readFileSync(KNOWLEDGE_PATH, 'utf-8'));
    return knowledgeCache;
  } catch {
    return { dimensions: {}, keywordMap: {} };
  }
}

/** 取 JD 文本（岗位名 + 公司 + 正文） */
function jobText(job) {
  return `${job.position || ''} ${job.company || ''} ${job.text || ''}`;
}

// ═══════════════════════════════════════════════
// ① 简历定制
// ═══════════════════════════════════════════════

/**
 * 按 JD 给简历要点打分并排序
 *
 * 打分依据三个信号：
 *   1. 该要点的关键词在 JD 中命中几个（最直接）
 *   2. 该要点属于的维度，在本岗位的满足度（岗位重视什么）
 *   3. 该要点是否覆盖了岗位的短板维度（补位价值）
 */
export function tailorResume(job, profile, scoreResult) {
  const text = jobText(job).toLowerCase();
  const highlights = profile.highlights || [];

  // 维度 → 岗位需求强度（用该维度在 JD 里的命中比例近似）
  const dimStrength = {};
  for (const d of scoreResult.breakdown.dimensions) {
    dimStrength[d.id] = d.ratio;
  }
  // 短板维度：岗位有要求（ratio>0）但候选人覆盖低
  const gaps = scoreResult.breakdown.dimensions
    .filter((d) => d.ratio > 0 && d.ratio < 0.45)
    .sort((a, b) => b.weight - a.weight);

  const scored = highlights.map((h) => {
    // 信号 1：关键词命中
    const hitKeywords = (h.keywords || []).filter((k) => text.includes(String(k).toLowerCase()));

    // 信号 2：所属维度的岗位强度
    const dimScore = (h.dims || []).reduce((s, id) => s + (dimStrength[id] || 0), 0)
      / Math.max(1, (h.dims || []).length);

    // 信号 3：是否补位短板
    const fillsGap = (h.dims || []).some((id) => gaps.some((g) => g.id === id));

    // 综合分（0-100）
    const kwScore = Math.min(1, hitKeywords.length / 3);         // 命中 3 个即满分
    const raw = kwScore * 55 + dimScore * 35 + (fillsGap ? 10 : 0);

    return {
      id: h.id,
      text: h.text,
      dims: h.dims,
      hitKeywords,
      score: Math.round(raw),
    };
  }).sort((a, b) => b.score - a.score);

  // 分档：强烈建议前置 / 可以保留 / 建议弱化
  const strong = scored.filter((h) => h.score >= 55);
  const keep = scored.filter((h) => h.score >= 30 && h.score < 55);
  const weak = scored.filter((h) => h.score < 30);

  // 生成简历摘要：取前 3 条强相关要点，压缩成一段
  const summary = buildResumeSummary(job, strong, profile);

  // 短板建议
  const gapAdvice = gaps.slice(0, 4).map((g) => ({
    dimension: g.name,
    weight: g.weight,
    ratio: Number(g.ratio.toFixed(2)),
    advice: gapAdviceFor(g, text),
  }));

  // 关键词覆盖分析：JD 里出现、但简历要点没覆盖到的
  const jdKeywords = collectJdKeywords(job, profile);
  const covered = new Set();
  for (const h of scored) for (const k of h.hitKeywords) covered.add(k.toLowerCase());
  const missing = jdKeywords.filter((k) => !covered.has(k.toLowerCase())).slice(0, 8);

  return {
    summary,
    strong: strong.slice(0, 6),
    keep: keep.slice(0, 6),
    weak: weak.slice(0, 5),
    gaps: gapAdvice,
    missingKeywords: missing,
    stats: {
      total: highlights.length,
      strongCount: strong.length,
      coverage: jdKeywords.length
        ? Math.round((covered.size / jdKeywords.length) * 100)
        : 0,
    },
  };
}

/** 生成一段针对该岗位的简历摘要 */
function buildResumeSummary(job, strongHighlights, profile) {
  const years = profile.profile.years;
  const role = job.position || '该岗位';
  const picks = strongHighlights.slice(0, 3);

  if (!picks.length) {
    return `${years} 年前端开发经验。建议先补充与该岗位（${role}）相关的项目描述，再生成摘要。`;
  }

  // 用第一条的维度名做能力定位
  const head = `${years} 年前端开发经验`;
  const body = picks.map((p) => p.text).join('；');

  return `${head}。针对「${role}」这个岗位，建议把简历摘要写成：\n\n${head}，${body}。`;
}

/** 针对短板维度给具体建议 */
function gapAdviceFor(dim, text) {
  const map = {
    frontend_arch: '这个岗位重视工程化与架构。建议补一条「做过什么架构改造、解决了什么具体问题、效果如何量化」的描述，而不是只写「熟悉工程化」。',
    ai_application: '岗位涉及 AI 能力。如果只是用过 AI 工具，建议改写成「用 AI 解决过什么具体问题」；如果没有项目经验，可以先做一个最小可用的 demo 再写。',
    multi_platform: '岗位要求多端能力。建议把小程序/企微项目里的「同一功能多端适配」的具体做法写清楚（条件编译、能力探测、差异兜底）。',
    backend_fullstack: '岗位要求全栈能力。如果没有服务端经验，建议突出「接口设计」「与后端协作定规范」的部分，或快速补一个 BFF 实践。',
    system_design: '岗位要求系统设计与稳定性。建议补充「权限体系、监控告警、灰度回滚」这类体系性工作的描述。',
    leadership: '岗位涉及团队管理。建议写清「带过几个人、负责哪些决策、怎么推动跨团队落地」，用具体事代替「有管理经验」。',
  };
  return map[dim.id] || `岗位在该维度有要求（权重 ${dim.weight}），建议补充相关经历描述。`;
}

/** 收集 JD 中出现的、在画像关键词表里能对上的词 */
function collectJdKeywords(job, profile) {
  const text = jobText(job).toLowerCase();
  const pool = new Set();

  for (const dim of profile.dimensions || []) {
    for (const kw of Object.keys(dim.keywords || {})) {
      if (kw.length >= 2 && text.includes(String(kw).toLowerCase())) pool.add(kw);
    }
  }
  return [...pool];
}

// ═══════════════════════════════════════════════
// ② 复习知识
// ═══════════════════════════════════════════════

/**
 * 按岗位生成复习计划
 *
 * 逻辑：
 *   1. 从岗位得分维度取「要求强度」作为权重
 *   2. 每个维度下挑知识点，优先级 = 维度强度 × 知识点等级
 *   3. 用 keywordMap 把 JD 里出现的具体关键词精确映射到知识点（更高优先级）
 */
export function buildStudyPlan(job, profile, scoreResult) {
  const kb = loadKnowledge();
  const text = jobText(job).toLowerCase();

  // ── 1. JD 精确命中的知识点（最高优先级）──
  const exactTopics = new Map();   // topicName → { reason, weight }
  const jdHits = [];

  for (const [kw, topicNames] of Object.entries(kb.keywordMap || {})) {
    if (!text.includes(String(kw).toLowerCase())) continue;
    jdHits.push(kw);
    for (const t of topicNames) {
      const prev = exactTopics.get(t) || { weight: 0, keywords: [] };
      prev.weight += 2;
      prev.keywords.push(kw);
      exactTopics.set(t, prev);
    }
  }

  // ── 2. 按维度强度挑知识点 ──
  const dims = scoreResult.breakdown.dimensions
    .filter((d) => d.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio);

  const picked = [];
  const seen = new Set();

  // 先放精确命中的（按命中关键词数量降序，最多 8 条 —— 两天复习清单不能太长）
  const exactSorted = [...exactTopics.entries()]
    .sort((a, b) => b[1].keywords.length - a[1].keywords.length)
    .slice(0, 8);

  for (const [topicName, meta] of exactSorted) {
    const topic = findTopic(kb, topicName);
    if (!topic || seen.has(topicName)) continue;
    seen.add(topicName);
    picked.push({
      ...topic,
      priority: 'P0',
      reason: `JD 明确提到：${[...new Set(meta.keywords)].slice(0, 4).join('、')}`,
      dimension: topic.dimension,
    });
  }

  // 再按维度补充
  for (const d of dims) {
    const group = kb.dimensions?.[d.id];
    if (!group) continue;

    for (const t of group.topics || []) {
      if (seen.has(t.name)) continue;

      // 优先级：岗位该维度强度高 + 知识点等级高
      let priority = 'P2';
      if (d.ratio >= 0.7 && t.level === '核心') priority = 'P0';
      else if (d.ratio >= 0.5 || t.level === '核心') priority = 'P1';
      else if (t.level === '重点') priority = 'P1';

      if (picked.filter((p) => p.priority === 'P0').length >= 8) priority = 'P1';

      seen.add(t.name);
      picked.push({
        ...t,
        priority,
        reason: `该岗位在「${d.name}」维度要求较强（命中 ${d.hits.length} 个关键词）`,
        dimension: d.name,
      });

      // 每个维度最多取 3 条，避免清单过长
      if (picked.filter((p) => p.dimension === d.name && p.priority !== 'P0').length >= 3) break;
    }
  }

  // 总量封顶：清单太长等于没清单
  const MAX_TOPICS = 16;
  if (picked.length > MAX_TOPICS) picked.length = MAX_TOPICS;

  // ── 3. 汇总面试问题 ──
  const questions = [];
  for (const p of picked) {
    for (const q of p.questions || []) {
      questions.push({ q, topic: p.name, priority: p.priority });
    }
  }
  const topQuestions = questions
    .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority))
    .slice(0, 12);

  // ── 4. 项目讲述建议 ──
  const talkingPoints = buildTalkingPoints(job, profile, scoreResult, picked);

  // ── 5. 时间安排建议 ──
  const plan = buildSchedule(picked);

  return {
    jobTitle: job.position,
    company: job.company,
    exactHits: [...new Set(jdHits)].slice(0, 12),
    topics: picked.map((p) => ({
      name: p.name,
      dimension: p.dimension,
      priority: p.priority,
      level: p.level,
      reason: p.reason,
      points: p.points || [],
      questions: p.questions || [],
    })),
    questions: topQuestions,
    talkingPoints,
    schedule: plan,
    stats: {
      p0: picked.filter((p) => p.priority === 'P0').length,
      p1: picked.filter((p) => p.priority === 'P1').length,
      p2: picked.filter((p) => p.priority === 'P2').length,
      total: picked.length,
    },
  };
}

function priorityRank(p) {
  return p === 'P0' ? 0 : p === 'P1' ? 1 : 2;
}

function findTopic(kb, name) {
  for (const [dimId, group] of Object.entries(kb.dimensions || {})) {
    for (const t of group.topics || []) {
      if (t.name === name) return { ...t, dimension: groupName(kb, dimId) };
    }
  }
  return null;
}

function groupName(kb, dimId) {
  const names = {
    frontend_arch: '前端架构与工程化',
    ai_application: 'AI 应用落地',
    multi_platform: '小程序与多端',
    backend_fullstack: '后端与全栈能力',
    system_design: '系统设计与性能',
    leadership: '团队管理',
  };
  return names[dimId] || dimId;
}

/** 项目讲述建议：把简历要点转成「面试时怎么讲」 */
function buildTalkingPoints(job, profile, scoreResult, topics) {
  const highlights = profile.highlights || [];
  const text = jobText(job).toLowerCase();

  const relevant = highlights
    .map((h) => ({
      text: h.text,
      hits: (h.keywords || []).filter((k) => text.includes(String(k).toLowerCase())),
    }))
    .filter((h) => h.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length)
    .slice(0, 4);

  return relevant.map((h) => ({
    story: h.text,
    // STAR 骨架提示
    structure: '按「背景 → 我的动作 → 结果」讲，结果尽量给数字',
    matchedKeywords: h.hits,
  }));
}

/** 时间安排：按优先级给一个可执行的两天计划 */
function buildSchedule(topics) {
  const p0 = topics.filter((t) => t.priority === 'P0');
  const p1 = topics.filter((t) => t.priority === 'P1');

  const half = Math.ceil(p0.length / 2);

  return [
    {
      day: '第一天',
      focus: '把 P0 讲清楚',
      items: p0.slice(0, half).map((t) => t.name),
      tip: '每个主题准备一个「我做过什么 + 为什么这么做 + 有什么效果」的三句话版本',
    },
    {
      day: '第一天下午',
      focus: 'P0 收尾 + 自测',
      items: p0.slice(half).map((t) => t.name),
      tip: '对着清单把问题自问自答一遍，卡壳的地方就是真实短板',
    },
    {
      day: '第二天',
      focus: 'P1 补齐 + 项目讲述',
      items: p1.slice(0, 5).map((t) => t.name),
      tip: '项目讲述按 STAR 结构串一遍，重点准备 2 个能深挖的案例',
    },
  ].filter((d) => d.items.length > 0);
}
