/**
 * stories.js —— 面试故事库（STAR 素材库）
 *
 * 竞品 Career-Ops 的核心卖点之一：故事库跨岗位累积，
 * 最终沉淀出 5-10 个能回答任意行为面试题的主线故事。
 *
 * 这里的做法：
 *   1. 从简历要点自动生成 STAR 骨架（不用 AI，靠规则拆解）
 *   2. 按 5 个类型归类：技术攻坚 / 效率提升 / 线上问题 / 团队协作 / AI 落地
 *   3. 每个故事记录被哪些岗位用过、被追问过什么
 *   4. 越用越完整 —— 用户补的数字和细节会保留下来
 *
 * 为什么这块值得做：
 *   面试失败大多不是「不会技术」，是「讲不清楚自己做过什么」。
 *   把经历提前拆成 STAR 骨架，比临时组织语言强得多。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { currentDataDir } from './store.js';
import { randomBytes } from 'node:crypto';

/** 五个故事类型 */
export const STORY_TYPES = {
  tech: { name: '技术攻坚', hint: '一个卡住团队的技术问题，你怎么定位、试了哪些方案、最后为什么选这个' },
  efficiency: { name: '效率提升', hint: '重复劳动被自动化，改造前后的人工成本对比' },
  incident: { name: '线上问题', hint: '一次故障：止血 → 定位 → 根因 → 防复发' },
  teamwork: { name: '团队协作', hint: '跨团队推进：怎么对齐目标、怎么处理分歧' },
  ai: { name: 'AI 落地', hint: '引入 AI 能力：效果怎么验证、团队怎么接受' },
};

function storiesFile() {
  return resolve(currentDataDir(), 'stories.json');
}

