/**
 * extractor.js —— JD 提取
 *
 * 内容脚本是普通脚本（不是 ES module），所以用 IIFE 挂到隔离世界的全局上。
 * 不污染页面：内容脚本有自己的 JS 堆，window 是共享的但变量是隔离的。
 *
 * 设计原则：不硬编码选择器。
 * 招聘网站改版频繁，写死 `.job-detail .text` 这种选择器，一改版就废。
 *
 * 四层策略，逐层降级：
 *   1. JSON-LD（schema.org/JobPosting）—— 最可靠，很多站为 SEO 会输出
 *   2. 站点快速通道 —— 对已知站点用已知选择器，命中就用
 *   3. 启发式容器评分 —— 找「像 JD」的容器：正文长 + JD 关键词密度高 + 层级深
 *   4. 兜底 —— main / article / body，剔除导航和页脚
 *
 * 每一层都返回 { title, company, text, source }，source 标明命中层，便于排查。
 */

/** JD 高频词：用来判断一段文本像不像岗位描述 */
const JD_SIGNALS = [
  '岗位职责', '工作职责', '职位描述', '任职要求', '任职资格', '岗位要求', '职位要求',
  '工作内容', '职责描述', '我们希望你', '你将负责', '你需要', '加分项', '优先',
  'responsibilities', 'requirements', 'qualifications', 'what you',
  '经验', '熟悉', '精通', '掌握', '负责', '参与',
];

/** 站点快速通道配置 */
const SITE_RULES = [
  {
    host: /(^|\.)zhipin\.com$/,
    title: ['.job-banner .name h1', '.job-banner h1', 'h1'],
    company: ['.job-banner .company-info .name', '.company-info .name', '.sider-company .name'],
    body: ['.job-sec-text', '.job-detail-section .text', '.job-detail .text', '.detail-content .text'],
  },
  {
    host: /(^|\.)zhaopin\.com$/,
    title: ['h3.summary-plane__title', '.summary-plane__title', 'h1', 'h3'],
    company: ['.company-title', '.company-name', '.summary-plane__company'],
    body: ['.describtion__detail-content', '.describtion', '.summary-plane__content', '.job-description'],
  },
  {
    host: /(^|\.)liepin\.com$/,
    title: ['.job-title-box .name', '.job-title', 'h1'],
    company: ['.company-name', '.job-company-name'],
    body: ['.job-intro-container .paragraph', '.job-description', '.inner-left'],
  },
  {
    host: /(^|\.)lagou\.com$/,
    title: ['.position-head .position-content .name', '.position-name', 'h1'],
    company: ['.company', '.job_company .fl-cn'],
    body: ['.job_bt', '.job-detail', '.position-detail'],
  },
  {
    host: /(^|\.)51job\.com$/,
    title: ['.cn h1', 'h1', '.job-title'],
    company: ['.cname', '.com', '.company-name'],
    body: ['.bmsg.job_msg', '.job_msg', '.job-detail'],
  },
  {
    host: /(^|\.)linkedin\.com$/,
    title: ['.job-details-jobs-unified-top-card__job-title', 'h1'],
    company: ['.job-details-jobs-unified-top-card__company-name'],
    body: ['.jobs-description-content__text', '.jobs-box__html-content', '.description__text'],
  },
  {
    host: /(^|\.)bosszhipin\.com$/,
    title: ['.job-banner .name h1', 'h1'],
    company: ['.company-info .name'],
    body: ['.job-sec-text', '.job-detail .text'],
  },
  {
    host: /(^|\.)nowcoder\.com$/,
    title: ['h1', '.job-title'],
    company: ['.company-name'],
    body: ['.job-detail', '.job-content', '.intro-detail'],
  },
];

const JM = {};

/** 正文开头常见的小标题，切掉它们，避免被当成岗位名 */
const LEADING_LABELS = /^(职位描述|岗位职责|职位详情|工作职责|职位信息|岗位描述|职责描述|招聘信息|职位诱惑|工作内容)\s*[:：]?\s*\n+/;

const clean = (s) => String(s || '')
  .replace(/\u00a0/g, ' ')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/** 从元素取可见文本，剔除 script/style/nav/footer */
