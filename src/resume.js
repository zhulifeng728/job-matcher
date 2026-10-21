/**
 * resume.js —— 简历文本 → 能力画像
 *
 * 这是整个产品的起点：用户导入自己的简历，我们把简历拆成
 * 「可被 JD 匹配的结构化要点」，评分与简历优化都基于它。
 *
 * 不依赖 AI，纯规则：
 *   1. 按常见章节标题切段（工作经历 / 项目经验 / 专业技能 / 教育）
 *   2. 从段落里抽条目（- • · 1. 1、 这类列表行）
 *   3. 用能力维度的关键词表给每条打标签（判断它属于哪个维度、涉及哪些技术点）
 *   4. 解析工作年限、姓名、城市
 */

/** 章节标题关键词 */
const SECTION_PATTERNS = [
  { key: 'summary', re: /^(个人优势|个人简介|自我评价|个人总结|概述|简介|职业概述|Summary|Profile|About)$/i },
  { key: 'skills', re: /^(专业技能|技能特长|技术栈|技能清单|技术能力|Skills|Tech Stack|Technologies)$/i },
  { key: 'work', re: /^(工作经历|工作经验|职业经历|履历|Work Experience|Experience|Employment)$/i },
  { key: 'project', re: /^(项目经历|项目经验|主要项目|代表项目|Projects|Project Experience)$/i },
  { key: 'edu', re: /^(教育经历|教育背景|学历|Education)$/i },
  { key: 'other', re: /^(证书|荣誉|获奖|培训|语言|Certificates|Awards|Languages)$/i },
];

/** 列表行前缀 */
const BULLET_RE = /^\s*(?:[-–—•·▪◦*]|\d{1,2}[.、)）]|[（(]\d{1,2}[)）])\s+/;

/** 判断是不是章节标题行 */
function matchSection(line) {
  const t = line.trim().replace(/[：:]\s*$/, '').replace(/^[一二三四五六七八九十\d.\s、]+/, '');
  if (!t || t.length > 24) return null;
  for (const p of SECTION_PATTERNS) {
    if (p.re.test(t)) return p.key;
  }
  return null;
}

/** 清理行内多余空白 */
function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * 解析简历纯文本
 * @param {string} raw
 * @returns {{ name, city, years, sections, highlights, skillsText }}
 */
export function parseResume(raw) {
  const text = String(raw || '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');

  const sections = { summary: [], skills: [], work: [], project: [], edu: [], other: [], head: [] };
  let cur = 'head';

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    const sec = matchSection(t);
    if (sec) { cur = sec; continue; }
    sections[cur].push(t);
  }

  // ── 姓名：优先「姓名：xxx」，否则取开头第一个像人名的短行 ──
  let name = '';
  const nameLabel = text.match(/(?:姓\s*名|Name)\s*[:：]\s*([^\s\n|，,]{2,20})/i);
  if (nameLabel) name = nameLabel[1];

  if (!name) {
    for (const l of sections.head.slice(0, 5)) {
      const t = clean(l);
      // 2-4 个中文字，不含职位/标签类词
      if (/^[\u4e00-\u9fa5]{2,4}$/.test(t) && !/简历|前端|后端|开发|工程师|手机|邮箱/.test(t)) {
        name = t;
        break;
      }
    }
  }

  // ── 城市 ──
  const CITIES = ['北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安',
    '苏州', '天津', '重庆', '长沙', '郑州', '青岛', '合肥', '宁波', '厦门', '福州',
    '济南', '大连', '沈阳', '无锡', '东莞', '佛山', '珠海', '远程'];
  let city = '';
  const cityLabel = text.match(/(?:所在城市|期望城市|城市|现居|City)\s*[:：]\s*([^\s\n|，,]{2,8})/);
  if (cityLabel) {
    city = CITIES.find((c) => cityLabel[1].includes(c)) || clean(cityLabel[1]).slice(0, 8);
  } else {
    for (const l of sections.head.slice(0, 8)) {
      const hit = CITIES.find((c) => l.includes(c));
      if (hit) { city = hit; break; }
    }
  }

  // ── 工作年限（优先显式声明，其次只用工作经历的年份，不拿教育经历算）──
  const years = detectYears(text, sections.work.join('\n'));

  // ── 抽条目 ──
  const bullets = [];

  // 优先从工作/项目段抽带列表前缀的行
  for (const key of ['work', 'project']) {
    let currentOrg = '';
    for (const line of sections[key]) {
      const t = line.trim();
      if (BULLET_RE.test(t)) {
        const body = clean(t.replace(BULLET_RE, ''));
        if (body.length >= 8) bullets.push({ text: body, from: key, org: currentOrg });
      } else if (t.length <= 40 && /\d{4}|公司|集团|科技|有限|Inc|Ltd|Co\./i.test(t)) {
        // 像「2019.07 - 2022.03 某公司 | 职位」这类行，记为组织信息
        currentOrg = clean(t);
      }
    }
  }

  // 技能段：按行/分号拆成技能条目
  const skillsText = sections.skills.join(' ');
  const skillItems = skillsText
    .split(/[\n；;、,，|/]+/)
    .map((s) => clean(s.replace(BULLET_RE, '')))
    .filter((s) => s.length >= 2 && s.length <= 30);

  // 个人优势段也可作为一条要点
  const summaryText = clean(sections.summary.join(' '));

  return {
    name: name || '',
    city,
    years,
    sections,
    bullets,
    skillItems,
    summaryText,
    skillsText,
    rawText: text,
  };
}

