/**
 * generate.js —— 定制简历生成
 *
 * 这是产品真正该交付的东西：一份能直接投出去的简历，不是一堆建议。
 *
 * 设计依据（来自 ATS 研究，见 docs/COMPETITORS.md）：
 *   1. 覆盖率 > 密度。密度只做烟雾报警器：0 次=漏了，10+ 次=啰嗦
 *   2. 关键词要「claim + proof」：技能区声明，经历区给证据
 *   3. 关键词位置有讲究：求职意向 → 核心优势 → 专业技能 → 工作经历
 *   4. ATS 友好格式：单列、无表格、标准标题、日期一致
 *
 * 一条铁律：**不编造**。JD 要求但简历里没有证据的关键词，
 * 绝不写进简历正文，只列进「需补齐」清单。
 */

/** JD 关键词的类别 */
const KW_CATEGORY = {
  tool: '工具/技术',
  method: '方法/流程',
  domain: '领域/业务',
  duty: '职责/交付',
};

/** 常见技术词库（用于从 JD 里识别硬技能） */
const TECH_TERMS = [
  'Vue', 'Vue2', 'Vue3', 'React', 'Angular', 'Svelte', 'Next.js', 'Nuxt',
  'TypeScript', 'JavaScript', 'ES6', 'Node.js', 'Deno', 'Bun',
  'Webpack', 'Vite', 'Rollup', 'esbuild', 'Babel', 'Turbopack',
  'Taro', 'uni-app', '小程序', 'Electron', 'Flutter', 'React Native',
  'Pinia', 'Vuex', 'Redux', 'Zustand', 'MobX',
  'Element Plus', 'Ant Design', 'ECharts', 'AntV', 'G6', 'D3',
  'qiankun', 'Module Federation', '微前端', 'Monorepo', 'pnpm', 'Lerna', 'Nx', 'Turborepo',
  'Docker', 'Kubernetes', 'Nginx', 'CI/CD', 'Jenkins', 'GitLab CI', 'GitHub Actions',
  'MySQL', 'PostgreSQL', 'Redis', 'MongoDB', 'Elasticsearch',
  'Express', 'NestJS', 'Koa', 'Spring Boot', 'Java', 'Python', 'Go',
  'SSE', 'WebSocket', 'GraphQL', 'REST', 'gRPC',
  'WebGL', 'Canvas', 'SVG', 'Three.js',
  'Jest', 'Vitest', 'Playwright', 'Cypress', 'TDD',
  'Sentry', '埋点', '性能优化', '首屏', 'LCP', 'INP',
  'AI', '大模型', 'LLM', 'RAG', 'Agent', 'MCP', 'Prompt', 'Function Calling', '向量',
  'WebLLM', 'Ollama', 'LangChain',
  'SSR', 'CSR', '同构渲染', '微服务', 'BFF', '中台',
  'WebAssembly', 'PWA', 'Service Worker', 'Web Worker',
  'Git', 'Figma', '设计系统', '组件库', 'A11y', 'WCAG',
];

/** 方法/流程类 */
const METHOD_TERMS = [
  '架构设计', '架构演进', '模块化', '解耦', '重构', '技术选型', '性能优化',
  '构建优化', '工程化', '代码规范', 'Code Review', '单元测试', '自动化测试',
  '灰度发布', '回滚', '监控告警', '稳定性治理', '需求评审', '技术方案',
  '敏捷开发', 'Scrum', '项目管理', '排期', '跨团队协作', '团队管理',
  '带团队', '招聘', '培养', '技术分享', '文档沉淀', '标准化',
];

/** 领域/业务类 */
const DOMAIN_TERMS = [
  '数据安全', '合规', '金融', '银行', '保险', '证券', '风控', '支付',
  '电商', '在线教育', '教育', '医疗', 'SaaS', 'PaaS', 'B端', 'C端',
  '中后台', '管理后台', '数据可视化', '大屏', '报表', '数据中台',
  '企业服务', '政务', '信创', '国企', 'ToB', 'ToC', '出海',
  '内容社区', '直播', '短视频', '社交', '游戏', '物流', '供应链',
];