function visibleText(el) {
  if (!el) return '';
  const clone = el.cloneNode(true);
  clone.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,header,aside,button').forEach((n) => n.remove());
  return clean(clone.innerText || clone.textContent || '');
}

/**
 * 元素是否落在「列表项」里
 *
 * 招聘站常见「左列表 + 右详情」双栏，列表卡片里也有 .company-name / .job-title。
 * 全局按选择器找第一个匹配会抓到列表的公司名 —— 这是实测踩到的 bug。
 */
function inListContext(el) {
  if (!el) return false;
  let node = el;
  let depth = 0;
  while (node && depth < 8) {
    if (node.nodeType !== 1) { node = node.parentElement; depth++; continue; }
    const tag = node.tagName.toLowerCase();
    if (tag === 'li' || tag === 'ul' || tag === 'ol') return true;
    const cls = String(node.className || '').toLowerCase();
    // 明确的列表容器命名
    if (/(^|[-_])(list|item|card|result|listitem|joblist)([-_]|$)/.test(cls)) return true;
    // data 属性也常见
    if (node.dataset && node.dataset.id && tag === 'div' && node.children.length <= 4) return true;
    node = node.parentElement; depth++;
  }
  return false;
}

/** 用选择器列表依次尝试，返回第一个命中的元素 */
function pick(selectors) {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el && visibleText(el).length > 8) return el;
    } catch { /* 无效选择器直接跳过 */ }
  }
  return null;
}

/** 第 1 层：JSON-LD */
function fromJsonLd() {
  const scripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const s of scripts) {
    let data;
    try { data = JSON.parse(s.textContent || ''); } catch { continue; }

    const nodes = Array.isArray(data) ? data : (data['@graph'] || [data]);
    for (const node of nodes) {
      if (!node || typeof node !== 'object') continue;
      const type = node['@type'];
      const isJob = type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
      if (!isJob) continue;

      const text = clean(
        [node.description || '', node.responsibilities || '', node.qualifications || ''].join('\n')
      ).replace(/<[^>]+>/g, '\n').replace(/\n{2,}/g, '\n');
      if (text.length < 60) continue;

      const company = typeof node.hiringOrganization === 'object'
        ? node.hiringOrganization?.name
        : node.hiringOrganization;

      return {
        title: clean(node.title || ''),
        company: clean(company || ''),
        text,
        source: 'json-ld',
      };
    }
  }
  return null;
}

/** 第 2 层：站点快速通道 */
function fromSiteRules() {
  const rule = SITE_RULES.find((r) => r.host.test(location.hostname));
  if (!rule) return null;

  const bodyEl = pick(rule.body);
  if (!bodyEl) return null;

  const text = visibleText(bodyEl);
  if (text.length < 80) return null;

  return {
    title: clean(pick(rule.title)?.innerText || document.title.split(/[-|_]/)[0]),
    company: clean(pick(rule.company)?.innerText || ''),
    text,
    source: 'site-rule',
    scopeEl: bodyEl,
  };
}

/** 给一段文本打「像不像 JD」的分 */
function jdScore(text) {
  if (text.length < 80) return 0;
  const lower = text.toLowerCase();
  let hits = 0;
  for (const sig of JD_SIGNALS) {
    if (lower.includes(sig.toLowerCase())) hits++;
  }
  // 关键词命中权重高，长度只作为次要因素（超过 6000 字收益递减）
  const lengthScore = Math.min(text.length, 6000) / 6000 * 30;
  return hits * 12 + lengthScore;
}