/**
 * 从简历里推断工作年限
 * @param {string} text 全文
 * @param {string} workText 仅工作经历段的文本（避免把教育经历年份算进去）
 */
function detectYears(text, workText) {
  // 1) 显式写明：「6 年经验」「6 年前端开发经验」「5 年以上工作经验」
  const explicit = text.match(/(\d{1,2})\s*年(?:以上)?[\u4e00-\u9fa5]{0,8}?经验/);
  if (explicit) {
    const n = Number(explicit[1]);
    if (n > 0 && n < 45) return n;
  }

  // 2) 从工作经历的时间区间推算（取最早年份到今天）
  const scope = workText && workText.trim() ? workText : text;
  const yearsFound = [...scope.matchAll(/(19|20)\d{2}/g)].map((m) => Number(m[0]));
  if (yearsFound.length) {
    const earliest = Math.min(...yearsFound);
    const now = new Date().getFullYear();
    const span = now - earliest;
    // 工作经历里出现的最早年份才可信；超过 45 年说明抓到了出生年份之类
    if (span > 0 && span < 45) return span;
  }

  return 0;
}

/**
 * 把简历解析结果转换成能力画像
 *
 * @param {object} parsed parseResume 的结果
 * @param {object} template 画像模板（提供 dimensions / domains / negatives / grades）
 * @returns 完整 profile 对象
 */
