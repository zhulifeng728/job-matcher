/**
 * deep-prep.js —— 技术复习深度文档
 *
 * 两条路径：
 *   A. 配了 AI → 用移植过来的 Prompt 生成 4000+ 字结构化长文，含续写
 *   B. 没配 AI → 用知识库按同样的 9 段结构生成，内容质量比查表高得多
 *
 * 这样「有没有 key」不再决定「能不能用」，只决定「内容有多深」。
 */

import { resolveAIConfig, chat } from './ai.js';
import {
  buildReviewDocPrompt,
  buildReviewDocContinuationPrompt,
  isReviewDocComplete,
  stripCompletionMarker,
  COMPLETION_MARKER,
} from './prompts/review-doc.js';
import { loadKnowledge } from './tailor.js';

const MAX_TOKENS = 4096;
const MAX_CONTINUATIONS = 3;

export function hasAI() {
  return Boolean(resolveAIConfig().enabled);
}

/**
 * 生成复习文档
 * @param {object} job 岗位
 * @param {object} profile 画像
 * @param {object} plan buildStudyPlan 的结果（知识点清单）
 * @param {(delta:string)=>void} onDelta 流式回调（可选）
 */
export async function generatePrepDoc(job, profile, plan, onDelta) {
  if (!hasAI()) {
    return {
      source: 'rules',
      content: buildRuleDoc(job, profile, plan),
      note: '当前未配置模型，以下内容由内置知识库按同一结构生成。配置模型后可得到针对你简历的定制版本。',
    };
  }

  const input = {
    resumeText: (profile.resumeText || '').slice(0, 6000),
    jobTitle: job.position,
    jobDescription: (job.text || '').slice(0, 4000),
  };

  let content = '';
  let round = 0;

  try {
    // 第一轮
    let chunk = await chat(buildReviewDocPrompt(input), { maxTokens: MAX_TOKENS, temperature: 0.4 });
    content = chunk;
    if (onDelta) onDelta(chunk);

    // 没写完就续写
    while (!isReviewDocComplete(content) && round < MAX_CONTINUATIONS) {
      round += 1;
      chunk = await chat(
        buildReviewDocContinuationPrompt(input, content),
        { maxTokens: MAX_TOKENS, temperature: 0.4 }
      );
      // 续写内容直接拼接（模型被要求从断点接上）
      content += '\n' + chunk;
      if (onDelta) onDelta('\n' + chunk);
    }

    return {
      source: 'ai',
      content: stripCompletionMarker(content),
      rounds: round + 1,
      complete: isReviewDocComplete(content),
      note: isReviewDocComplete(content)
        ? ''
        : `文档可能未完整（已续写 ${round} 次）。可以再点一次生成，或改用更长的模型上下文。`,
    };
  } catch (e) {
    // AI 失败 → 降级到规则版，不让用户空手
    return {
      source: 'rules-fallback',
      content: buildRuleDoc(job, profile, plan),
      note: '模型调用失败（' + e.message + '），已降级为内置知识库版本。',
    };
  }
}

// ══════════════════════════════════════════
// 规则版：按同一 9 段结构生成
// ══════════════════════════════════════════

