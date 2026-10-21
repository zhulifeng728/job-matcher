/**
 * level.js —— 职级策略与谈薪评估
 *
 * 竞品 Career-Ops 把这块叫「职级策略 + 薪酬调研 + 谈薪脚本」，是三块独立模块。
 * 这里用规则实现同样的判断，不依赖 AI：
 *
 *   1. 职级定位：这个岗位对你是「上浮 / 平级 / 降级」
 *   2. 薪资判断：JD 区间 vs 你的定位，是否值得谈、能谈多少
 *   3. 谈判要点：按定位给出具体话术方向
 *
 * 关键洞察：求职失败很多时候不是能力不够，是「定位错位」——
 *   8 年经验去投 4-6 年的岗位，对方会怕你待不住（overqualified）；
 *   5 年经验去投 10 年+ 的岗位，简历筛选就过不去。
 * 所以先判断这件事，比改简历更省时间。
 */

/** 从文本里解析薪资区间（单位：K/月） */
export function parseSalary(text) {
  if (!text) return null;
  const s = String(text);

  // 45-65K·15薪 / 30k-50k / 4.5-6.5万 / 45~65K
  // 单位可能出现在区间末尾（45-65K），也可能紧跟每个数字（30k-50k）
  const range = s.match(
    /(\d{1,3}(?:\.\d)?)\s*([kK千万元])?\s*[-–~到至]\s*(\d{1,3}(?:\.\d)?)\s*([kK千万元])?/
  );
  if (!range) {
    // 单个数字：50K
    const single = s.match(/(\d{1,3}(?:\.\d)?)\s*([kK千万])/);
    if (single) {
      const v = toK(Number(single[1]), single[2]);
      return v ? { min: v, max: v, months: detectMonths(s), raw: text } : null;
    }
    return null;
  }

  // 单位优先级：数字后紧跟的 > 区间末尾的 > 文本里的「万」> 默认 K
  const tailUnit = range[4] || '';
  const headUnit = range[2] || '';
  const fallback = s.includes('万') ? '万' : 'K';

  const minUnit = headUnit || tailUnit || fallback;
  const maxUnit = tailUnit || headUnit || fallback;

  const min = toK(Number(range[1]), minUnit);
  const max = toK(Number(range[3]), maxUnit);
  if (!min || !max || min <= 0 || max < min) return null;

  return {
    min: Math.round(min),
    max: Math.round(max),
    months: detectMonths(s),
    raw: String(text).trim(),
  };
}

function toK(n, unit) {
  if (!Number.isFinite(n)) return null;
  if (unit === '万') return n * 10;      // 5万 → 50K
  if (unit === '元') return n / 1000;
  return n;                              // K / 千
}

/** 识别「15薪」这类 */
function detectMonths(s) {
  const m = String(s).match(/(\d{2})\s*薪/);
  return m ? Number(m[1]) : 12;
}

/**
 * 职级定位
 *
 * 用「年限差」判断。行业经验上：
 *   岗位要求年限 < 你 - 2  → 降级（对方会怕你待不住）
 *   岗位要求年限 ≈ 你      → 平级
 *   岗位要求年限 > 你 + 1  → 上浮（简历筛选可能过不去）
 */
export function analyzeLevel(profile, job) {
  const myYears = Number(profile?.profile?.years) || 0;
  const req = parseRequiredYears(job?.text || job?.experience || '');
  const pos = String(job?.position || '');

  // 岗位名里带「负责人/主管/经理/总监/架构师」→ 管理或架构序列
  const isLead = /负责人|主管|经理|总监|架构师|tech\s*lead|head|lead/i.test(pos);
  const isJunior = /实习|应届|初级|助理|junior|intern/i.test(pos);

  if (!req && !isLead && !isJunior) {
    return {
      positioning: '未知',
      reason: 'JD 没写明年限要求，也没从岗位名判断出序列。',
      strategy: '面试时直接问「这个岗位期望的年限和职级是什么」，比猜更有效。',
      myYears,
      requiredYears: 0,
      gap: 0,
    };
  }

  const gap = req ? myYears - req : 0;
  let positioning = '平级';
  let reason = '';
  let strategy = '';

  if (isJunior && myYears >= 5) {
    positioning = '降级';
    reason = `岗位名带「${pos.match(/实习|应届|初级|助理|junior|intern/i)?.[0]}」，你的 ${myYears} 年经验明显超出。`;
    strategy = '除非你想换赛道或图稳定，否则不建议投。如果投，重点说明「我要的是稳定和成长空间，不是职级」，'
      + '并准备好回答「为什么愿意降级」。';
  } else if (gap >= 3) {
    positioning = '降级';
    reason = `岗位要求 ${req} 年以上，你 ${myYears} 年，高出 ${gap} 年。`;
    strategy = '对方会担心两件事：薪资给不到位、你待不住。简历里把「团队管理/架构决策」的权重降低，'
      + '突出「独立交付复杂项目」；面试时主动解释换工作的动机是「方向匹配」而不是「想涨薪」。';
  } else if (gap <= -2) {
    positioning = '上浮';
    reason = `岗位要求 ${req} 年以上，你 ${myYears} 年，差 ${-gap} 年。`;
    strategy = '简历筛选可能被卡。补救方式：把能证明「达到该级别能力」的事迹提前，'
      + '用「我负责过什么」代替「我工作几年」；有机会的话走内推，绕过年限硬筛。';
  } else if (isLead && myYears < 8) {
    positioning = '上浮';
    reason = `岗位是「${pos.slice(0, 12)}」这类带团队的序列，你 ${myYears} 年、无明确管理经历时属于上浮。`;
    strategy = '即使没管过人，也要写「带过几个人 / 主导过几人协作的项目 / 做过技术方案评审」。'
      + '管理经验不是只有 title，协调和决策也算。';
  } else {
    positioning = '平级';
    reason = req
      ? `岗位要求 ${req} 年以上，你 ${myYears} 年，落在这个岗位的正常区间内。`
      : `岗位是「${pos.slice(0, 12)}」序列，与你 ${myYears} 年经验基本匹配。`;
    strategy = '这是最舒服的区间。重点放在「为什么是你」——把与该岗位最贴的项目讲透，'
      + '别把简历写成能力清单。';
  }

  return {
    positioning,
    reason,
    strategy,
    myYears,
    requiredYears: req,
    gap,
    isLead,
    isJunior,
  };
}