/** 第 3 层：启发式容器评分 */
function fromHeuristic() {
  const candidates = [];
  const seen = new Set();

  // 优先怀疑这些命名特征的容器
  const selectors = [
    '[class*="job-detail"]', '[class*="jobDetail"]', '[class*="job-desc"]', '[class*="jobDesc"]',
    '[class*="job-sec"]', '[class*="job_intro"]', '[class*="job-intro"]',
    '[class*="position-detail"]', '[class*="positionDetail"]', '[class*="position-content"]',
    '[class*="describ"]', '[class*="description"]', '[class*="desc-content"]',
    '[class*="desc"]', '[class*="detail"]', '[class*="intro"]',
    '[class*="requirement"]', '[class*="duty"]', '[class*="responsibilit"]',
    '[class*="detail-content"]', '[class*="content-detail"]',
    'article', 'main', '[role="main"]',
  ];

  for (const sel of selectors) {
    let els;
    try { els = document.querySelectorAll(sel); } catch { continue; }
    for (const el of els) {
      if (seen.has(el)) continue;
      seen.add(el);
      const text = visibleText(el);
      if (text.length < 120) continue;
      candidates.push({ el, text, score: jdScore(text) });
    }
  }

  if (!candidates.length) return null;

  // 选容器的策略：先看分数，再在「分数接近最高分」的候选里取最短的
  //
  // 为什么：智联这类「左列表 + 右详情」布局，外层容器分数可能最高
  // （因为把详情的关键词都包进去了），但它同时包住了列表 —— 会污染
  // 标题和公司识别。真正该选的是「差不多能覆盖 JD 的最小容器」。
  candidates.sort((a, b) => b.score - a.score);
  const topScore = candidates[0].score;
  const near = candidates.filter((c) => c.score >= topScore * 0.85);
  near.sort((a, b) => a.text.length - b.text.length);
  const best = near[0];

  // 分数太低说明不像 JD
  if (best.score < 18) return null;

  // scopeEl 必须带出去：主入口、公司名扫描都依赖它定位「正文所在区域」
  const scopedTitle = guessTitle(best.el);
  return {
    title: clean(scopedTitle),
    company: clean(guessCompany(scopedTitle, best.el)),
    text: best.text,
    source: 'heuristic',
    scopeEl: best.el,
  };
}

/** 第 4 层：兜底整页 */
function fromBody() {
  const main = document.querySelector('main, article, [role="main"]');
  const text = visibleText(main || document.body);
  if (text.length < 100) return null;
  const t2 = guessTitle(main);
  return {
    title: clean(t2),
    company: clean(guessCompany(t2, main)),
    text: text.slice(0, 20000),
    source: 'body-fallback',
    scopeEl: main || document.body,
  };
}

/** 猜标题（优先详情区域，避免抓到列表里的岗位名） */
function guessTitle(scopeEl) {
  const TITLE_SELS = [
    '[class*="job-title"]', '[class*="jobTitle"]', '[class*="position-name"]',
    '[class*="positionName"]', 'h1', 'h2',
  ];

  const usable = (s) => {
    const v = clean(s);
    if (v.length < 2 || v.length > 60) return '';
    if (/^(职位描述|岗位职责|职位详情|工作职责|招聘|职位信息|公司介绍|职位诱惑)$/.test(v)) return '';
    return v;
  };

  // 1. 详情区域优先
  if (scopeEl) {
    let node = scopeEl;
    for (let i = 0; i < 4 && node; i++) {
      for (const sel of TITLE_SELS) {
        let el;
        try { el = node.querySelector(sel); } catch { continue; }
        if (el && !inListContext(el)) {
          const v = usable(el.innerText);
          if (v) return v;
        }
      }
      node = node.parentElement;
    }
  }

  // 2. 全局，跳过列表
  for (const sel of TITLE_SELS) {
    let els;
    try { els = document.querySelectorAll(sel); } catch { continue; }
    for (const el of els) {
      if (inListContext(el)) continue;
      const v = usable(el.innerText);
      if (v) return v;
    }
  }

  // 3. 关键兜底：在详情区里扫「像岗位名」的短文本
  //    实测智联等站点的职位名没有稳定的 class，只能靠语义特征找
  const scan = scanForJobTitle(scopeEl);
  if (scan) return scan;

  const t2 = document.title.split(/[-|_·]/)[0].trim();
  if (t2 && !/招聘|人才|求职|找工作|职位搜索/.test(t2) && t2.length <= 40) return t2;
  return '';
}