function buildRuleDoc(job, profile, plan) {
  const kb = loadKnowledge();
  const L = [];
  const p = profile.profile || {};
  const topics = plan.topics || [];
  const p0 = topics.filter((t) => t.priority === 'P0');
  const p1 = topics.filter((t) => t.priority === 'P1');
  const hits = plan.exactHits || [];

  // ── 0. 文档地图 ──
  L.push('# 技术复习文档', '');
  L.push('> 岗位：' + (job.position || '') + ' @ ' + (job.company || '') + '　｜　匹配度 ' + (job.total ?? '-') + ' 分');
  L.push('> 候选人：' + (p.name || '-') + '　｜　' + (p.years || 0) + ' 年经验　｜　' + (p.headline || ''));
  L.push('');

  L.push('## 0. 文档地图与复习优先级', '');
  L.push('**候选人一句话定位**：' + oneLinePositioning(profile, job));
  L.push('');
  L.push('**目标岗位画像**：' + jobSummary(job, hits));
  L.push('');
  L.push('**复习优先级表**', '');
  L.push('| 优先级 | 主题 | 为什么重要 | 依据 | 面试风险 |');
  L.push('| --- | --- | --- | --- | --- |');
  for (const t of [...p0, ...p1].slice(0, 12)) {
    L.push('| ' + t.priority + ' | ' + t.name + ' | ' + (t.reason || '') + ' | ' + (t.dimension || '') + ' | '
      + (t.priority === 'P0' ? '高频必问，答不清直接掉档' : '可能被追问，需能说出取舍') + ' |');
  }
  L.push('');

  // 项目-技术映射
  L.push('**项目-技术映射表**', '');
  const projects = extractProjects(profile);
  if (projects.length) {
    L.push('| 项目 | 核心技术 | 可讲亮点 | 可能被追问 |');
    L.push('| --- | --- | --- | --- |');
    for (const pr of projects.slice(0, 5)) {
      L.push('| ' + pr.name + ' | ' + pr.tech + ' | ' + pr.highlight + ' | ' + pr.risk + ' |');
    }
  } else {
    L.push('_简历里没识别到明确的「项目经历」段。建议把工作内容改写成「项目名 + 我的动作 + 结果」的形式。_');
  }
  L.push('');

  // ── 1. 面试目标画像 ──
  L.push('## 1. 面试目标画像', '');
  L.push('**当前优势**');
  const strengths = (plan.talkingPoints || []).slice(0, 3);
  if (strengths.length) {
    for (const s of strengths) {
      L.push('- ' + s.story);
    }
  } else {
    L.push('- 简历里与这个岗位直接对应的经历较少，建议先补充相关项目描述。');
  }
  L.push('');
  L.push('**岗位匹配**');
  L.push('- 命中关键词：' + (hits.length ? hits.map((h) => '`' + h + '`').join('、') : '（无）'));
  L.push('- 岗位要求的维度：' + topDemanded(profile, plan));
  L.push('');
  L.push('**面试主线**（建议按这个顺序讲）');
  L.push('1. 先讲与岗位最贴的那个项目，30 秒讲清背景和结果');
  L.push('2. 再讲一个技术难点，重点说取舍，不说"我们用了 X 框架"');
  L.push('3. 最后讲方法论：为什么这么选、怎么验证、效果怎么衡量');
  L.push('');
  L.push('**自我介绍素材**（30 秒）');
  L.push('');
  L.push('> ' + selfIntro30s(profile, job));
  L.push('');

  // ── 2. 核心技术主题复习 ──
  L.push('## 2. 核心技术主题复习', '');
  L.push('> 每个主题给出「核心概念 / 高频问题 / 在你的项目中 / 面试官可能追问 / 关键代码或伪代码 / 知识图谱」六块。');
  L.push('');
  for (const t of [...p0, ...p1]) {
    L.push(renderTopic(t, kb, profile, job));
  }

  // ── 3. 项目深挖题库 ──
  L.push('## 3. 项目深挖题库', '');
  if (projects.length) {
    for (const pr of projects.slice(0, 3)) {
      L.push('### ' + pr.name, '');
      L.push('- **项目定位**：' + pr.highlight);
      L.push('- **架构与模块拆分**：' + pr.tech);
      L.push('- **个人贡献**：按简历描述为「' + pr.role + '」；面试时要明确说是主导、独立实现还是参与');
      L.push('- **难点与取舍**：建议准备 2 个。每个按「背景 → 我的方案 → 为什么不是另一种 → 结果」四段讲');
      L.push('- **高频追问**：');
      L.push('  1. 这个方案的边界在哪？什么情况下会失效？');
      L.push('  2. 如果推翻重做，你会改哪一处？');
      L.push('  3. 怎么衡量它带来了收益？');
      L.push('  4. 团队里其他人怎么接受这个方案的？');
      L.push('  5. 出过什么问题，怎么复盘的？');
      L.push('- **可量化指标清单**（面试前请补齐真实数字）：');
      L.push('  - 规模：多少用户 / 多少页面 / 多少模块');
      L.push('  - 效率：开发时长、构建时长、发布频率的变化');
      L.push('  - 质量：错误率、故障恢复时间、测试覆盖');
      L.push('');
    }
  } else {
    L.push('_未从简历中识别到项目段落，无法生成深挖题库。_', '');
  }

  // ── 4. 岗位专项准备 ──
  L.push('## 4. 岗位专项准备', '');
  L.push('**JD 关键词拆解**', '');
  L.push('| 岗位要求（JD 原文关键词） | 你的简历证据 | 准备话术 | 缺口补齐 |');
  L.push('| --- | --- | --- | --- |');
  const evidence = buildEvidenceMap(profile, hits);
  for (const e of evidence) {
    L.push('| `' + e.kw + '` | ' + e.evidence + ' | ' + e.talk + ' | ' + e.gap + ' |');
  }
  L.push('');
  L.push('**岗位高频考点**（按 JD 命中排序）');
  for (const t of p0.slice(0, 8)) {
    L.push('- **' + t.name + '**：' + (t.points || []).slice(0, 2).join('；'));
  }
  L.push('');
  L.push('**项目讲述顺序**：先讲「' + (projects[0]?.name || '最贴岗位的项目') + '」，'
    + '因为这个项目覆盖了 ' + (hits.slice(0, 3).map((h) => h).join('、') || '岗位核心要求') + '。');
  L.push('');

  // ── 5. 行为面试 ──
  L.push('## 5. 行为面试与负责人表达', '');
  L.push('**负责人视角常见问题**');
  ['需求评审时你会关注什么？', '任务怎么拆、排期怎么定？', '跨团队推不动时怎么办？',
    '质量标准怎么定、怎么守住？', 'Code Review 怎么做到既快又不流于形式？',
    '技术风险怎么提前识别？'].forEach((q, i) => {
      L.push((i + 1) + '. ' + q + '　→ 用一件具体的事回答，别讲原则');
    });
  L.push('');
  L.push('**STAR 案例库**（每类准备一个，共 5 个）');
  L.push('| 类型 | 情况 | 你要讲清的重点 |');
  L.push('| --- | --- | --- |');
  L.push('| 技术攻坚 | 一个卡住团队的技术问题 | 你怎么定位、试了哪些方案、最后为什么选这个 |');
  L.push('| 效率提升 | 重复劳动被自动化 | 改造前后的人工成本对比 |');
  L.push('| 线上问题 | 一次故障 | 止血 → 定位 → 根因 → 防复发 |');
  L.push('| 团队协作 | 跨团队推进 | 怎么对齐目标、怎么处理分歧 |');
  L.push('| AI 流程落地 | 引入 AI 工具 | 效果怎么验证、团队怎么接受 |');
  L.push('');
  L.push('**反问面试官**（挑 2-3 个问）');
  ['这个岗位当前最亟需解决的问题是什么？', '团队的技术决策是怎么做的？',
    '这个方向未来一年的重点在哪？', '团队的 Code Review 和发布流程是怎样的？',
    '团队在 AI 工具上的使用到什么程度了？'].forEach((q, i) => {
    L.push((i + 1) + '. ' + q);
  });
  L.push('');

  // ── 6. 复习计划 ──
  L.push('## 6. 7 / 14 / 28 天复习计划', '');
  L.push('**7 天冲刺**');
  L.push('| 天 | 主题 | 产出物 |');
  L.push('| --- | --- | --- |');
  const week = p0.slice(0, 7);
  week.forEach((t, i) => {
    L.push('| D' + (i + 1) + ' | ' + t.name + ' | 能口述 3 分钟，写出 1 段伪代码 |');
  });
  L.push('');
  L.push('**14 天系统复习**：P0 全过一遍 + P1 挑 4 个，产出 3 个 STAR 项目稿。');
  L.push('');
  L.push('**28 天深度提升**：加系统设计、模拟面试、项目复盘各 1 轮，最终产出 1 套完整的面试问答手册。');
  L.push('');

  // ── 7. 检查清单 ──
  L.push('## 7. 面试前最后检查清单', '');
  L.push('- [ ] P0 主题每个都能讲 3 分钟，不卡壳');
  L.push('- [ ] 每个项目准备好「背景 / 动作 / 结果」，结果有数字或可替代说法');
  L.push('- [ ] 关键技术点能说出「为什么不用另一种方案」');
  L.push('- [ ] 准备 2 个反问问题');
  L.push('- [ ] 简历里的每个技术名词都能被追问 2 层');
  L.push('- [ ] 想清楚「为什么离开上一家 / 为什么选我们」');
  L.push('');

  L.push('---', '');
  L.push('_本文档由内置知识库按固定结构生成。配置模型后，同样的结构会以你简历的真实内容填充，深度更高。_');

  return L.join('\n');
}