/** 职责/交付类动词短语 */
const DUTY_TERMS = [
  '技术方案', '系统设计', '架构评审', '技术攻坚', '疑难问题', '性能瓶颈',
  '交付效率', '研发效率', '需求落地', '业务增长', '用户体验',
  '技术规划', '团队建设', '人才培养', '技术影响力',
];

/**
 * 从 JD 提关键词，并判断优先级
 *
 * 优先级规则（越靠前越重要）：
 *   1. 出现在「任职要求 / Requirements / 岗位要求」段落里的
 *   2. JD 里重复出现的
 *   3. 出现在「岗位职责 / Responsibilities」里的
 */
export function extractKeywords(jdText) {
  const text = String(jdText || '');
  const lower = text.toLowerCase();

  // 切出「要求」段和「职责」段，用于提权
  const reqBlock = sliceSection(text, [
    /任职要求|任职资格|岗位要求|职位要求|我们希望你|你需要|requirements?|qualifications?/i,
  ]);
  const dutyBlock = sliceSection(text, [/岗位职责|工作职责|职位描述|工作内容|你将负责|responsibilit/i]);

  const found = new Map();

  const scan = (list, category, baseWeight) => {
    for (const term of list) {
      const t = term.toLowerCase();
      if (t.length < 2) continue;
      const count = countOccurrences(lower, t);
      if (!count) continue;

      let weight = baseWeight + Math.min(count, 5) * 2;
      if (reqBlock && reqBlock.toLowerCase().includes(t)) weight += 14;
      if (dutyBlock && dutyBlock.toLowerCase().includes(t)) weight += 6;

      // 已在表里的取更高权重
      const prev = found.get(term);
      if (prev) prev.weight = Math.max(prev.weight, weight);
      else found.set(term, { term, category, weight, count });
    }
  };

  scan(TECH_TERMS, 'tool', 10);
  scan(METHOD_TERMS, 'method', 8);
  scan(DOMAIN_TERMS, 'domain', 7);
  scan(DUTY_TERMS, 'duty', 6);

  const all = [...found.values()].sort((a, b) => b.weight - a.weight);

  // must-have：权重前 15，且出现在要求段或重复出现
  const mustHave = all.filter((k) => k.weight >= 24).slice(0, 15);
  const niceToHave = all.filter((k) => k.weight < 24).slice(0, 20);

  return {
    mustHave,
    niceToHave,
    all,
    categories: KW_CATEGORY,
    top15: all.slice(0, 15),
  };
}

function countOccurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

