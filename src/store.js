/**
 * store.js —— 数据层（JSON 文件存储，零依赖）
 *
 * 设计说明：
 *   为什么用 JSON 文件而不是数据库？
 *   1. 这个产品是「单人使用」场景，数据量小（几百个 JD）
 *   2. 零依赖 = 谁都能 clone 下来直接跑，不需要装 MySQL/Postgres
 *   3. 数据随时可以用编辑器改、可以 git 版本管理
 *   4. 迁移到 SQLite/Postgres 只需要替换这个文件
 *
 * 并发安全：用「写时复制 + 原子重命名」避免写坏文件
 */

import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  renameSync, copyFileSync,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

/**
 * 数据目录可配置，用于跑多个实例（如：真实实例 + 公开 demo 实例）
 *   JOB_MATCHER_DATA_DIR=/opt/job-matcher/data-demo
 * 不设则用默认的 <项目根>/data
 */
export const DATA_DIR = process.env.JOB_MATCHER_DATA_DIR
  ? resolve(process.env.JOB_MATCHER_DATA_DIR)
  : resolve(ROOT, 'data');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const FILES = {
  jobs: resolve(DATA_DIR, 'jobs.json'),
  // 画像分两份：profile.json 是开源示例，profile.local.json 是私人真实画像（git 忽略）
  // 存在本地文件时优先用本地，这样开源仓库能直接跑，你自己用时又是真实数据
  profile: resolve(DATA_DIR, 'presets/profile.local.json'),
  profileFallback: resolve(DATA_DIR, 'presets/profile.json'),
};

/** 读 JSON，失败返回 fallback */
export function readJSON(path, fallback) {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.error(`[store] 读取 ${path} 失败: ${e.message}`);
    return fallback;
  }
}

/**
 * 原子写：先写临时文件，再 rename
 * 避免进程被杀时留下半个文件
 */
export function writeJSON(path, data) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);   // rename 在同一文件系统内是原子的
}

// ═══════════════════════════════════════════
// 投递状态机
// ═══════════════════════════════════════════

/**
 * 投递状态（线性推进 + 可回退）
 * 设计原则：只记录"事实发生过的状态"，不做主观预测
 */
export const APPLICATION_STATUS = {
  new:       { label: '待投递',   order: 0, color: 'gray'  },
  applied:   { label: '已投递',   order: 1, color: 'blue'  },
  viewed:    { label: '已查看',   order: 2, color: 'blue'  },
  replied:   { label: '已回复',   order: 3, color: 'green' },
  interview: { label: '约面试',   order: 4, color: 'green' },
  offer:     { label: '拿 offer', order: 5, color: 'green' },
  rejected:  { label: '被拒',     order: 6, color: 'red'   },
  dropped:   { label: '放弃',     order: 7, color: 'gray'  },
};

export function isValidStatus(s) {
  return Object.prototype.hasOwnProperty.call(APPLICATION_STATUS, s);
}

// ═══════════════════════════════════════════
// JD 存储
// ═══════════════════════════════════════════

export function loadJobs() {
  const raw = readJSON(FILES.jobs, []);
  return Array.isArray(raw) ? raw : [];
}

export function saveJobs(jobs) {
  writeJSON(FILES.jobs, jobs);
}

export function loadProfile() {
  // 优先私人画像，没有则回退到开源示例
  const local = readJSON(FILES.profile, null);
  if (local) return local;
  return readJSON(FILES.profileFallback, null);
}

/**
 * 合并同一个岗位的重复导入
 * 判断依据：公司名 + 职位名 完全一致（归一化后）
 */
function jobKey(job) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '').replace(/[（）()【】\[\]]/g, '');
  return `${norm(job.company)}|${norm(job.position)}`;
}

/** 新增或更新岗位（去重） */
export function upsertJobs(newJobs, existing) {
  const list = [...existing];
  const index = new Map(list.map((j, i) => [jobKey(j), i]));

  const added = [];
  const updated = [];

  for (const job of newJobs) {
    const key = jobKey(job);
    if (index.has(key)) {
      const i = index.get(key);
      // 保留原有状态和备注，但更新 JD 文本与评分
      list[i] = {
        ...job,
        status: list[i].status || 'new',
        note: list[i].note || '',
        appliedAt: list[i].appliedAt || '',
        statusHistory: list[i].statusHistory || [],
        firstSeenAt: list[i].firstSeenAt || list[i].createdAt,
      };
      updated.push(list[i]);
    } else {
      index.set(key, list.length);
      list.push({
        ...job,
        status: 'new',
        note: '',
        appliedAt: '',
        statusHistory: [{ status: 'new', at: new Date().toISOString() }],
        firstSeenAt: job.createdAt,
      });
      added.push(list[list.length - 1]);
    }
  }

  return { list, added, updated };
}

/** 更新岗位的投递状态 */
export function setJobStatus(jobs, id, status, note) {
  const i = jobs.findIndex((j) => j.id === id);
  if (i < 0) return null;

  const job = jobs[i];
  const now = new Date().toISOString();

  job.status = status;
  if (note !== undefined) job.note = note;

  // 记录状态变更历史（用于分析"从投递到面试的转化率"）
  // 兼容老数据：没有历史时先补一条 new 作为起点
  if (!Array.isArray(job.statusHistory)) job.statusHistory = [];
  if (job.statusHistory.length === 0) {
    job.statusHistory.push({ status: 'new', at: job.createdAt || now });
  }
  job.statusHistory.push({ status, at: now });

  // 首次标记为已投递时记录时间
  if (status === 'applied' && !job.appliedAt) job.appliedAt = now;

  jobs[i] = job;
  return job;
}

/** 统计 */
export function computeStats(jobs) {
  const byStatus = {};
  for (const s of Object.keys(APPLICATION_STATUS)) byStatus[s] = 0;
  for (const j of jobs) {
    const s = j.status || 'new';
    if (byStatus[s] !== undefined) byStatus[s] += 1;
  }

  const applied = jobs.filter((j) => (APPLICATION_STATUS[j.status]?.order || 0) >= 1 && j.status !== 'dropped');
  const replied = jobs.filter((j) => ['replied', 'interview', 'offer'].includes(j.status));
  const interviews = jobs.filter((j) => ['interview', 'offer'].includes(j.status));
  const offers = jobs.filter((j) => j.status === 'offer');

  const rate = (n, d) => (d > 0 ? Math.round((n / d) * 100) : 0);

  return {
    total: jobs.length,
    byStatus,
    appliedCount: applied.length,
    repliedCount: replied.length,
    interviewCount: interviews.length,
    offerCount: offers.length,
    // 核心转化率
    replyRate: rate(replied.length, applied.length),
    interviewRate: rate(interviews.length, applied.length),
    offerRate: rate(offers.length, applied.length),
    avgScore: jobs.length
      ? Math.round(jobs.reduce((s, j) => s + (j.total || 0), 0) / jobs.length)
      : 0,
  };
}

/** 备份（改成新的评分逻辑前调用，可回滚） */
export function backupJobs(jobs) {
  try {
    if (!existsSync(FILES.jobs)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = resolve(DATA_DIR, `jobs.backup.${stamp}.json`);
    copyFileSync(FILES.jobs, dest);
    return dest;
  } catch {
    return null;
  }
}

export { FILES };
