/**
 * versions.js —— 定制简历版本
 *
 * 一个岗位可以生成多版简历（比如两次调整），只保留有意义的几版。
 * 参考原项目 resume-ai-optimize 的 ResumeVersion 设计：
 *   - 每版记录「为哪个岗位生成」
 *   - isSelected 标记当前采用（不删旧版，可回退）
 *   - 自动清理未采用版本，只留最近 6 个
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { currentDataDir } from './store.js';

const MAX_UNSELECTED = 6;

function file() {
  return resolve(currentDataDir(), 'versions.json');
}

export function loadVersions() {
  const f = file();
  if (!existsSync(f)) return [];
  try {
    const d = JSON.parse(readFileSync(f, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

export function saveVersions(list) {
  const dir = currentDataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file(), JSON.stringify(list, null, 2), 'utf-8');
}

/** 存一版 */
export function addVersion({ jobId, jobTitle, company, markdown, coverage, stats }) {
  const list = loadVersions();

  // 同一岗位、内容完全一致 → 不新增，直接返回已有的
  // （连续点几次「生成简历」不该刷出 5 个一模一样的版本）
  const same = list.find((v) => v.jobId === jobId && v.markdown === markdown);
  if (same) {
    return { version: publicVersion(same, true), dropped: 0, reused: true };
  }

  const v = {
    id: 'rv_' + randomBytes(6).toString('hex'),
    jobId,
    jobTitle: String(jobTitle || '').slice(0, 60),
    company: String(company || '').slice(0, 40),
    markdown,
    coverage: Number(coverage) || 0,
    stats: stats || null,
    isSelected: false,
    createdAt: new Date().toISOString(),
  };

  list.push(v);

  // 清理：未采用的最多留 6 个（从旧到新删）
  const unselected = list.filter((x) => !x.isSelected).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  const toDrop = new Set(unselected.slice(0, Math.max(0, unselected.length - MAX_UNSELECTED)).map((x) => x.id));

  const kept = list.filter((x) => !toDrop.has(x.id));
  saveVersions(kept);
  return { version: publicVersion(v, true), dropped: toDrop.size };
}

export function getVersion(id) {
  return loadVersions().find((v) => v.id === id) || null;
}

/** 采用某一版（同一岗位只保留一个 selected） */
export function selectVersion(id) {
  const list = loadVersions();
  const target = list.find((v) => v.id === id);
  if (!target) return null;

  for (const v of list) {
    if (v.jobId === target.jobId) v.isSelected = v.id === id;
  }
  saveVersions(list);
  return publicVersion(target, false);
}

export function deleteVersion(id) {
  const list = loadVersions();
  const next = list.filter((v) => v.id !== id);
  if (next.length === list.length) return false;
  saveVersions(next);
  return true;
}

/** 列表不返回全文，避免响应过大 */
export function publicVersion(v, includeMarkdown) {
  const out = {
    id: v.id,
    jobId: v.jobId,
    jobTitle: v.jobTitle,
    company: v.company,
    coverage: v.coverage,
    isSelected: v.isSelected,
    createdAt: v.createdAt,
    charCount: (v.markdown || '').length,
    stats: v.stats,
  };
  if (includeMarkdown) out.markdown = v.markdown;
  return out;
}
