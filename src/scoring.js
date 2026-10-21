/**
 * scoring.js —— 规则评分引擎（零依赖，纯函数）
 *
 * 设计原则：
 * 1. 可解释 —— 每一个分数都能说出"因为命中了哪几个词"
 * 2. 可调整 —— 权重和关键词都在 profile.json 里，改配置不改代码
 * 3. 不误导 —— 分数只做"投递优先级排序"，不做"能不能投"的判决
 */

/** 在文本里查找关键词，返回命中列表（忽略大小写，支持中英混排） */
export function findHits(text, keywords) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const kw of keywords) {
    const k = String(kw).toLowerCase().trim();
    if (!k) continue;
    if (lower.includes(k)) hits.push(kw);
  }
  return hits;
}

/** 关键词对象 → 数组（{词: 权重} → [[词, 权重], ...]） */
function entries(obj) {
  return Object.entries(obj || {});
}

/**
 * 单一维度的得分
 * @returns { raw, max, ratio, hits, weighted }
 */
function scoreDimension(dim, text) {
  const kws = entries(dim.keywords);
  if (kws.length === 0) return { raw: 0, max: 1, ratio: 0, hits: [], weighted: 0 };

  const lower = text.toLowerCase();
  let raw = 0;
  const hits = [];
  let hitWeightSum = 0;

  for (const [word, weight] of kws) {
    if (lower.includes(String(word).toLowerCase())) {
      raw += weight;
      hitWeightSum += weight;
      hits.push(word);
    }
  }

  // ── 关键设计：分母不用"全部关键词权重总和" ──
  // 原因：一个维度有 36 个关键词，JD 不可能全命中。用总和做分母会导致
  // 即便命中「前端架构+Vue3+TypeScript+Monorepo」也只拿到 6% 覆盖率。
  //
  // 正确做法：用「期望命中权重」作为满分线 —— 命中到某个权重就算覆盖充分。
  // 期望值 = 该维度权重最高的 N 个词之和（N 随维度关键词数量自适应）
  const sortedWeights = kws.map(([, w]) => w).sort((a, b) => b - a);
  const expectCount = Math.max(3, Math.min(6, Math.ceil(kws.length / 6)));
  const expectWeight = sortedWeights.slice(0, expectCount).reduce((s, w) => s + w, 0);

  // 权重覆盖率：命中权重 / 期望权重（封顶 1）
  const coverage = expectWeight > 0 ? Math.min(1, hitWeightSum / expectWeight) : 0;

  // 广度：命中词数量（8 个以上视为充分，防止堆词）
  const breadth = Math.min(1, hits.length / 8);

  // 综合：覆盖率占 70%，广度占 30%
  // （覆盖率是主信号 —— 命中高权重词比命中一堆低权重词更有意义）
  const ratio = Math.min(1, coverage * 0.7 + breadth * 0.3);

  return { raw, max: expectWeight, ratio, hits, weighted: 0 };
}

/**
 * 解析 JD 里的年限要求，判断是否 overqualified / underqualified
 * 返回 { min, max, note, bonus }
 */
export function parseYearsRequirement(text, myYears) {
  const patterns = [
    /(\d+)\s*[-~到]\s*(\d+)\s*年/g,   // 3-5 年
    /(\d+)\s*年以上/g,                 // 5 年以上
    /(\d+)\s*年及以上/g,
    /(\d+)\s*年以下/g,
  ];

  let min = null;
  let max = null;

  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    if (m.length >= 3) { min = Number(m[1]); max = Number(m[2]); }
    else if (/以上/.test(m[0])) { min = Number(m[1]); max = null; }
    else if (/以下/.test(m[0])) { min = null; max = Number(m[1]); }
    break;
  }

  if (min === null && max === null) {
    return { min, max, note: '未明确年限要求', bonus: 0 };
  }

  // 落在区间内 → 完美匹配
  if ((min === null || myYears >= min) && (max === null || myYears <= max)) {
    return { min, max, note: '年限匹配', bonus: 4 };
  }

  // 超出上限过多 → overqualified
  if (max !== null && myYears > max + 2) {
    return { min, max, note: `年限要求上限 ${max} 年，你 ${myYears} 年，可能 overqualified`, bonus: -6 };
  }

  // 低于下限 → 可能不够
  if (min !== null && myYears < min) {
    return { min, max, note: `要求 ${min} 年以上，你 ${myYears} 年`, bonus: -8 };
  }

  return { min, max, note: '年限略有偏差', bonus: 0 };
}