/** 按标题正则切出段落 */
function sliceSection(text, patterns) {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (patterns.some((re) => re.test(lines[i]))) { start = i; break; }
  }
  if (start < 0) return '';

  // 到下一个章节标题为止
  const HEADING = /^\s*(?:\d+[.、]|#|【)?\s*(岗位职责|工作职责|任职要求|任职资格|职位要求|岗位要求|工作内容|福利|薪资|工作地点|公司介绍|我们提供|你将负责|Responsibilities|Requirements|Qualifications|Benefits|About)/i;
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (i > start && HEADING.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * 给关键词定位：在简历里的「声明」和「证据」
 *
 * claim：技能区能声明（用户的技能关键词里有）
 * proof：某条经历要点里出现过（有证据）
 */
export function placeKeywords(keywords, profile) {
  const highlights = profile.highlights || [];
  // 三处都要查：技能关键词、要点正文、简历原文
  // （只看 highlight.keywords 会漏掉 Taro / ECharts / Docker 这类没被打上标签的）
  const skillText = collectSkillText(profile);
  const resumeText = String(profile.resumeText || '').toLowerCase();

  return keywords.map((k) => {
    const t = k.term.toLowerCase();
    const inSkills = skillText.toLowerCase().includes(t) || resumeText.includes(t);
    const proofIn = highlights.filter((h) => String(h.text || '').toLowerCase().includes(t));

    return {
      ...k,
      claimedInSkills: inSkills,
      proofCount: proofIn.length,
      proofBullets: proofIn.slice(0, 2).map((h) => h.text),
      // 真实拥有的判定：技能区有 或 经历里有证据
      owned: inSkills || proofIn.length > 0,
      // 只在经历里出现过、技能区没写 → 可以补进技能区
      canClaim: inSkills || proofIn.length > 0,
    };
  });
}

/** 收集画像里的技能文本 */
function collectSkillText(profile) {
  const parts = [];
  for (const h of profile.highlights || []) {
    for (const kw of h.keywords || []) parts.push(kw);
  }
  return parts.join(' ');
}

/**
 * 生成简历
 * @returns {{ markdown, coverage, matrix, density, checks, gaps }}
 */
export function generateResume(profile, job, tailored) {
  const p = profile.profile || {};
  const jdKeywords = extractKeywords(job.text || job.position || '');
  const placed = placeKeywords(jdKeywords.all.slice(0, 40), profile);

  const owned = placed.filter((k) => k.owned);

  // 用户已确认「学会了」的技能，不再算缺口
  const learnedSet = new Set(
    (profile.skillsExtra || []).map((s) => String(s.term || s).toLowerCase())
  );

  const missing = jdKeywords.mustHave.filter((k) => {
    if (learnedSet.has(k.term.toLowerCase())) return false;
    return !placed.find((x) => x.term === k.term && x.owned);
  });

  // ── 覆盖率：must-have 里有多少是真的有的 ──
  const mh = jdKeywords.mustHave;
  const mhOwned = mh.filter((k) =>
    learnedSet.has(k.term.toLowerCase()) || placed.find((x) => x.term === k.term && x.owned)
  );
  const coverage = mh.length ? Math.round((mhOwned.length / mh.length) * 100) : 0;

  // ── 选要点：按与 JD 的相关度排序 ──
  const scoredBullets = rankBullets(profile, job, tailored, owned);

  // ── 组装 Markdown ──
  const md = [];
  const name = p.name || '姓名';
  const years = p.years || 0;

  // 抬头
  md.push('# ' + name);
  const headlineBits = [
    job.position ? '求职意向：' + job.position : '',
    years ? years + ' 年经验' : '',
    p.currentCity || '',
    p.education || '',
  ].filter(Boolean);
  md.push('', headlineBits.join(' ｜ '), '');

  // 核心优势：把 must-have 里 owned 的塞进 3-5 句
  md.push('## 核心优势', '');
  const summaryLines = buildSummary(profile, job, owned, scoredBullets);
  for (const line of summaryLines) md.push('- ' + line);
  md.push('');

  // 专业技能：分组，只写真实拥有的
  md.push('## 专业技能', '');
  const skillGroups = groupSkills(owned, jdKeywords, profile);
  for (const g of skillGroups) {
    md.push('- **' + g.name + '**：' + g.items.join('、'));
  }
  if (!skillGroups.length) {
    md.push('- （待补充：从你的简历里没识别到明确的技术关键词）');
  }
  md.push('');

  // 工作经历：只用 work 段的要点
  const workBullets = scoredBullets.all.filter((b) => b.from !== 'project');
  md.push('## 工作经历', '');
  md.push(...renderExperience(profile, workBullets));
  md.push('');

  // 项目经历
  // 摘要里已经引用过的要点，不在项目区重复
  const summaryUsed = new Set(summaryLines.map((l) => l.replace(/[。；;]$/, '')));
  const projectBullets = scoredBullets.all.filter((b) =>
    b.from === 'project' && !summaryUsed.has(String(b.text || '').replace(/[。；;]$/, ''))
  );
  const usedTexts = new Set([
    ...workBullets.map((b) => String(b.text || '')),
    ...summaryUsed,
  ]);
  const projects = pickProjects(profile, job, usedTexts, projectBullets);
  if (projects.length) {
    md.push('## 项目经历', '');
    for (const pr of projects) {
      md.push('### ' + pr.title, '');
      md.push('- ' + pr.text);
      if (pr.keywords.length) md.push('- 技术栈：' + pr.keywords.slice(0, 8).join(' / '));
      md.push('');
    }
  }

  // 教育
  const eduLine = p.educationLine || p.education;
  if (eduLine) {
    md.push('## 教育经历', '', '- ' + eduLine, '');
  }

  const markdown = md.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

  // ── 关键词检查（烟雾报警器） ──
  const density = checkDensity(markdown, jdKeywords.mustHave);

  // ── ATS 格式检查 ──
  const checks = atsChecks(markdown);

  // ── 位置矩阵 ──
  const matrix = mh.map((k) => {
    const x = placed.find((y) => y.term === k.term) || {};
    return {
      term: k.term,
      category: KW_CATEGORY[k.category] || k.category,
      inIntent: String(job.position || '').toLowerCase().includes(k.term.toLowerCase()),
      inSummary: summaryLines.join(' ').toLowerCase().includes(k.term.toLowerCase()),
      inSkills: Boolean(x.claimedInSkills),
      inExperience: Boolean(x.proofCount),
      proofCount: x.proofCount || 0,
      owned: Boolean(x.owned) || learnedSet.has(k.term.toLowerCase()),
      learned: learnedSet.has(k.term.toLowerCase()),
    };
  });

  return {
    markdown,
    coverage,
    mustHaveTotal: mh.length,
    mustHaveOwned: mhOwned.length,
    matrix,
    density,
    checks,
    gaps: missing.map((k) => ({ term: k.term, category: KW_CATEGORY[k.category] || k.category })),
    skillGroups,
    bulletCount: scoredBullets.all.length,
  };
}

/** 摘要：3-5 句，含 must-have 关键词，但不堆砌 */
function buildSummary(profile, job, owned, bullets) {
  const p = profile.profile || {};
  const years = p.years || 0;
  const lines = [];

  // 第 1 句：定位 + 年限 + 与岗位匹配的核心方向
  const topOwned = owned.filter((k) => k.category === 'tool').slice(0, 3).map((k) => k.term);
  const methodOwned = owned.filter((k) => k.category === 'method').slice(0, 2).map((k) => k.term);

  lines.push(
    (years ? years + ' 年' : '') + '前端开发经验'
    + (topOwned.length ? '，主力技术栈 ' + topOwned.join(' / ') : '')
    + (methodOwned.length ? '，擅长' + methodOwned.join('、') : '')
    + '。'
  );

  // 第 2 句：最贴岗位的一段经历
  const best = bullets.strong[0];
  if (best) {
    lines.push(best.text.replace(/^[-•·\s]+/, '').replace(/[。；;]$/, '') + '。');
  }

  // 第 3 句：对目标岗位的定位
  const domainOwned = owned.filter((k) => k.category === 'domain').slice(0, 2).map((k) => k.term);
  if (domainOwned.length) {
    lines.push('有 ' + domainOwned.join('、') + ' 方向的业务经验，能直接对接业务需求。');
  }

  return lines.slice(0, 4);
}

/**
 * 技能分组
 *
 * 不只是「JD 提到且我有」——那样技能区会很寒酸（实测只有 6 个）。
 * 正确做法：JD 相关的优先，再补上用户自己技术栈里的其他词，
 * 这样既命中 ATS 搜索，又是一份完整的技能列表。
 */
function groupSkills(owned, jdKeywords, profile) {
  const order = { tool: 1, method: 2, domain: 3, duty: 4 };
  const groups = {};
  const seen = new Set();

  const push = (cat, term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    groups[cat] = groups[cat] || [];
    groups[cat].push(term);
  };

  // 第一优先：JD 提到、简历里也确实有的
  for (const k of owned) push(k.category || 'tool', k.term);

  // 第二优先：简历原文里出现的其他技术词（补全技能区）
  const resumeText = String(profile?.resumeText || '').toLowerCase();
  const extraTech = TECH_TERMS.filter((term) => {
    const lower = term.toLowerCase();
    if (seen.has(lower)) return false;
    return resumeText.includes(lower);
  });

  // 用户自己确认「学会了」的技能（从学习计划里加进来的）
  for (const s of profile.skillsExtra || []) {
    const term = String(s.term || s).trim();
    if (term) push(classifyExtra(term), term);
  }

  for (const term of extraTech) push('tool', term);

  // 方法/领域类也从简历里补
  const extraMethod = METHOD_TERMS.filter((term) => resumeText.includes(term.toLowerCase()) && !seen.has(term.toLowerCase()));
  for (const term of extraMethod) push('method', term);

  const extraDomain = DOMAIN_TERMS.filter((term) => resumeText.includes(term.toLowerCase()) && !seen.has(term.toLowerCase()));
  for (const term of extraDomain) push('domain', term);

  const names = { tool: '技术栈', method: '工程与流程', domain: '业务领域', duty: '职责能力' };
  const caps = { tool: 18, method: 8, domain: 5, duty: 4 };

  return Object.entries(groups)
    .sort((a, b) => (order[a[0]] || 9) - (order[b[0]] || 9))
    .map(([cat, items]) => ({ name: names[cat] || cat, items: items.slice(0, caps[cat] || 8) }))
    .filter((gr) => gr.items.length);
}

/** 要点排序：与 JD 相关的排前面 */
function rankBullets(profile, job, tailored, ownedKeywords) {
  const highlights = profile.highlights || [];
  const kwSet = new Set(ownedKeywords.map((k) => k.term.toLowerCase()));
  const jdHits = new Set([
    ...(job.dimensions || []).flatMap((d) => d.hits || []).map((x) => String(x).toLowerCase()),
    ...kwSet,
  ]);

  const scored = highlights.map((h) => {
    const t = String(h.text || '');
    let score = 0;
    for (const kw of h.keywords || []) {
      if (jdHits.has(String(kw).toLowerCase())) score += 5;
    }
    for (const k of kwSet) {
      if (t.toLowerCase().includes(k)) score += 3;
    }
    // 有数字的结果加分
    if (/\d+\s*(%|倍|天|小时|秒|万|人|fps|ms|s)/.test(t)) score += 4;
    // 与岗位要求维度匹配
    for (const d of h.dims || []) {
      const jdDim = (job.dimensions || []).find((x) => x.id === d);
      if (jdDim && jdDim.ratio > 0.3) score += 3;
    }
    return { ...h, _score: score };
  }).sort((a, b) => b._score - a._score);

  // 分桶：强相关给了 JD 证据的 / 其余
  const strong = scored.filter((h) => h._score >= 6).slice(0, 3);
  const rest = scored.filter((h) => !strong.includes(h));

  // 最终顺序：强相关前 6 条 + 其余，总上限 12 条（一页简历的量）
  const all = [...strong, ...rest].slice(0, 12);

  return { strong, all };
}

/**
 * 渲染工作经历：按「公司 + 职位 + 时间」分组
 *
 * 分组依据是简历里解析出的工作条目（highlight.org/period），
 * 组内要点按与 JD 的相关度排序。
 * 没有条目信息时退化成平铺列表，不编造公司名。
 */
/** 判断用户新增技能属于哪一类（用于技能分组） */
function classifyExtra(term) {
  const lower = String(term).toLowerCase();
  if (TECH_TERMS.some((x) => x.toLowerCase() === lower)) return 'tool';
  if (METHOD_TERMS.some((x) => x.toLowerCase() === lower)) return 'method';
  if (DOMAIN_TERMS.some((x) => x.toLowerCase() === lower)) return 'domain';
  return 'tool';
}

function renderExperience(profile, bullets) {
  const out = [];
  const entries = profile.meta?.workEntries || [];

  if (!bullets.length) {
    out.push('- （待补充：从你的简历里没抽到工作要点。用「- 」开头的列表行描述工作内容，抽取效果最好）');
    return out;
  }

  // 没有工作条目 → 平铺
  if (!entries.length) {
    for (const b of bullets) {
      const text = trimBullet(b.text);
      if (text) out.push('- ' + text);
    }
    out.push('');
    out.push('> 注：简历里没解析出「公司 + 在职时间」，请在导出后补上。格式建议：'
      + '`2021.03 - 至今   某公司   前端负责人`');
    return out;
  }

  // 按条目分组
  const groups = new Map();
  for (const e of entries) groups.set(e.id, { ...e, bullets: [] });
  const orphans = [];
  for (const b of bullets) {
    const g = b.entryId ? groups.get(b.entryId) : null;
    if (g) g.bullets.push(b);
    else orphans.push(b);
  }

  // 条目顺序：原简历顺序（通常是倒序，最近的在前）
  for (const e of entries) {
    const g = groups.get(e.id);
    if (!g || !g.bullets.length) continue;

    const head = [e.org, e.role].filter(Boolean).join(' · ');
    out.push('### ' + (head || '工作经历'));
    if (e.period) out.push('*' + e.period + '*');
    out.push('');
    for (const b of g.bullets) {
      const text = trimBullet(b.text);
      if (text) out.push('- ' + text);
    }
    out.push('');
  }

  // 不属于任何条目的要点
  if (orphans.length) {
    out.push('### 其他工作内容', '');
    for (const b of orphans) {
      const text = trimBullet(b.text);
      if (text) out.push('- ' + text);
    }
    out.push('');
  }

  return out;
}

/** 清理要点文本：去前缀、限长 */
function trimBullet(raw) {
  let text = String(raw || '').replace(/^[-•·\s]+/, '').trim();
  if (!text) return '';
  if (text.length > 170) text = text.slice(0, 168) + '…';
  return text;
}

/**
 * 从要点里抽项目名
 * 「使用 Vue3 + TypeScript 开发企业微信侧客服工作台，支撑 200+ 客服」
 *   → 「企业微信侧客服工作台」
 */
function projectTitleOf(raw) {
  const t = String(raw || '').replace(/^[-•·\s]+/, '').trim();

  // 「使用/基于/用 X 开发/搭建/实现 Y」→ 取 Y
  const m = t.match(/(?:使用|基于|用|通过)\s+[^，,。；;]{2,40}?\s*(?:开发|搭建|实现|建设|重构|设计了?|做了?)\s*([^，,。；;（(]{2,24})/);
  if (m) return clean2(m[1]);

  // 「负责 X」
  const m2 = t.match(/^(?:负责|主导|参与)\s*([^，,。；;（(]{2,24})/);
  if (m2) return clean2(m2[1]);

  // 兜底：第一个逗号前
  return clean2(t.split(/[，,。；;]/)[0]).slice(0, 24) || '项目';
}

function clean2(s) {
  return String(s || '').replace(/[（(].*$/, '').trim().slice(0, 26);
}

/** 挑项目：把带项目特征词的要点升格成项目段落 */
function pickProjects(profile, job, usedTexts = new Set(), projectBullets = []) {
  const jdHits = new Set((job.dimensions || []).flatMap((d) => d.hits || []).map((x) => String(x).toLowerCase()));

  // 优先用「项目经历」段里的要点
  if (projectBullets.length) {
    return projectBullets.slice(0, 3).map((b) => ({
      title: projectTitleOf(b.text),
      text: trimBullet(b.text),
      keywords: b.keywords || [],
      _rel: (b.keywords || []).filter((k) => jdHits.has(String(k).toLowerCase())).length,
    })).sort((a, b) => b._rel - a._rel);
  }

  const projRe = /(系统|平台|小程序|工作台|后台|官网|组件库|中台|网站|App|工具|框架)/;
  const projects = [];
  for (const h of profile.highlights || []) {
    const t = String(h.text || '');
    if (!projRe.test(t)) continue;
    if (projects.length >= 3) break;
    if (usedTexts.has(t)) continue;
    if (projects.some((p2) => p2.text === t)) continue;

    const rel = (h.keywords || []).filter((k) => jdHits.has(String(k).toLowerCase())).length;

    projects.push({
      title: projectTitleOf(t),
      text: t.replace(/^[-•·\s]+/, ''),
      keywords: h.keywords || [],
      _rel: rel,
    });
  }

  return projects.sort((a, b) => b._rel - a._rel).slice(0, 3);
}

/**
 * 关键词检查
 *
 * 为什么不用「密度百分比」：
 * 中文没有空格分词，按空格算总词数会得到荒谬的分母 —— 实测把
 * 「Vue 出现 20 次」算成 6.5% 密度，误报堆砌。
 *
 * 改用 ATS 实践里的绝对次数 + 章节分布：
 *   0 次        → 漏了，搜不到
 *   1-5 次      → 健康（技能区声明 + 经历区 1-2 处证据）
 *   6-9 次      → 偏多，注意是否在硬凑
 *   10+ 次      → 堆砌，读起来会假
 */
function checkDensity(markdown, mustHave) {
  const sections = splitSections(markdown);
  const issues = [];

  for (const k of mustHave) {
    const term = k.term;
    const lower = term.toLowerCase();
    let n = 0;
    const inSections = [];

    for (const [name, body] of Object.entries(sections)) {
      const c = countOccurrences(body.toLowerCase(), lower);
      if (c) { n += c; inSections.push(name); }
    }

    if (n === 0) {
      issues.push({ term, count: 0, level: 'missing', sections: [], msg: '没出现，ATS 搜不到' });
    } else if (n >= 10) {
      issues.push({ term, count: n, level: 'stuffing', sections: inSections, msg: '出现 ' + n + ' 次，读起来像硬凑' });
    } else if (n >= 6) {
      issues.push({ term, count: n, level: 'many', sections: inSections, msg: '出现 ' + n + ' 次，偏多' });
    }
  }

  const missing = issues.filter((i) => i.level === 'missing').length;
  return {
    issues,
    healthy: mustHave.length - missing,
    total: mustHave.length,
    ok: missing === 0,
  };
}

/** 按 ## 标题切段，用于判断关键词出现在哪些位置 */
function splitSections(markdown) {
  const out = { 头部: '' };
  let cur = '头部';
  for (const line of String(markdown).split('\n')) {
    const m = line.match(/^##\s+(.+)$/);
    if (m) { cur = m[1].trim(); out[cur] = ''; continue; }
    out[cur] += line + '\n';
  }
  return out;
}

/** ATS 格式检查 */
function atsChecks(markdown) {
  const checks = [];

  checks.push({
    key: 'single-column',
    ok: !/^\|/m.test(markdown),
    label: '单列布局（无表格）',
    detail: /^\|/m.test(markdown) ? '简历里有表格，部分 ATS 会解析错乱' : '无表格，解析安全',
  });

  const headings = ['核心优势', '专业技能', '工作经历'];
  const missing = headings.filter((h) => !markdown.includes('## ' + h));
  checks.push({
    key: 'headings',
    ok: missing.length === 0,
    label: '标准章节标题',
    detail: missing.length ? '缺少：' + missing.join('、') : '摘要 / 技能 / 经历 齐全',
  });

  checks.push({
    key: 'no-image',
    ok: !/!\[/.test(markdown),
    label: '无图片/图标',
    detail: /!\[/.test(markdown) ? '有图片，ATS 读不到里面的字' : '纯文本',
  });

  checks.push({
    key: 'length',
    ok: markdown.length < 6000,
    label: '篇幅可控',
    detail: markdown.length < 6000 ? '约 ' + Math.round(markdown.length / 500) + ' 页内' : '偏长，建议压缩到 1-2 页',
  });

  return checks;
}

/**
 * 生成可打印的 HTML（用于导出 PDF）
 *
 * 为什么用 HTML 而不是自己造 PDF：
 * 浏览器「打印 → 存为 PDF」产出的 PDF 文本层是完整的，
 * ATS 能正常解析。自己拼 PDF 二进制很容易做出图片型 PDF。
 */
export function renderPrintableHTML(profile, job, markdown) {
  const p = profile.profile || {};
  const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
  ));

  // 极简 Markdown → HTML（只处理简历用到的语法）
  const body = markdown
    .split('\n')
    .map((line) => {
      if (/^# /.test(line)) return '<h1>' + esc(line.slice(2)) + '</h1>';
      if (/^## /.test(line)) return '<h2>' + esc(line.slice(3)) + '</h2>';
      if (/^### /.test(line)) return '<h3>' + esc(line.slice(4)) + '</h3>';
      if (/^> /.test(line)) return '<p class="note">' + esc(line.slice(2)) + '</p>';
      if (/^- /.test(line)) {
        const t = line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        return '<li>' + t.replace(/[<>]/g, '') + '</li>';
      }
      if (!line.trim()) return '';
      return '<p>' + esc(line) + '</p>';
    })
    .join('\n')
    .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (m) => '<ul>' + m + '</ul>');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${esc(p.name || '简历')} - ${esc(job.position || '')}</title>
<style>
  @page { size: A4; margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font: 11pt/1.65 -apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif;
    color: #111; margin: 0; padding: 0;
  }
  h1 { font-size: 20pt; margin: 0 0 4pt; letter-spacing: -.01em; }
  h2 {
    font-size: 12pt; margin: 16pt 0 7pt; padding-bottom: 3pt;
    border-bottom: 1px solid #333; text-transform: none;
  }
  h3 { font-size: 11pt; margin: 10pt 0 4pt; }
  p { margin: 0 0 5pt; }
  ul { margin: 0 0 6pt; padding-left: 15pt; }
  li { margin-bottom: 3pt; }
  strong { font-weight: 600; }
  .note { color: #666; font-size: 9pt; font-style: italic; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
${body}
</body>
</html>`;
}
