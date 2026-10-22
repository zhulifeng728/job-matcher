/**
 * calibrate.js —— 用真实投递结果反推评分权重
 *
 * 这是竞品都没做的事：Career-Ops / Resume-Matcher / ai-job-search 的评分权重
 * 都是静态的（拍脑袋定的或按 JD 关键词算的），没人用「投出去之后发生了什么」来校准。
 *
 * 思路：
 *   把岗位分成「进面/拿 offer」和「投了没消息」两组，
 *   比较每个能力维度在两组的平均得分 —— 差得越多，说明这个维度越能区分结果。
 *   用这个差值调整权重。
 *
 * 但样本少的时候「统计显著」是假的，所以：
 *   1. 样本不足直接拒绝给出建议，只说还差多少
 *   2. 给出置信度，并明确写「这是启发式，不是因果」
 *   3. 永远不自动应用，必须用户点确认
 *   4. 调整幅度有上限（每维最多 ±60%），避免一两个极端样本把权重带偏
 */

/** 结果归组规则 */
const POSITIVE = new Set(['interview', 'offer']);
const NEGATIVE = new Set(['applied', 'replied', 'dropped', 'rejected']);
// new / viewed：还没投，不参与

/** 最少样本量 */
const MIN_APPLIED = 6;
const MIN_POSITIVE = 2;

/** 单维权重最大调整幅度 */
const MAX_ADJUST = 0.6;

/**
 * 分析投递结果
 */
export function analyzeOutcomes(jobs = []) {
  const buckets = { positive: [], negative: [], pending: [], total: jobs.length };

  for (const j of jobs) {
    const st = j.status || 'new';
    if (POSITIVE.has(st)) buckets.positive.push(j);
    else if (NEGATIVE.has(st)) buckets.negative.push(j);
    else buckets.pending.push(j);
  }

  const applied = buckets.positive.length + buckets.negative.length;
  const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return {
    total: buckets.total,
    applied,
    positive: buckets.positive.length,
    negative: buckets.negative.length,
    pending: buckets.pending.length,
    interviewRate: rate(buckets.positive.length, applied),
    offerCount: jobs.filter((j) => j.status === 'offer').length,
    repliedCount: jobs.filter((j) => ['replied', 'interview', 'offer'].includes(j.status)).length,
    buckets,
  };
}

/**
 * 校准权重
 * @returns 分析结果（含是否样本足够、建议权重、依据）
 */
