#!/usr/bin/env node
/**
 * seed-demo.js —— 生成演示数据
 *
 * 用途：
 *   1. 本地体验：跑一遍就能看到完整的评分/排序/统计效果
 *   2. 线上 demo：给客户一个"有数据可看"的实例
 *
 * 用法：
 *   node scripts/seed-demo.js                     # 写入默认 data/
 *   node scripts/seed-demo.js --dir data-demo     # 写入指定目录
 *   node scripts/seed-demo.js --force             # 覆盖已有数据
 *
 * 数据说明：
 *   所有公司名、岗位、薪资均为**虚构的示例数据**，不来自任何招聘平台的实际抓取。
 *   JD 结构参照市场上常见的写法组织，用于演示评分的区分度。
 */

import { existsSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseJD } from '../src/parser.js';
import { scoreJob } from '../src/scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── 参数 ──
const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const TARGET_DIR = resolve(ROOT, getArg('--dir', 'data'));
const FORCE = args.includes('--force');

// ══════════════════════════════════════════
// 演示岗位（全部虚构）
// ══════════════════════════════════════════
//
// 设计原则：覆盖不同评级区间，让访客能直观看到
//   - 高分岗位长什么样（技能高度重合）
//   - 低分岗位为什么低（方向不符 / 层级不匹配 / 红线命中）
//   - 状态分布让漏斗统计有意义