/**
 * 扫「像岗位名」的文本
 *
 * 判断依据（满足越多越可能是职位名）：
 *   · 长度 4-30
 *   · 含岗位词：工程师/开发/前端/后端/架构师/经理/负责人/专家/实习生/运营/产品/设计…
 *   · 不含句子标点（，。；）和「薪资/要求/职责」这类标签
 *   · 在页面上比较靠上（y 坐标小）
 */
function scanForJobTitle(scopeEl) {
  const JOB_WORD = /(工程师|开发|前端|后端|全栈|架构师|技术负责人|负责人|经理|主管|总监|专家|实习生|设计师|产品经理|运营|测试|算法|数据|运维|Java|Python|Go|React|Vue|Node|PHP|C\+\+|Android|iOS|Web|AI)/i;
  const BAD = /(薪资|要求|职责|福利|描述|地点|经验|学历|公司|地址|时间|发布|浏览|收藏|举报|立即|申请|投递|分享)/;

  const root = scopeEl || document.body;
  const nodes = root.querySelectorAll('h1,h2,h3,h4,span,div,a,strong,b');
  const cands = [];
  // 正文容器的位置：标题通常在它正上方不远处
  let baseRect = null;
  try { baseRect = (scopeEl || root).getBoundingClientRect(); } catch { /* 忽略 */ }

  for (const el of nodes) {
    // 只看叶子级文本，避免整块容器
    if (el.children.length > 1) continue;
    const txt = clean(el.innerText || el.textContent || '');
    if (txt.length < 4 || txt.length > 30) continue;
    if (BAD.test(txt)) continue;
    if (/[，。；！？,;!?]/.test(txt)) continue;
    if (!JOB_WORD.test(txt)) continue;
    // 纯标签词不算
    if (/^(前端|后端|Java|Vue|React|Node\.?js)$/i.test(txt)) continue;

    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 打点：越靠上越可能是标题；字号大的加分
    const fs = parseFloat(getComputedStyle(el).fontSize) || 14;
    const fw = parseInt(getComputedStyle(el).fontWeight, 10) || 400;

    // 三条判据：字号大 / 字重粗 / 离正文容器近
    // 字号不是唯一依据（有些站详情标题和列表一样大），距离更稳
    let dist = 0;
    if (baseRect) {
      const dy = Math.abs(r.top - baseRect.top);
      const dx = Math.abs(r.left - baseRect.left);
      dist = dy + dx;
    }
    const nearScore = !baseRect ? 0 : dist < 200 ? 8 : dist < 500 ? 5 : dist < 900 ? 2 : -3;

    const score = (fs >= 20 ? 10 : fs >= 17 ? 7 : fs >= 15 ? 3 : 0)
      + (fw >= 600 ? 3 : 0)
      + nearScore
      + (JOB_WORD.test(txt) ? 2 : 0);
    cands.push({ txt, score, top: r.top, fs, dist });
  }

  if (!cands.length) return '';
  cands.sort((a, b) => (b.score - a.score) || (a.top - b.top));
  return cands[0].txt;
}

/**
 * 猜公司名
 * @param {string} jobTitle 已知的岗位名，用于排除「把标题当公司名」
 *
 * 依次尝试：
 *   1. 页面里明确标了公司名的元素
 *   2. 正文里的「公司：XXX」这类行
 *   3. og:site_name
 *   4. 标题里的「XX招聘」
 *   5. 域名反推（去掉 www / careers / jobs 等子域）
 */