/** 从 JD 文本解析年限要求 */
export function parseRequiredYears(text) {
  const s = String(text || '');

  // 8-12年 / 8年以上 / 3~5年
  const range = s.match(/(\d{1,2})\s*[-–~到至]\s*(\d{1,2})\s*年/);
  if (range) return Number(range[1]);

  const above = s.match(/(\d{1,2})\s*年(?:以上|\+|及以上)/);
  if (above) return Number(above[1]);

  const plain = s.match(/(?:经验|工作|从业)[^\d]{0,6}(\d{1,2})\s*年/);
  if (plain) return Number(plain[1]);

  const loose = s.match(/(\d{1,2})\s*年/);
  if (loose) {
    const n = Number(loose[1]);
    if (n >= 1 && n <= 30) return n;
  }
  return 0;
}

/**
 * 薪资评估
 */
export function analyzeSalary(profile, job, level) {
  const jd = parseSalary(job?.salary) || parseSalary(job?.text);
  if (!jd) {
    return {
      hasData: false,
      note: '这个岗位没写薪资区间。可以在面试前问 HR「这个岗位的预算区间是多少」，'
        + '比猜要准，也比后面谈崩强。',
    };
  }

  const monthly = Math.round((jd.min + jd.max) / 2);
  const annual = monthly * (jd.months || 12);

  // 用年限粗估市场分位（只做方向判断，不给虚假精确度）
  const myYears = Number(profile?.profile?.years) || 0;
  let band = '中位';
  if (myYears >= 8) band = '偏资深';
  else if (myYears <= 3) band = '偏初级';

  const width = jd.max - jd.min;
  const wide = width >= 15;   // 区间宽说明预算弹性大

  const tips = [];

  if (level?.positioning === '降级') {
    tips.push('你在降级投。对方预算通常是按「要求年限」定的，你大概率拿不到区间上限 —— '
      + '别把「拿上限」当目标，先把「为什么愿意来」讲清楚。');
    tips.push('如果确实想要这个机会，可以主动说「薪资可以谈，我更看重方向」，但要留一个底线。');
  } else if (level?.positioning === '上浮') {
    tips.push('你在上浮投。对方会怀疑「你够不够这个级别」，反而可能给区间下限。'
      + '策略是弱化年限、强化「我做过同级别的事」。');
    tips.push('谈的时候用「我能解决什么问题」换「我值多少」，而不是用工作年限换。');
  } else {
    tips.push('平级投，是最容易谈到区间上半段的位置。准备 1-2 个可量化的成果，用来支撑「为什么给到中高位」。');
  }

  if (wide) {
    tips.push(`区间跨度 ${width}K，说明预算弹性大 —— 谈的时候直接报你想要的数，别先自降。`);
  }

  if (jd.months && jd.months >= 14) {
    tips.push(`这个岗位是 ${jd.months} 薪，年包比月薪看起来高。谈的时候统一按年包比，`
      + '不然容易被「月薪低 + 多几个月」绕进去。');
  }

  tips.push('拿到 offer 前不要透露当前薪资明细，只说「期望区间」和「当前年包大致范围」。');

  return {
    hasData: true,
    range: `${jd.min}-${jd.max}K`,
    months: jd.months,
    monthlyMid: monthly,
    annualWan: Number((annual / 10).toFixed(1)),
    band,
    wide,
    tips,
    raw: jd.raw,
  };
}

/** 合并成一个接口返回 */
export function buildStrategy(profile, job) {
  const level = analyzeLevel(profile, job);
  const salary = analyzeSalary(profile, job, level);
  return { level, salary };
}