/** 判断岗位层级（负责人 / 高级 / 普通 / 初级） */
export function detectLevel(text) {
  const t = text.toLowerCase();
  if (/负责人|技术负责人|前端负责人|leader|主管|经理/.test(t)) return { level: '负责人', bonus: 2 };
  if (/高级|资深|senior|专家|架构师/.test(t)) return { level: '高级', bonus: 3 };
  if (/初级|入门|应届|实习/.test(t)) return { level: '初级', bonus: -12 };
  return { level: '普通', bonus: 0 };
}

/** 判断是否远程 / 弹性，这类岗位对候选人更友好 */
export function detectWorkMode(text) {
  if (/远程|remote|居家/.test(text.toLowerCase())) return '远程/弹性';
  return '坐班';
}

/**
 * 主评分函数
 * @param {object} job  { company, position, salary, text, ... }
 * @param {object} profile  读取自 profile.json
 * @returns 完整评分结果（含解释）
 */
export function scoreJob(job, profile) {
  const text = `${job.position || ''} ${job.company || ''} ${job.text || ''}`;

  // ── 1. 六维度打分 ──
  const dims = profile.dimensions.map((dim) => {
    const s = scoreDimension(dim, text);
    return {
      id: dim.id,
      name: dim.name,
      weight: dim.weight,
      level: dim.level,
      ratio: s.ratio,
      raw: s.raw,
      max: s.max,
      hits: s.hits,
      // 该维度贡献的分数（权重 × 覆盖率）
      score: dim.weight * s.ratio,
    };
  });

  const dimensionScore = dims.reduce((sum, d) => sum + d.score, 0);

  // ── 2. 领域加分 ──
  const domainHits = [];
  let domainScore = 0;
  for (const d of profile.domains) {
    const hits = findHits(text, d.keywords);
    if (hits.length > 0) {
      domainScore += d.bonus;
      domainHits.push({ name: d.name, bonus: d.bonus, hits });
    }
  }

  // ── 3. 通用加分项 ──
  const pluses = [];
  let plusScore = 0;
  for (const p of profile.pluses) {
    const hits = findHits(text, p.keywords);
    if (hits.length > 0) {
      plusScore += p.bonus;
      pluses.push({ reason: p.reason, bonus: p.bonus, hits });
    }
  }

  // ── 4. 减分项 ──
  const negatives = [];
  let negativeScore = 0;
  for (const n of profile.negatives) {
    const hits = findHits(text, n.keywords);
    if (hits.length > 0) {
      negativeScore += n.penalty;
      negatives.push({ reason: n.reason, penalty: n.penalty, hits });
    }
  }

  // ── 5. 年限 / 层级判断 ──
  const years = parseYearsRequirement(text, profile.profile.years);
  const level = detectLevel(`${job.position || ''} ${text}`);
  const workMode = detectWorkMode(text);

  // ── 6. 总分（封顶 100，不低于 0）──
  const rawTotal =
    dimensionScore +
    domainScore +
    plusScore +
    negativeScore +
    years.bonus +
    level.bonus;

  const total = Math.max(0, Math.min(100, Math.round(rawTotal)));

  // ── 7. 评级 ──
  let grade, gradeLabel;
  if (total >= 78) { grade = 'S'; gradeLabel = '强匹配 · 优先投'; }
  else if (total >= 65) { grade = 'A'; gradeLabel = '较匹配 · 值得投'; }
  else if (total >= 50) { grade = 'B'; gradeLabel = '一般 · 有意向再投'; }
  else if (total >= 35) { grade = 'C'; gradeLabel = '弱匹配 · 不建议投'; }
  else { grade = 'D'; gradeLabel = '不匹配 · 跳过'; }

  // ── 8. 强项 / 短板（用于生成投递策略）──
  const sorted = [...dims].sort((a, b) => b.score - a.score);
  const strengths = sorted.slice(0, 3).filter((d) => d.ratio > 0.15);
  const weaknesses = sorted
    .filter((d) => d.ratio < 0.12 && d.weight >= 15)
    .map((d) => ({ name: d.name, weight: d.weight }));

  return {
    ...job,
    total,
    grade,
    gradeLabel,
    workMode,
    breakdown: {
      dimensions: dims,
      domainHits,
      domainScore,
      pluses,
      plusScore,
      negatives,
      negativeScore,
      years,
      level,
    },
    strengths,
    weaknesses,
  };
}

/** 批量评分 + 排序 */
export function scoreAll(jobs, profile) {
  return jobs
    .map((j) => scoreJob(j, profile))
    .sort((a, b) => b.total - a.total);
}