function guessCompany(jobTitle, scopeEl) {
  const strip = (v) => clean(v)
    .replace(/^(careers?\s+at|jobs?\s+at|work\s+at|join)\s+/i, '')
    .replace(/[|｜·—-]+$/, '')
    .trim();

  const bad = (v) => {
    if (!v) return true;
    const s = strip(v);
    if (s.length < 2 || s.length > 40) return true;
    if (jobTitle && s === clean(jobTitle)) return true;
    // 排除常见非公司名
    if (/^(招聘|职位|岗位|首页|详情|BOSS直聘|智联招聘|猎聘|拉勾|前程无忧|登录|注册)$/.test(s)) return true;
    if (/直聘|招聘网|人才网/.test(s)) return true;
    return false;
  };

  // 1. 先在 JD 容器及其祖先里找（详情区的公司名一定在这里面）
  const selectors = [
    '[class*="company-title"]', '[class*="company-name"]', '[class*="companyName"]',
    '[class*="company_title"]', '[class*="company"] a', '[class*="com-name"]',
    '[class*="corp-name"]', '[class*="brand-name"]', '[itemprop="hiringOrganization"]',
    '[class*="company-info"] [class*="name"]', '[class*="company-info"]',
  ];

  // 作用域：容器本身 + 上溯 5 层
  const scopes = [];
  if (scopeEl) {
    let node = scopeEl;
    for (let i = 0; i < 5 && node; i++) { scopes.push(node); node = node.parentElement; }
  }

  for (const scope of scopes) {
    for (const sel of selectors) {
      let els;
      try { els = scope.querySelectorAll(sel); } catch { continue; }
      for (const el of els) {
        const s = strip(el.innerText);
        if (!bad(s)) return s;
      }
    }
  }

  // 2. 全局找，但跳过列表项里的（列表卡片会污染）
  for (const sel of selectors) {
    let els;
    try { els = document.querySelectorAll(sel); } catch { continue; }
    for (const el of els) {
      if (inListContext(el)) continue;
      const s = strip(el.innerText);
      if (!bad(s)) return s;
    }
  }

  // 2. 正文里的「公司：XXX」
  const body = document.body?.innerText || '';
  const m1 = body.match(/(?:公司名称|公司|企业名称|招聘企业)\s*[:：]\s*([^\s，,。；;\n]{2,30})/);
  if (m1 && !bad(m1[1])) return strip(m1[1]);

  // 2.5 容器附近扫「像公司名」的短文本（带 公司/科技/集团/有限/股份 等字）
  const CO_SUFFIX = /(有限公司|股份有限公司|有限责任公司|科技|集团|网络|信息|软件|技术|实业|控股|bank|inc|ltd|co\.|corp)/i;
  const scopes2 = [];
  if (scopeEl) {
    let node = scopeEl;
    for (let i = 0; i < 5 && node; i++) { scopes2.push(node); node = node.parentElement; }
  }
  for (const scope of scopes2) {
    for (const el of scope.querySelectorAll('span,div,a,p,strong,b,h1,h2,h3')) {
      if (el.children.length > 1) continue;
      const txt = strip(el.innerText || '');
      if (txt.length < 4 || txt.length > 30) continue;
      if (!CO_SUFFIX.test(txt)) continue;
      if (/[，。；,;]/.test(txt)) continue;
      if (bad(txt)) continue;
      // 排除「20-99人 · 软件/IT服务」这类规模描述、纯数字、含「人 ·」的
      if (/(\d+\s*[-~]\s*\d+\s*人|人\s*[·|]|^[\d\s.·-]+$)/.test(txt)) continue;
      if (/^(招聘|职位|岗位|详情|首页|公司|规模|行业)/.test(txt)) continue;
      // 至少要有 公司/集团/有限 之一，或有 科技/网络/信息/软件 + 长度>=6
      const strong = /(有限公司|股份|集团|有限责任公司)/.test(txt);
      const weak = /(科技|网络|信息|软件|技术|实业|控股)/.test(txt) && txt.length >= 6;
      if (!strong && !weak) continue;
      return txt;
    }
  }

  // 3. og:site_name
  const og = document.querySelector('meta[property="og:site_name"]')?.content;
  if (!bad(og)) return strip(og);

  // 4. 标题里的「XX招聘」—— 只在不像「城市+职位」时采用
  //    实测「北京前端开发招聘」会被抠成「北京前端开发」，不是公司名
  const m2 = document.title.match(/^(.{2,20}?)招聘/);
  if (m2) {
    const c = strip(m2[1]);
    const looksLikePlace = /^(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|苏州|天津|重庆|长沙|郑州|青岛|厦门|福州|济南|合肥|宁波|东莞|佛山|珠海|无锡|大连|沈阳)/.test(c)
      || /(前端|后端|开发|工程师|产品|运营|设计|测试|算法|数据|销售|客服)/.test(c);
    if (!looksLikePlace && !bad(c)) return c;
  }

  // 5. 域名反推：careers.n-ix.com → n-ix
  //    排除 IP、localhost、以及已知招聘站
  const rawHost = location.hostname;
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(rawHost);
  const isLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(rawHost);
  if (!isIp && !isLocal) {
    const host = rawHost.replace(/^(www|m|careers|jobs|job|talent|hr|zhaopin|recruit)\./i, '');
    const parts = host.split('.');
    const KNOWN_SITES = /zhipin|zhaopin|liepin|lagou|51job|linkedin|nowcoder|bosszhipin|maimai|kanzhun/i;
    if (parts.length >= 2 && !KNOWN_SITES.test(host)) {
      const name = parts[0];
      if (name.length >= 2 && name.length <= 24 && /[a-z\u4e00-\u9fa5]/i.test(name)) return name;
    }
  }

  return '';
}

