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
  // 惩罚随超出年数递增（每年 -3），封顶 -18，避免"9 年经验投 5 年上限岗位"仍然拿高分
  if (max !== null && myYears > max + 2) {
    const over = myYears - max;
    const penalty = Math.max(-18, -3 * over);
    return {
      min,
      max,
      note: `年限要求上限 ${max} 年，你 ${myYears} 年，超出 ${over} 年，可能 overqualified`,
      bonus: penalty,
    };
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

  // ══════════════════════════════════════════════════════════════
  // 维度汇总（核心算法，改过一版）
  //
  // 旧算法（有缺陷）：dimensionScore = Σ(weight × ratio)，满分固定 100。
  //   问题：分母是「候选人全部能力的权重和」，与 JD 无关。
  //   结果：一个只要求小程序能力的岗位，即使候选人完美匹配，
  //        也只能拿到 15/100 分 → 被判 D 级。这违背匹配的本意。
  //
  // 新算法：分两步
  //   ① 满足度 matchRatio = Σ命中维度的得分 / Σ命中维度的权重
  //      —— 分母只算「JD 真正要求的维度」，回答「要求的东西我有没有」
  //   ② 广度 breadth = Σ命中维度的权重 / 全部维度权重
  //      —— 回答「这个岗位能用上我多少能力」，用于区分岗位层次
  //   综合 = 100 × (满足度 × 0.7 + 广度 × 0.3)
  // ══════════════════════════════════════════════════════════════

  const totalWeight = dims.reduce((s, d) => s + d.weight, 0);
  const demanded = dims.filter((d) => d.ratio > 0);        // JD 有要求的维度
  const demandedWeight = demanded.reduce((s, d) => s + d.weight, 0);
  const demandedScore = demanded.reduce((s, d) => s + d.score, 0);

  // 满足度：JD 要求的部分，候选人覆盖得多好（0..1）
  const matchRatio = demandedWeight > 0 ? demandedScore / demandedWeight : 0;

  // 广度：JD 要求的权重占候选人全部能力的比例（0..1）
  const breadth = totalWeight > 0 ? demandedWeight / totalWeight : 0;

  // 满足度是主信号（70%），广度用于奖励"能用上更多能力"的高层次岗位（30%）
  const dimensionScore = 100 * (matchRatio * 0.7 + breadth * 0.3);

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

  // ── 7. 评级（阈值可在 profile.json 的 grades 里覆盖）──
  // 默认阈值按「一个匹配度良好的人去投一批相关岗位」校准：
  //   约 15% 落在 S，25% 落在 A，其余按弱匹配分布
  // 如果你的画像关键词少、整体分数偏低，可以下调这些阈值
  const G = { S: 88, A: 75, B: 58, C: 40, ...(profile.grades || {}) };

  let grade, gradeLabel;
  if (total >= G.S) { grade = 'S'; gradeLabel = '强匹配 · 优先投'; }
  else if (total >= G.A) { grade = 'A'; gradeLabel = '较匹配 · 值得投'; }
  else if (total >= G.B) { grade = 'B'; gradeLabel = '一般 · 有意向再投'; }
  else if (total >= G.C) { grade = 'C'; gradeLabel = '弱匹配 · 不建议投'; }
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