// ────────── 渲染单个主题 ──────────

function renderTopic(t, kb, profile, job) {
  const L = [];
  const stars = t.priority === 'P0' ? '⭐⭐⭐⭐⭐' : t.priority === 'P1' ? '⭐⭐⭐⭐' : '⭐⭐⭐';
  const why = t.priority === 'P0' ? 'JD 明确要求，答不好直接掉档' : '同方向高频考点，可能被追问';

  L.push('### ' + t.name);
  L.push('> 面试重要度：' + stars + '（' + why + '）');
  L.push('');

  // 核心概念
  L.push('#### 核心概念');
  const pts = t.points || [];
  if (pts.length) {
    for (const pt of pts) L.push('- ' + pt);
  } else {
    L.push('- 该主题的知识点尚在补充中，建议先看官方文档。');
  }
  L.push('');

  // 高频问题
  L.push('#### 面试高频问题');
  const qs = t.questions || [];
  qs.slice(0, 5).forEach((q, i) => {
    L.push('**Q' + (i + 1) + '：' + q + '**');
    L.push('');
    L.push('**答案要点：**');
    L.push('- 原理：先一句话说清它是什么、解决什么问题');
    L.push('- 取舍：说清「为什么不用另一种」，这层最能区分深度');
    L.push('- 结合项目：用你的真实经历举例（参考第 3 节）');
    L.push('- 常见坑：说一个你踩过的边界情况');
    L.push('');
  });
  if (!qs.length) L.push('_（该主题的面试问题待补充）_', '');

  // 在你的项目中
  L.push('#### 在你的项目中');
  const rel = (profile.highlights || [])
    .filter((h) => (h.dims || []).includes(dimIdOf(t, kb)) || (h.keywords || []).some((k) => t.name.includes(k)))
    .slice(0, 2);
  if (rel.length) {
    for (const h of rel) {
      L.push('- **使用场景**：' + h.text);
      L.push('- **技术亮点**：' + (h.keywords || []).slice(0, 4).join('、'));
      L.push('- **STAR 讲法**：背景（业务遇到什么问题）→ 动作（你具体做了什么）→ 结果（'
        + '提升交付效率/降低重复开发/增强稳定性，具体数字需面试前补齐）');
      L.push('');
    }
  } else {
    L.push('- 简历里没有直接对应的经历。面试时可以说「这块我在 X 项目里接触过，'
      + '当时是 Y 场景」，或者坦白说「这块我了解原理但没深度实践」。');
    L.push('');
  }

  // 追问
  L.push('#### 面试官可能追问');
  const followups = buildFollowups(t);
  followups.forEach((f, i) => {
    L.push((i + 1) + '. **' + f.q + '**　→ ' + f.a);
  });
  L.push('');

  // 伪代码
  L.push('#### 关键代码或伪代码');
  L.push('```js');
  L.push(codeSnippet(t));
  L.push('```');
  L.push('');

  // 知识图谱
  L.push('#### 知识图谱');
  const graph = buildGraph(t, kb);
  L.push('- **前置知识**：' + graph.pre);
  L.push('- **相关技术**：' + graph.rel);
  L.push('- **进阶方向**：' + graph.next);
  L.push('- **最适合关联的项目**：' + (rel[0]?.text?.slice(0, 40) || '（需你补充）'));
  L.push('');

  return L.join('\n');
}