export function loadStories() {
  const f = storiesFile();
  if (!existsSync(f)) return [];
  try {
    const d = JSON.parse(readFileSync(f, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

export function saveStories(list) {
  const dir = currentDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storiesFile(), JSON.stringify(list, null, 2), 'utf-8');
}

/**
 * 归类：根据要点文本判断属于哪类故事
 *
 * 顺序很重要 —— 必须先匹配特征强的类别。
 * 踩过的坑：
 *   · 裸「管理」会匹配到「管理系统」，把技术条目误判成团队协作
 *   · 「主导」既可能是技术攻坚也可能是团队协作，得看有没有技术词
 */
function classify(text) {
  const t = String(text);

  // 1. AI 最优先，特征最明确
  if (/AI|大模型|模型接入|Prompt|RAG|Agent|智能|LLM|向量|Embedding/i.test(t)) return 'ai';

  // 2. 线上问题
  if (/故障|线上|事故|报警|崩溃|回滚|恢复|宕机|排查|止血|根因/.test(t)) return 'incident';

  // 3. 效率提升：必须有量化或效率语义
  if (/提升|缩短|降低|从\s*\d+\s*[^\s，,。]{0,8}(到|降)|降到|省|加速|效率|自动化|减少|耗时/.test(t)) {
    return 'efficiency';
  }

  // 4. 技术攻坚：有具体技术动作
  if (/架构|解耦|重构|性能|构建|工程化|组件库|设计系统|权限|路由|框架|微前端|Monorepo|TypeScript|Vite|Webpack|渲染|首屏|虚拟|缓存/.test(t)) {
    return 'tech';
  }

  // 5. 团队协作：团队语义（不含裸「管理」，避免「管理系统」误判）
  if (/团队|小组|协调|跨团队|跨部门|推动|推进|评审|指导|带过|带队|分工|对齐|培养|招聘/.test(t)) {
    return 'teamwork';
  }

  return 'tech';
}

/** 从一条简历要点拆出 STAR 骨架 */
function buildStar(text, type) {
  const t = String(text).trim();

  // 「背景」：从文本里找业务场景词
  const sceneMap = [
    [/中后台|后台|管理系统/, '业务系统规模变大后，模块之间耦合严重'],
    [/小程序|多端|跨端|Taro|uni-app/, '多端维护成本高，一套需求要改多次'],
    [/组件库|设计系统/, '各业务线各写一套组件，重复造轮子'],
    [/构建|工程化|Vite|Webpack|Monorepo/, '构建变慢，开发体验和发布效率受影响'],
    [/权限|路由/, '权限变更需要改代码发版，响应慢'],
    [/AI|大模型|智能|Prompt/, '业务需要 AI 能力，但不知道怎么稳定落地'],
    [/性能|渲染|滚动|首屏|LCP/, '页面性能不达标，影响用户体验'],
    [/部署|CI\/CD|Docker|镜像/, '多环境部署靠手工，容易出错'],
  ];
  let background = '';
  for (const [re, text2] of sceneMap) {
    if (re.test(t)) { background = text2; break; }
  }
  if (!background) background = '（补一句：当时业务遇到了什么问题）';

  // 「任务」：从文本找动作目标
  const action = t.replace(/^[-•·\s]+/, '');

  // 「结果」：如果有数字就提取，没有就留占位
  const nums = t.match(/从\s*[\d.]+\s*[^\s，,。]{0,6}(到|降|提升|缩短)[^\s，,。]{0,8}/g);
  const result = nums && nums.length
    ? nums.join('；')
    : '（补一个数字：提升多少 / 缩短多少 / 影响多少用户）';

  return {
    background,
    task: `需要解决「${action.slice(0, 40)}」这件事`,
    action,
    result,
  };
}

/**
 * 从简历生成候选故事
 * 不会覆盖已有故事（保留用户补的细节）
 */
export function seedStoriesFromResume(profile) {
  const existing = loadStories();
  const existingText = new Set(existing.map((s) => s.star.action));

  const added = [];
  for (const h of profile.highlights || []) {
    const text = String(h.text || '').trim();
    if (text.length < 12) continue;
    if (existingText.has(text)) continue;

    // 只要「有结果」或「有动作」的，纯描述性的跳过
    const type = classify(text);
    const star = buildStar(text, type);

    added.push({
      id: 'st_' + randomBytes(5).toString('hex'),
      type,
      title: text.slice(0, 30),
      star,
      keywords: (h.keywords || []).slice(0, 8),
      dims: h.dims || [],
      // 使用记录：被哪些岗位关联过、补过什么追问
      usedBy: [],
      followups: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      source: 'resume',
    });
  }

  if (!added.length) return { added: 0, stories: existing };

  // 每种类型最多留 4 个，优先保留带数字的
  const merged = [...existing, ...added];
  const byType = {};
  for (const s of merged) {
    byType[s.type] = byType[s.type] || [];
    byType[s.type].push(s);
  }
  const CAP = { tech: 6, efficiency: 4, incident: 4, teamwork: 4, ai: 4 };
  const trimmed = Object.values(byType).flatMap((list) =>
    list
      .sort((a, b) => (hasNumber(b) - hasNumber(a)) || (b.star.action.length - a.star.action.length))
      .slice(0, CAP[list[0]?.type] || 4)
  );

  saveStories(trimmed);
  return { added: added.length, stories: trimmed };
}

function hasNumber(s) {
  return /\d/.test(s.star?.result || '') ? 1 : 0;
}

/** 更新某个故事（用户补细节） */
export function updateStory(id, patch) {
  const list = loadStories();
  const i = list.findIndex((s) => s.id === id);
  if (i < 0) return null;

  const s = list[i];
  if (patch.star) {
    s.star = { ...s.star, ...patch.star };
  }
  if (patch.title !== undefined) s.title = String(patch.title).slice(0, 60);
  if (patch.type && STORY_TYPES[patch.type]) s.type = patch.type;
  if (Array.isArray(patch.followups)) s.followups = patch.followups.slice(0, 10).map((f) => String(f).slice(0, 200));
  s.updatedAt = new Date().toISOString();

  list[i] = s;
  saveStories(list);
  return s;
}

export function deleteStory(id) {
  const list = loadStories();
  const next = list.filter((s) => s.id !== id);
  if (next.length === list.length) return false;
  saveStories(next);
  return true;
}

/**
 * 为某个岗位挑选最相关的故事
 * 打分：关键词命中 + 维度命中 + 是否被同类岗位用过
 */
export function pickStoriesForJob(job, profile, limit = 5) {
  const list = loadStories();
  if (!list.length) return [];

  const jdHits = new Set([
    ...(job?.dimensions || []).flatMap((d) => d.hits || []),
    ...extractJdKeywords(job?.text || ''),
  ]);

  const scored = list.map((s) => {
    let score = 0;
    for (const kw of s.keywords || []) {
      if (jdHits.has(kw)) score += 6;
    }
    for (const d of s.dims || []) {
      if ((job?.dimensions || []).some((jd) => jd.id === d && jd.ratio > 0.3)) score += 4;
    }
    if (hasNumber(s)) score += 3;             // 有数字的故事优先
    if ((s.usedBy || []).length) score += 1;  // 验证过能用的
    return { ...s, _score: score };
  });

  return scored.sort((a, b) => b._score - a._score).slice(0, limit);
}

function extractJdKeywords(text) {
  const words = String(text).match(/[A-Za-z][A-Za-z0-9.+#-]{1,20}|[\u4e00-\u9fa5]{2,6}/g) || [];
  return words.slice(0, 300);
}

/** 记录某故事被某岗位使用（用于统计复用率） */
export function markStoryUsed(storyId, jobId) {
  const list = loadStories();
  const s = list.find((x) => x.id === storyId);
  if (!s) return;
  s.usedBy = s.usedBy || [];
  if (!s.usedBy.includes(jobId)) s.usedBy.push(jobId);
  s.updatedAt = new Date().toISOString();
  saveStories(list);
}

/** 统计：哪类故事最缺 */
export function storyGaps() {
  const list = loadStories();
  const count = {};
  for (const s of list) count[s.type] = (count[s.type] || 0) + 1;

  return Object.entries(STORY_TYPES).map(([key, meta]) => ({
    key,
    name: meta.name,
    hint: meta.hint,
    count: count[key] || 0,
    ok: (count[key] || 0) >= 2,
  }));
}