const DEMO_JOBS = [
  {
    text: `前端负责人
公司：云枢数据安全科技（示例）
薪资：45-65K·15薪
地点：北京
经验：8-12年
学历：本科

岗位职责：
1. 负责公司数据安全合规产品线的前端团队管理与技术架构设计；
2. 主导中后台系统架构演进，推进模块化解耦与 Monorepo 工程化改造；
3. 负责企业级通用组件库与设计系统的建设与推广；
4. 参与数据可视化能力的架构设计（关系图谱、血缘追踪、大屏）；
5. 探索 AI 能力在数据安全场景的落地（大模型、RAG、智能研判）。

任职要求：
1. 8 年以上前端开发经验，3 年以上团队管理经验；
2. 精通 Vue3 + TypeScript，熟悉 Composition API 与响应式原理；
3. 有大型中后台系统架构经验，熟悉微前端（qiankun）、权限体系、动态路由；
4. 有组件库、设计系统从 0 到 1 的建设经验；
5. 熟悉前端工程化：构建优化、性能优化、CI/CD、多环境部署；
6. 有 AI 应用落地经验者优先；
7. 有数据安全、金融、企业服务行业背景者优先。`,
    status: 'interview',
    note: '一面已过，等二面。重点准备了架构解耦和组件库建设两块。',
    daysAgo: 12,
  },
  {
    text: `高级前端工程师（AI 应用方向）
公司：知微智能（示例）
薪资：40-60K·期权
地点：北京
经验：5-10年
学历：本科

我们在做面向企业的 AI 助手产品，需要一位既懂前端工程又能落地 AI 能力的工程师。

岗位职责：
1. 负责 AI 助手产品的前端架构与核心模块开发；
2. 负责大模型能力的接入与体验优化：流式输出、多轮对话、上下文管理；
3. 建设 RAG 检索结果的呈现与引用溯源交互；
4. 参与 MCP 协议相关的前端集成方案设计；
5. 推动 AI Coding 工具链在团队内的落地（Claude Code / Cursor）。

任职要求：
1. 5 年以上前端经验，精通 Vue3 或 React 其一，TypeScript 熟练；
2. 有大模型 API 对接经验，理解 Prompt Engineering 与结构化输出约束；
3. 熟悉流式渲染、SSE、Markdown 增量解析等对话类产品常见技术；
4. 对 AI Agent、Function Calling、RAG 有实践经验或深入理解；
5. 有工程化意识，熟悉组件化、模块化、构建优化；
6. 有浏览器端推理（WebLLM / ONNX Runtime）经验者优先。`,
    status: 'applied',
    note: '这家技术方向最匹配，投完第三天显示已查看。',
    daysAgo: 5,
  },
  {
    text: `高级前端工程师
公司：恒信金融科技（示例）
薪资：38-55K·15薪
地点：北京
经验：5-10年
学历：本科

岗位职责：
1. 负责核心业务系统（信贷审批、风控管理）的前端架构设计与开发；
2. 使用 Vue3 + TypeScript 构建中后台系统，负责复杂表单、权限、审批流；
3. 参与微前端架构落地，负责子系统拆分与接入；
4. 负责前端性能优化与构建优化，提升交付效率；
5. 参与 AI 辅助功能在前端的接入（智能填单、合同信息提取）。

任职要求：
1. 5 年以上前端开发经验，精通 Vue 技术栈；
2. 熟悉中后台系统常见复杂度：动态表单、权限控制、数据可视化；
3. 有微前端（qiankun / Module Federation）实践经验；
4. 熟悉 Vite / Webpack 构建配置与优化；
5. 有金融行业背景、熟悉数据安全合规要求者优先；
6. 有 AI 应用接入经验者优先。`,
    status: 'offer',
    note: '已拿到 offer，薪资给到 52K·15薪。作为保底选项。',
    daysAgo: 20,
  },
  {
    text: `前端开发工程师（小程序 / 多端）
公司：拾光教育科技（示例）
薪资：28-40K
地点：北京
经验：3-5年
学历：本科

岗位职责：
1. 负责公司微信小程序矩阵的开发与迭代（课程、商城、社区）；
2. 使用 Taro 或 uni-app 实现一套代码多端投放（小程序 / H5 / App）；
3. 负责微信生态能力接入：登录、支付、订阅消息、JSSDK；
4. 与产品、设计配合，持续优化转化漏斗与页面性能。

任职要求：
1. 3 年以上前端经验，有完整小程序项目经验；
2. 熟悉微信小程序原生开发，了解生命周期、分包、性能优化；
3. 有 Taro 或 uni-app 跨端框架经验；
4. 熟悉 Vue2 / Vue3，理解组件化开发；
5. 有 C 端产品、增长投放相关经验者优先。`,
    status: 'applied',
    note: '技能完全匹配，但岗位年限偏低，可能 overqualified。',
    daysAgo: 8,
  },
  {
    text: `前端技术专家（平台与基建）
公司：北辰云（示例）
薪资：55-80K·16薪
地点：北京
经验：8年以上
学历：本科及以上

岗位职责：
1. 负责公司前端基础设施的建设与演进（构建体系、发布体系、监控体系）；
2. 主导前端技术标准与最佳实践的制定；
3. 负责 Node.js BFF 层的设计与优化；
4. 推动研发效能提升（CI/CD、灰度发布、质量门禁）；
5. 参与跨团队技术方案评审与技术选型。

任职要求：
1. 8 年以上前端经验，有大型系统基础设施建设经验；
2. 精通前端工程化全链路：构建、打包、发布、监控、性能；
3. 熟悉 Node.js 服务端开发，有 BFF 实践经验；
4. 有微前端、Monorepo、组件库等基建项目主导经验；
5. 对前端技术趋势有判断力，能推动技术演进；
6. 有团队管理或技术带教经验。`,
    status: 'replied',
    note: 'HR 回复说岗位偏基建，问是否有 Node 服务端深度经验。',
    daysAgo: 15,
  },
  {
    text: `中后台前端开发工程师
公司：瑞和企服（示例）
薪资：22-32K
地点：北京
经验：3-5年
学历：大专及以上

岗位职责：
1. 负责公司 SaaS 管理后台的页面开发与迭代；
2. 使用 Vue2 / Vue3 + Element UI 完成业务需求；
3. 配合后端完成接口联调与问题排查。

任职要求：
1. 3 年以上前端开发经验；
2. 熟悉 Vue 技术栈与 Element UI；
3. 有中后台管理系统开发经验；
4. 沟通顺畅，能承担一定的需求沟通工作。`,
    status: 'rejected',
    note: '面试后反馈"经验超出岗位预期"，实际是薪资给不到。',
    daysAgo: 25,
  },
  {
    text: `资深 React 前端工程师
公司：星链互娱（示例）
薪资：45-70K·16薪
地点：北京
经验：5年以上
学历：本科

岗位职责：
1. 负责公司核心 ToC 产品（日活百万级）的前端开发；
2. 使用 React 18 + TypeScript 构建高性能交互页面；
3. 负责首屏性能、交互流畅度的极致优化；
4. 参与 SSR 架构（Next.js）的落地与优化。

任职要求：
1. 5 年以上前端经验，精通 React 及生态（Redux/Zustand、React Router）；
2. 深刻理解 React 渲染机制、Hooks 原理、并发特性；
3. 有大型 ToC 产品的高并发、高性能优化经验；
4. 熟悉 SSR、Next.js、同构渲染；
5. 有 Flutter 或 React Native 跨端经验者优先。

（注：本岗位技术栈为 React，与示例画像的 Vue 方向不同，用于演示"方向不符"的评分效果）`,
    status: 'new',
    note: '',
    daysAgo: 2,
  },
  {
    text: `前端开发工程师（外包驻场）
公司：宏图人力服务（示例）
薪资：15-22K
地点：北京
经验：1-3年
学历：不限

1. 使用 Vue2 开发银行内部管理系统页面；
2. 按甲方需求完成页面搭建与数据对接；
3. 完成项目经理安排的其他工作。

（注：外包驻场类岗位，用于演示红线命中后的评分效果）`,
    status: 'dropped',
    note: '外包驻场，直接放弃。',
    daysAgo: 18,
  },
  {
    text: `小程序与多端负责人
公司：悦读文化（示例）
薪资：35-50K
地点：北京
经验：5-8年
学历：本科

岗位职责：
1. 负责公司阅读类小程序矩阵的技术负责人角色；
2. 主导 Taro2 → Taro3 / uni-app 的技术选型与迁移；
3. 负责小程序底层框架、多环境构建、公共组件库建设；
4. 负责企业微信侧工具的建设（客服工作台、运营后台）；
5. 带领 2-3 人小组完成交付。

任职要求：
1. 5 年以上前端经验，3 年以上小程序开发经验；
2. 精通 Taro 或 uni-app，有跨端框架底层使用与调优经验；
3. 熟悉微信生态：登录、支付、订阅消息、JSSDK、开放平台；
4. 有企业微信、公众号、H5 多端适配经验；
5. 有框架搭建、组件库沉淀经验者优先；
6. 有内容、阅读、社区类产品经验者优先。`,
    status: 'interview',
    note: '二面聊了 Taro 迁移方案，对方很认可框架建设经验。',
    daysAgo: 10,
  },
  {
    text: `前端开发工程师
公司：明德医疗信息（示例）
薪资：30-45K
地点：北京
经验：5-8年
学历：本科

岗位职责：
1. 负责医院信息系统（HIS）与互联网医院平台的前端开发；
2. 负责医疗数据可视化（患者流向、诊疗指标看板）；
3. 参与前端组件库建设与工程化改进。

任职要求：
1. 5 年以上前端经验，熟悉 Vue3 + TypeScript；
2. 有数据可视化经验（ECharts / AntV）；
3. 熟悉中后台系统开发；
4. 有医疗、政务行业经验者优先；
5. 了解数据安全与隐私合规要求者优先。`,
    status: 'viewed',
    note: '',
    daysAgo: 6,
  },
  {
    text: `Web 前端工程师（AI 工具方向）
公司：灵犀工具（示例）
薪资：32-48K
地点：北京
经验：3-6年
学历：本科

我们在做面向开发者的 AI 工具产品，希望你既能写前端，又对 AI 工具有热情。

岗位职责：
1. 负责 AI 工具类 Web 产品的前端开发（编辑器、对话、工作流编排）；
2. 负责复杂交互的实现：拖拽编排、代码编辑器集成、实时预览；
3. 参与 AI 能力接入与 Prompt 效果调优；
4. 参与组件库与设计规范建设。

任职要求：
1. 3 年以上前端经验，熟练掌握 Vue3 或 React；
2. 有复杂 Web 应用开发经验（编辑器、画布、低代码等方向优先）；
3. 对 AI 工具、AI Coding 有实际使用经验与理解；
4. 有 Prompt Engineering 经验者优先；
5. 有 Node.js 全栈能力者优先。`,
    status: 'new',
    note: '',
    daysAgo: 1,
  },
  {
    text: `前端架构师
公司：玖安网络（示例）
薪资：50-75K
地点：北京
经验：8年以上
学历：本科

岗位职责：
1. 负责多业务线前端架构的统一规划与治理；
2. 主导微前端体系建设与跨团队技术协同；
3. 负责前端性能与稳定性治理体系；
4. 负责前端团队的梯队建设与技术培养。

任职要求：
1. 8 年以上前端经验，有大型组织架构治理经验；
2. 精通微前端、Monorepo、组件库等体系化建设；
3. 有跨业务线技术整合经验；
4. 有 5 人以上团队管理经验；
5. 有开源项目或技术影响力者优先。`,
    status: 'new',
    note: '',
    daysAgo: 3,
  },
];