function dimIdOf(t, kb) {
  for (const [id, group] of Object.entries(kb.dimensions || {})) {
    for (const tt of group.topics || []) {
      if (tt.name === t.name) return id;
    }
  }
  return '';
}

function buildFollowups(t) {
  const base = [
    { q: '这个方案有什么边界或失效场景？', a: '说一个具体场景，而不是「都有边界」这种空话。' },
    { q: '如果推翻重做，你会改哪一处？', a: '体现复盘能力，比背概念更能加分。' },
    { q: '怎么衡量它带来的收益？', a: '给指标口径，没数字就说「应该看哪几个指标」。' },
  ];
  const byTopic = {
    '前端工程化与构建': { q: '构建变慢了你从哪里查？', a: '先看是依赖变多、还是某一环没有缓存；用产物分析定位体积，用时间线定位耗时。' },
    'Monorepo 与多仓管理': { q: 'Monorepo 的 CI 怎么避免全量构建？', a: '按变更影响分析（affected）只构建受影响包，配远程缓存。' },
    '微前端': { q: '主子应用样式冲突怎么解？', a: '约定前缀 + Shadow DOM 隔离 + 全局样式白名单，三层递进。' },
    '性能优化': { q: 'LCP 慢你按什么顺序排查？', a: '先看网络瀑布找最大资源，再看是否被 JS 阻塞，最后看服务端响应。' },
    '大模型接入与调用': { q: '流式输出中断了怎么处理？', a: '前端增量渲染要能续接，后端要能重连；关键是别把整段内容当原子。' },
    'Prompt Engineering': { q: '输出格式不稳定怎么办？', a: '三层：强约束 + 容错解析 + 失败重试，别只依赖 Prompt。' },
  };
  const extra = byTopic[t.name];
  return extra ? [extra, ...base] : base;
}