/**
 * 内容指纹：判断「还是不是同一个岗位」
 */
function fingerprintOf(text) {
  const s = String(text || '');
  if (!s) return '';
  const head = s.slice(0, 160).replace(/\s+/g, '');
  const tail = s.slice(-80).replace(/\s+/g, '');
  return s.length + '|' + head + '|' + tail;
}

/**
 * 主入口：提取当前页面的 JD
 * @returns {{ title, company, text, source, url } | { error }}
 */
function extractJD() {
  const layers = [fromJsonLd, fromSiteRules, fromHeuristic, fromBody];

  for (const layer of layers) {
    let r = null;
    try { r = layer(); } catch { r = null; }
    if (r && r.text && r.text.length >= 80) {
      const text = clean(r.text).replace(LEADING_LABELS, '');
      // 标题/公司都基于「正文所在容器」来找，避免抓到左侧列表卡片的
      const scopedTitle = clean(r.title) || guessTitle(r.scopeEl);
      const scopedCompany = clean(r.company) || guessCompany(scopedTitle, r.scopeEl);
      return {
        title: scopedTitle,
        company: scopedCompany,
        text: text.slice(0, 40000),
        source: r.source,
        url: location.href,
        length: text.length,
        // 用于判断「页面内容变了没」（SPA 切岗位时）
        fingerprint: fingerprintOf(text),
      };
    }
  }

  return { error: '这个页面没识别到岗位描述。可以点「手动选择」再点页面上的 JD 区域。' };
}

/**
 * 手动选择模式：让用户点页面元素来指定 JD 区域
 * @returns {Promise<object>}
 */
function extractByPicker() {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    // 关键：pointer-events:none，否则 elementFromPoint 永远返回遮罩自己
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:rgba(54,105,236,.06);'
      + 'cursor:crosshair;pointer-events:none';

    const tip = document.createElement('div');
    tip.textContent = '点选岗位描述区域（Esc 取消）';
    tip.style.cssText = 'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;'
      + 'background:#3669EC;color:#fff;padding:10px 20px;border-radius:999px;font:500 14px/1 system-ui;'
      + 'box-shadow:0 6px 20px rgba(54,105,236,.35);pointer-events:none';

    let current = null;

    const onMove = (e) => {
      if (current) current.style.outline = '';
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && el !== overlay && el !== tip && el !== document.documentElement) {
        current = el;
        current.style.outline = '2px solid #3669EC';
      }
    };

    const finish = (result) => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      if (current) current.style.outline = '';
      overlay.remove();
      tip.remove();
      resolve(result);
    };

    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el) return finish({ error: '没选中元素' });
      const text = visibleText(el);
      if (text.length < 60) return finish({ error: '选中的区域文字太少，换一个大一点的区域' });
      finish({
        title: guessTitle(el),
        company: guessCompany('', el),
        text: text.slice(0, 40000),
        source: 'manual-pick',
        url: location.href,
        length: text.length,
        fingerprint: fingerprintOf(text),
      });
    };

    const onKey = (e) => {
      if (e.key === 'Escape') finish({ error: '已取消' });
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay, tip);
  });
}

JM.extractJD = extractJD;
JM.extractByPicker = extractByPicker;

// 内容脚本共享同一个隔离世界，content.js 能拿到这个对象
window.__JM_EXTRACTOR__ = JM;