// ══════════════════════════════════════════
// 执行
// ══════════════════════════════════════════

function main() {
  const jobsFile = resolve(TARGET_DIR, 'jobs.json');
  const profileFile = resolve(TARGET_DIR, 'presets/profile.json');
  const sourceProfile = resolve(ROOT, 'data/presets/profile.json');

  // 1. 准备目录
  if (!existsSync(resolve(TARGET_DIR, 'presets'))) {
    mkdirSync(resolve(TARGET_DIR, 'presets'), { recursive: true });
  }

  // 2. 已有数据时检查
  if (existsSync(jobsFile) && !FORCE) {
    console.error('');
    console.error(`  ✗ 目标目录已有岗位数据：${jobsFile}`);
    console.error('    如需覆盖，请加 --force');
    console.error('');
    process.exit(1);
  }

  // 3. 准备画像
  //    - 目标目录没有画像 → 从默认示例复制
  //    - 带 --force → 也从默认示例刷新（保证 demo 用的是最新关键词表）
  const needProfile = !existsSync(profileFile) || FORCE;
  if (needProfile) {
    if (!existsSync(sourceProfile)) {
      console.error(`  ✗ 找不到画像模板：${sourceProfile}`);
      process.exit(1);
    }
    copyFileSync(sourceProfile, profileFile);
    console.log(`  画像已${existsSync(profileFile) ? '刷新' : '复制'}：${profileFile}`);
  }

  const profile = JSON.parse(readFileSync(profileFile, 'utf-8'));

  // 4. 解析 + 评分
  const now = Date.now();
  const jobs = DEMO_JOBS.map((item, i) => {
    const parsed = parseJD(item.text);
    const scored = scoreJob(parsed, profile);

    const createdAt = new Date(now - item.daysAgo * 86400_000).toISOString();

    // 状态历史：从 new 开始，逐步推进到目标状态
    const ORDER = ['new', 'applied', 'viewed', 'replied', 'interview', 'offer'];
    const targetIdx = ORDER.indexOf(item.status);
    const history = [{ status: 'new', at: createdAt }];

    if (targetIdx > 0) {
      for (let s = 1; s <= targetIdx; s++) {
        const offsetDays = item.daysAgo - Math.floor((s / targetIdx) * (item.daysAgo * 0.6));
        history.push({
          status: ORDER[s],
          at: new Date(now - Math.max(0, item.daysAgo - s * 2) * 86400_000).toISOString(),
        });
      }
    } else if (item.status === 'rejected' || item.status === 'dropped') {
      history.push({ status: 'applied', at: new Date(now - (item.daysAgo - 2) * 86400_000).toISOString() });
      history.push({ status: item.status, at: new Date(now - 1 * 86400_000).toISOString() });
    }

    return {
      id: `demo_${String(i + 1).padStart(3, '0')}`,
      company: scored.company,
      position: scored.position,
      salary: scored.salary,
      city: scored.city,
      experience: scored.experience,
      education: scored.education,
      link: '',
      text: scored.text,
      createdAt,
      total: scored.total,
      grade: scored.grade,
      gradeLabel: scored.gradeLabel,
      workMode: scored.workMode,
      dimensions: scored.breakdown.dimensions.map((d) => ({
        id: d.id,
        name: d.name,
        weight: d.weight,
        score: Number(d.score.toFixed(1)),
        ratio: Number(d.ratio.toFixed(3)),
        hits: d.hits.slice(0, 8),
      })),
      domainHits: scored.breakdown.domainHits,
      pluses: scored.breakdown.pluses,
      negatives: scored.breakdown.negatives,
      years: scored.breakdown.years,
      level: scored.breakdown.level,
      strengths: scored.strengths.map((x) => ({ name: x.name, hits: x.hits.slice(0, 5) })),
      weaknesses: scored.weaknesses,
      // 演示用的投递状态
      status: item.status,
      note: item.note,
      appliedAt: targetIdx > 0 || item.status === 'rejected'
        ? history.find((h) => h.status === 'applied')?.at || ''
        : '',
      statusHistory: history,
      firstSeenAt: createdAt,
    };
  });

  // 5. 写入
  writeFileSync(jobsFile, JSON.stringify(jobs, null, 2), 'utf-8');

  // 6. 输出摘要
  const byGrade = {}
  for (const j of jobs) byGrade[j.grade] = (byGrade[j.grade] || 0) + 1;

  const byStatus = {};
  for (const j of jobs) byStatus[j.status] = (byStatus[j.status] || 0) + 1;

  const applied = jobs.filter((j) => ['applied','viewed','replied','interview','offer','rejected'].includes(j.status)).length;
  const replied = jobs.filter((j) => ['replied','interview','offer'].includes(j.status)).length;
  const interview = jobs.filter((j) => ['interview','offer'].includes(j.status)).length;
  const offer = jobs.filter((j) => j.status === 'offer').length;

  console.log('');
  console.log('  ╔════════════════════════════════════════════╗');
  console.log('  ║   演示数据已生成                          ║');
  console.log('  ╚════════════════════════════════════════════╝');
  console.log('');
  console.log(`  数据目录  ${TARGET_DIR}`);
  console.log(`  岗位数     ${jobs.length}`);
  console.log('');
  console.log('  评级分布  ' + Object.entries(byGrade).sort().map(([g, n]) => `${g}:${n}`).join('  '));
  console.log('  状态分布  ' + Object.entries(byStatus).map(([s, n]) => `${s}:${n}`).join('  '));
  console.log('');
  console.log(`  投递漏斗  已投 ${applied} → 回复 ${replied} (${Math.round(replied/applied*100)}%) → 面试 ${interview} (${Math.round(interview/applied*100)}%) → offer ${offer}`);
  console.log('');
  console.log('  提示：所有公司与岗位均为虚构示例，不来自任何招聘平台抓取。');
  console.log('');
}

main();