function codeSnippet(t) {
  const map = {
    '前端工程化与构建': '// 分包 + 预加载的关键路径\nconst routes = [\n  { path: "/", component: () => import("./Home.vue") },\n  { path: "/detail", component: () => import("./Detail.vue") },\n];\n// 首屏资源 preload，非首屏懒加载',
    '性能优化': '// 长列表虚拟滚动（只渲染可视区）\nconst start = Math.floor(scrollTop / itemHeight);\nconst end = start + Math.ceil(viewport / itemHeight) + 1;\nconst visible = list.slice(start, end);\n// 用 transform 做位移，避免整表重排',
    'Monorepo 与多仓管理': '// pnpm workspace 依赖直连\n{\n  "dependencies": {\n    "@app/core": "workspace:*"\n  }\n}\n// 改 core 立刻在 app 里生效，无需发版',
    '微前端': '// qiankun 注册子应用\nregisterMicroApps([{\n  name: "sub-app",\n  entry: "//localhost:8081",\n  container: "#sub",\n  activeRule: "/sub",\n}]);\n// 沙箱隔离 JS，样式需额外处理',
    '大模型接入与调用': '// SSE 增量解析\nconst reader = res.body.getReader();\nconst dec = new TextDecoder();\nwhile (true) {\n  const { done, value } = await reader.read();\n  if (done) break;\n  buffer += dec.decode(value, { stream: true });\n  // 按 \\n\\n 切分事件，逐条处理 data:\n}',
    'Prompt Engineering': '// 三层容错解析\nfunction parseJSON(text) {\n  // 1) 从代码块提取\n  const m = text.match(/```json\\s*([\\s\\S]*?)```/);\n  if (m) return safeParse(m[1]);\n  // 2) 裸 JSON\n  const direct = safeParse(text);\n  if (direct) return direct;\n  // 3) 宽松修复：截取第一个 { 到最后一个 }\n  const s = text.indexOf("{"), e = text.lastIndexOf("}");\n  return s >= 0 && e > s ? safeParse(text.slice(s, e + 1)) : null;\n}',
  };
  return map[t.name] || '// 伪代码：\n// 1. 输入是什么、边界在哪\n// 2. 核心步骤（3-5 步）\n// 3. 失败怎么兜底\n// 面试时按这个顺序讲，比背实现更容易被认可';
}