export function buildProfileFromResume(parsed, template) {
  const dims = template.dimensions || [];
  const allText = parsed.rawText.toLowerCase();

  // ── 1. 生成 highlights ──
  // 每条：文本 + 所属维度 + 命中关键词
  const highlights = [];
  let seq = 0;

  const pushHighlight = (text, extraKeywords = []) => {
    const t = clean(text);
    if (t.length < 8 || t.length > 200) return;
    // 去重
    if (highlights.some((h) => h.text === t)) return;

    const lower = t.toLowerCase();
    const hitDims = [];
    const hitKeywords = new Set(extraKeywords);

    for (const dim of dims) {
      let dimHits = 0;
      for (const kw of Object.keys(dim.keywords || {})) {
        if (kw.length < 2) continue;
        if (lower.includes(String(kw).toLowerCase())) {
          hitKeywords.add(kw);
          dimHits++;
        }
      }
      if (dimHits > 0) hitDims.push(dim.id);
    }

    highlights.push({
      id: 'h' + String(++seq).padStart(2, '0'),
      dims: hitDims.length ? hitDims : ['frontend_arch'],
      keywords: [...hitKeywords].slice(0, 10),
      text: t,
      source: 'resume',
    });
  };

  for (const b of parsed.bullets) pushHighlight(b.text);
  // 条目太少时，补充个人优势/技能里的长句
  if (highlights.length < 5) {
    if (parsed.summaryText) {
      parsed.summaryText.split(/[。；;]/).forEach((s) => pushHighlight(s));
    }
    for (const s of parsed.skillItems.slice(0, 10)) pushHighlight(s);
  }

  // ── 2. 技能段里出现的关键词，补充到「技能关键词」集合 ──
  const skillKeywordHit = new Set();
  for (const dim of dims) {
    for (const kw of Object.keys(dim.keywords || {})) {
      if (kw.length >= 2 && allText.includes(String(kw).toLowerCase())) skillKeywordHit.add(kw);
    }
  }

  // ── 3. 组装 profile ──
  const name = parsed.name || '我';
  const years = parsed.years || 0;
  const headline = buildHeadline(parsed, skillKeywordHit);

  return {
    profile: {
      name,
      headline,
      years,
      currentCity: parsed.city || '',
      education: detectEducation(parsed.rawText),
      intent: [],
    },
    grades: template.grades || { S: 88, A: 75, B: 58, C: 40 },
    dimensions: dims,
    domains: template.domains || [],
    pluses: template.pluses || [],
    negatives: template.negatives || [],
    highlights,
    resumeText: parsed.rawText.slice(0, 6000),
    meta: {
      source: 'imported-resume',
      importedAt: new Date().toISOString(),
      bulletCount: parsed.bullets.length,
      highlightCount: highlights.length,
      detectedKeywords: skillKeywordHit.size,
      hasSections: Object.entries(parsed.sections)
        .filter(([k, v]) => v.length > 0 && k !== 'head')
        .map(([k]) => k),
    },
  };
}

/** 拼一句定位：从简历里挑一个最像的岗位名 */
function buildHeadline(parsed, keywords) {
  const TITLES = [
    '前端负责人', '前端架构师', '高级前端工程师', '前端开发工程师',
    '全栈工程师', '小程序开发工程师', 'AI 应用工程师', '产品经理', '后端工程师',
  ];
  const text = parsed.rawText;
  const found = TITLES.find((t) => text.includes(t));
  const years = parsed.years;
  const head = found || '前端开发工程师';
  return years > 0 ? `${years} 年经验 · ${head}` : head;
}

function detectEducation(text) {
  const m = text.match(/(博士|硕士|本科|大专|专科)/);
  return m ? m[1] : '';
}

/** 生成一份导入结果的摘要，用于导入后展示给用户确认 */
export function summarizeImport(profile) {
  const dims = {};
  for (const h of profile.highlights || []) {
    for (const d of h.dims || []) dims[d] = (dims[d] || 0) + 1;
  }
  const dimNames = Object.fromEntries(
    (profile.dimensions || []).map((d) => [d.id, d.name])
  );

  return {
    name: profile.profile.name,
    years: profile.profile.years,
    headline: profile.profile.headline,
    city: profile.profile.currentCity,
    highlightCount: (profile.highlights || []).length,
    dimensions: Object.entries(dims)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => ({ id, name: dimNames[id] || id, count: n })),
    warnings: buildWarnings(profile),
  };
}

/** 导入质量提示 */
function buildWarnings(profile) {
  const w = [];
  if (!profile.profile.years) w.push('没识别到工作年限，评分里的年限校验会失效，可以手动补充。');
  if (profile.profile.currentCity === '') w.push('没识别到城市，岗位的地域匹配不会参与判断。');
  const n = (profile.highlights || []).length;
  if (n < 5) w.push(`只抽到 ${n} 条简历要点，建议用「- 」开头的列表行描述工作内容，抽取效果更好。`);
  const dimCount = new Set((profile.highlights || []).flatMap((h) => h.dims || [])).size;
  if (dimCount <= 1) w.push('简历要点集中在单一能力维度，可能是关键词覆盖不足，建议补充技术细节。');
  return w;
}