export function calibrate(profile, jobs = []) {
  const dims = profile.dimensions || [];
  const stat = analyzeOutcomes(jobs);

  const base = {
    sample: {
      total: stat.total,
      applied: stat.applied,
      positive: stat.positive,
      negative: stat.negative,
      pending: stat.pending,
      interviewRate: stat.interviewRate,
      offerCount: stat.offerCount,
      repliedCount: stat.repliedCount,
    },
    currentWeights: Object.fromEntries(dims.map((d) => [d.id, currentWeightOf(profile, d)])),
    applied: Boolean(profile.weights && Object.keys(profile.weights).length),
  };

  // ── 样本不足：拒绝给建议 ──
  const reasons = [];
  if (stat.applied < MIN_APPLIED) {
    reasons.push(`已投递的岗位只有 ${stat.applied} 个，至少需要 ${MIN_APPLIED} 个`);
  }
  if (stat.positive < MIN_POSITIVE) {
    reasons.push(`进入面试的只有 ${stat.positive} 个，至少需要 ${MIN_POSITIVE} 个`);
  }

  if (reasons.length) {
    return {
      ...base,
      sufficient: false,
      reasons,
      need: {
        moreApplied: Math.max(0, MIN_APPLIED - stat.applied),
        morePositive: Math.max(0, MIN_POSITIVE - stat.positive),
      },
      dimensions: [],
      note: '样本太少时算出来的「规律」大概率是巧合。先把岗位投出去、更新状态，'
        + '攒够样本再回来看。',
    };
  }

  // ── 逐维度比较两组平均得分 ──
  const rows = dims.map((dim) => {
    const pick = (j) => {
      const d = (j.dimensions || []).find((x) => x.id === dim.id);
      return d ? Number(d.ratio) || 0 : 0;
    };

    const posVals = stat.buckets.positive.map(pick);
    const negVals = stat.buckets.negative.map(pick);
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

    const avgPos = avg(posVals);
    const avgNeg = avg(negVals);
    const lift = avgPos - avgNeg;

    const cur = currentWeightOf(profile, dim);
    // 调整：lift 为正说明这个维度在成功组里更突出，权重上调
    const factor = Math.max(1 - MAX_ADJUST, Math.min(1 + MAX_ADJUST, 1 + lift * 1.2));
    const raw = cur * factor;

    return {
      id: dim.id,
      name: dim.name,
      currentWeight: cur,
      rawWeight: raw,
      lift: Number(lift.toFixed(3)),
      avgPositive: Number(avgPos.toFixed(3)),
      avgNegative: Number(avgNeg.toFixed(3)),
      nPositive: posVals.length,
      nNegative: negVals.length,
      // 这个维度在成功岗位里普遍分值低（说明岗位不要求它），不该加权
      lowDemand: avgPos < 0.15 && avgNeg < 0.15,
    };
  });

  // ── 归一化到 100 ──
  const sumRaw = rows.reduce((s, r) => s + r.rawWeight, 0) || 1;
  for (const r of rows) {
    r.suggestedWeight = Math.round((r.rawWeight / sumRaw) * 100);
    r.delta = r.suggestedWeight - r.currentWeight;
  }

  // 四舍五入可能差 1-2 分，补到最大项上
  const diff = 100 - rows.reduce((s, r) => s + r.suggestedWeight, 0);
  if (diff !== 0) {
    rows.sort((a, b) => b.suggestedWeight - a.suggestedWeight);
    rows[0].suggestedWeight += diff;
    rows[0].delta = rows[0].suggestedWeight - rows[0].currentWeight;
    rows.sort((a, b) => dims.findIndex((d) => d.id === a.id) - dims.findIndex((d) => d.id === b.id));
  }

  // ── 置信度 ──
  const confidence = stat.applied >= 20 && stat.positive >= 5
    ? '中'
    : '低';

  // ── 结论文字 ──
  const up = rows.filter((r) => r.delta >= 3 && !r.lowDemand).sort((a, b) => b.delta - a.delta);
  const down = rows.filter((r) => r.delta <= -3).sort((a, b) => a.delta - b.delta);

  const findings = [];
  for (const r of up.slice(0, 2)) {
    findings.push(
      `「${r.name}」在进面的岗位里平均得分 ${pct(r.avgPositive)}，没进面的只有 ${pct(r.avgNegative)} —— `
      + `建议权重 ${r.currentWeight} → ${r.suggestedWeight}（+${r.delta}）`
    );
  }
  for (const r of down.slice(0, 2)) {
    findings.push(
      `「${r.name}」两组差别不大（${pct(r.avgPositive)} vs ${pct(r.avgNegative)}），`
      + `当前权重 ${r.currentWeight} 偏高 —— 建议降到 ${r.suggestedWeight}（${r.delta}）`
    );
  }
  if (!findings.length) {
    findings.push('各维度在两组间差别不明显，当前权重暂时不用改。');
  }

  return {
    ...base,
    sufficient: true,
    confidence,
    dimensions: rows.map((r) => ({
      id: r.id,
      name: r.name,
      currentWeight: r.currentWeight,
      suggestedWeight: r.suggestedWeight,
      delta: r.delta,
      lift: r.lift,
      avgPositive: r.avgPositive,
      avgNegative: r.avgNegative,
      nPositive: r.nPositive,
      nNegative: r.nNegative,
      lowDemand: r.lowDemand,
    })),
    findings,
    caveat: '这是启发式推断，不是因果结论。样本 ' + stat.applied + ' 个、置信度「' + confidence + '」，'
      + '建议先应用，之后每投一批再回来重新校准。',
  };
}

/** 当前生效权重（可能是校准过的） */
export function currentWeightOf(profile, dim) {
  const w = profile.weights?.[dim.id];
  return Number.isFinite(w) ? Number(w) : Number(dim.weight) || 0;
}

function pct(v) {
  return Math.round((Number(v) || 0) * 100) + '%';
}