function buildGraph(t, kb) {
  const map = {
    '前端工程化与构建': { pre: '模块系统（ESM/CJS）、打包原理', rel: 'Vite/Webpack、Tree Shaking、缓存策略', next: '构建性能分析、产物治理、CI 缓存' },
    '性能优化': { pre: '浏览器渲染流程、网络协议', rel: 'LCP/INP/CLS、懒加载、虚拟列表', next: '性能监控体系、Sentry 集成、灰度对比' },
    'Monorepo 与多仓管理': { pre: '包管理、语义化版本', rel: 'pnpm workspace、changesets、turborepo', next: '增量构建、远程缓存、发布流水线' },
    '微前端': { pre: '模块联邦、JS 沙箱', rel: 'qiankun、样式隔离、应用通信', next: '多团队协作规范、灰度发布' },
    '大模型接入与调用': { pre: 'HTTP/SSE、异步流', rel: 'OpenAI 协议、多供应商适配、Fallback', next: '成本控制、并发限流、可观测性' },
    'Prompt Engineering': { pre: '模型输出特性、token 计费', rel: '结构化输出、Few-shot、容错解析', next: '评测体系、Prompt 版本管理' },
    'Agent 与工具调用': { pre: 'Function Calling、JSON Schema', rel: 'ReAct、动作白名单、权限校验', next: '多步编排、失败重试、可解释性' },
    '微信小程序': { pre: '双线程模型、setData 机制', rel: '分包、订阅消息、登录链路', next: '性能监控、多端统一' },
    '跨端框架': { pre: '编译原理、运行时差异', rel: 'Taro/uni-app、条件编译', next: '多端一致性测试、性能对齐' },
    '权限体系设计': { pre: 'RBAC 模型、路由守卫', rel: '动态路由、按钮级权限、后端鉴权', next: '多租户、数据权限、审计日志' },
  };
  return map[t.name] || { pre: '该主题的基础概念', rel: '与之配套的常用技术', next: '可以继续深挖的方向' };
}

// ────────── 辅助 ──────────

function oneLinePositioning(profile, job) {
  const p = profile.profile || {};
  const dims = (profile.highlights || []).flatMap((h) => h.dims || []);
  const count = {};
  for (const d of dims) count[d] = (count[d] || 0) + 1;
  const top = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
  const names = {
    frontend_arch: '前端架构与工程化', ai_application: 'AI 应用落地', multi_platform: '小程序与多端',
    backend_fullstack: '全栈能力', system_design: '系统设计', leadership: '团队管理',
  };
  const main = top ? names[top[0]] || top[0] : '前端开发';
  return (p.years || 0) + ' 年经验，能力集中在「' + main + '」，应聘「' + (job.position || '') + '」时这是最该被记住的标签。';
}

function jobSummary(job, hits) {
  return '要求 ' + (job.experience || '未标注年限') + '，核心关键词：'
    + (hits.slice(0, 8).map((h) => h).join('、') || '（未识别到明确技术关键词）');
}

function topDemanded(profile, plan) {
  const dims = (plan.topics || []).slice(0, 4).map((t) => t.dimension).filter(Boolean);
  return [...new Set(dims)].join('、') || '（未识别）';
}

function selfIntro30s(profile, job) {
  const p = profile.profile || {};
  const h = (profile.highlights || [])[0];
  return (p.years || 0) + ' 年' + (p.headline || '前端') + '，'
    + (h ? h.text.replace(/[。；]$/, '') + '。' : '')
    + '看到贵司这个「' + (job.position || '') + '」岗位，'
    + '我在 ' + ((job.text || '').includes('架构') ? '架构设计' : '工程化与业务落地') + ' 上比较匹配，想具体聊聊。';
}

function extractProjects(profile) {
  const hs = profile.highlights || [];
  const projRe = /(系统|平台|小程序|工作台|后台|官网|组件库|中台|网站|App)/;
  const out = [];
  const seen = new Set();

  for (const h of hs) {
    const m = h.text.match(projRe);
    if (!m) continue;
    const name = h.text.slice(0, 26).replace(/^[- ]+/, '');
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      tech: (h.keywords || []).slice(0, 4).join('、') || '（补充技术栈）',
      highlight: h.text.slice(0, 60),
      risk: '这个项目的边界在哪？如果重做会改什么？',
      role: /主导|负责/.test(h.text) ? '主导/负责' : '参与',
    });
    if (out.length >= 5) break;
  }
  return out;
}

function buildEvidenceMap(profile, hits) {
  const hs = profile.highlights || [];
  const out = [];
  for (const kw of hits.slice(0, 10)) {
    const found = hs.find((h) => (h.keywords || []).some((k) => k === kw) || h.text.includes(kw));
    out.push({
      kw,
      evidence: found ? found.text.slice(0, 30) + '…' : '简历未体现',
      talk: found ? '按 STAR 讲这个项目里与 ' + kw + ' 相关的部分' : '面试前补一段相关经历',
      gap: found ? '无' : '需要补齐',
    });
  }
  return out;
}

export { buildRuleDoc };
