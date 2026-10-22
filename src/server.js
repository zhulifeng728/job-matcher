/**
 * server.js —— HTTP 服务层
 *
 * 安全设计（依据 OWASP 与本项目约束）：
 *   1. 默认只监听 127.0.0.1，由 Nginx 反代；不直接对公网暴露
 *   2. 设置 JOB_MATCHER_TOKEN 后所有 /api/* 需鉴权，token 走 httpOnly Cookie
 *   3. API Key 只从环境变量读取，永不返回给前端
 *   4. 所有写操作做输入校验（白名单枚举 + 长度限制）
 *   5. 双层限流：全局限流 + AI 接口日配额
 *   6. 安全响应头：CSP / X-Frame-Options / nosniff / Referrer-Policy
 *   7. 错误信息对外泛化，详细堆栈只进服务端日志
 */

import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual, createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { parseJD, parseBatch } from './parser.js';
import { scoreJob } from './scoring.js';
import {
  loadJobs, saveJobs, loadProfile, saveProfile, hasOwnProfile, upsertJobs, setJobStatus, readJSON,
  computeStats, backupJobs, APPLICATION_STATUS, isValidStatus,
} from './store.js';
import {
  isAIEnabled, getAIPublicStatus, generateGreeting, generateAdvice,
  generateBatch, testConnection, listProviders,
} from './ai.js';
import { tailorResume, buildStudyPlan } from './tailor.js';
import { generatePrepDoc, hasAI } from './deep-prep.js';
import { renderMarkdown } from './markdown.js';
import { buildStrategy } from './level.js';
import { calibrate, analyzeOutcomes, currentWeightOf } from './calibrate.js';
import { extractKeywords, generateResume, renderPrintableHTML } from './generate.js';
import { buildLearningPlan, summarizePlan } from './learn.js';
import {
  addVersion, loadVersions, getVersion, selectVersion, deleteVersion, publicVersion,
} from './versions.js';
import {
  loadStories, seedStoriesFromResume, updateStory, deleteStory,
  pickStoriesForJob, storyGaps, STORY_TYPES, markStoryUsed,
} from './stories.js';
import {
  registerUser, verifyUser, publicUser, userFromRequest,
  issueSession, sessionCookie, clearSessionCookie, userContext,
  hasUsers, userDataDir, getUserById,
  createToken, listTokens, revokeToken, verifyBearer, bearerFromRequest, currentUser,
} from './auth.js';
import { parseResume, buildProfileFromResume, summarizeImport } from './resume.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PUBLIC_DIR = resolve(ROOT, 'public');

const PORT = Number(process.env.JOB_MATCHER_PORT || 7788);
const HOST = process.env.JOB_MATCHER_HOST || '127.0.0.1';
const TOKEN = process.env.JOB_MATCHER_TOKEN || '';
const AI_DAILY_LIMIT = Number(process.env.JOB_MATCHER_AI_DAILY_LIMIT || 200);

// 输入上限（防内存打爆）
const LIMITS = {
  bodyBytes: 4 * 1024 * 1024,   // 4MB
  textChars: 800_000,           // 单次提交 JD 文本上限
  noteChars: 2000,
  batchMax: 200,                // 单次批量导入上限
};

// ═══════════════════════ 鉴权 ═══════════════════════

/** 常量时间比较（防时序侧信道） */
function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);   // 定长摘要，长度恒等
}

/** 从请求提取 token（Header 或 httpOnly Cookie） */
function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();

  const cookie = req.headers.cookie || '';
  const m = cookie.match(/(?:^|;\s*)jm_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 是否通过鉴权（未设 TOKEN 时视为本地模式，全部放行） */
function isAuthed(req) {
  if (!TOKEN) return true;
  const t = extractToken(req);
  return t ? safeEqual(t, TOKEN) : false;
}

/** 判断是否走 HTTPS（反代透传的协议头） */
function isSecureRequest(req) {
  return (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    || Boolean(req.socket?.encrypted);
}

function buildAuthCookie(req) {
  const parts = [
    `jm_token=${encodeURIComponent(TOKEN)}`,
    'Path=/',
    'HttpOnly',          // 阻断 JS 读取，防 XSS 窃取
    'SameSite=Strict',   // 防 CSRF
    'Max-Age=2592000',   // 30 天
  ];
  if (isSecureRequest(req)) parts.push('Secure');   // 仅 HTTPS 下传输
  return parts.join('; ');
}

// ═══════════════════════ 限流 ═══════════════════════

/**
 * 令牌桶限流（按 IP）
 * 全局限流防滥用；AI 接口另有日配额
 */
const rateBuckets = new Map();
const RATE = {
  windowMs: 60_000,
  maxReq: Number(process.env.JOB_MATCHER_RATE_LIMIT || 120),   // 每分钟
  aiMaxReq: 20,                                                // AI 接口每分钟
};

function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function checkRate(key, max) {
  const now = Date.now();
  let b = rateBuckets.get(key);

  if (!b || now - b.start > RATE.windowMs) {
    b = { start: now, count: 0 };
    rateBuckets.set(key, b);
  }
  b.count += 1;
  return { ok: b.count <= max, count: b.count, max };
}

// 定期清理过期桶，防内存泄漏
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (now - b.start > RATE.windowMs * 3) rateBuckets.delete(k);
  }
}, 300_000).unref();

// ═══════════════════════ AI 日配额 ═══════════════════════

const quota = { day: '', count: 0 };

function consumeAIQuota() {
  const today = new Date().toISOString().slice(0, 10);
  if (quota.day !== today) { quota.day = today; quota.count = 0; }

  if (quota.count >= AI_DAILY_LIMIT) {
    return {
      ok: false,
      message: `今日 AI 调用已达上限（${AI_DAILY_LIMIT} 次），明日自动重置；可用 JOB_MATCHER_AI_DAILY_LIMIT 调整`,
    };
  }
  quota.count += 1;
  return { ok: true, remain: AI_DAILY_LIMIT - quota.count };
}

function quotaStatus() {
  const today = new Date().toISOString().slice(0, 10);
  if (quota.day !== today) return { used: 0, limit: AI_DAILY_LIMIT, remain: AI_DAILY_LIMIT };
  return { used: quota.count, limit: AI_DAILY_LIMIT, remain: AI_DAILY_LIMIT - quota.count };
}

// ═══════════════════════ 输入校验 ═══════════════════════

/** 统一取字符串并限长，非字符串返回 '' */
function str(v, max = 1000) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) : v;
}

/** 校验 JD 文本，返回 { ok, text, error } */
function validateJDText(raw) {
  const text = str(raw, LIMITS.textChars);
  if (!text.trim()) return { ok: false, error: '文本为空' };
  if (text.trim().length < 20) return { ok: false, error: 'JD 内容太短（少于 20 字），可能粘贴不完整' };
  return { ok: true, text };
}

function validateId(raw) {
  const id = str(raw, 120);
  // 只允许字母数字下划线连字符，防路径/注入类问题
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return { ok: false, error: '非法的 id' };
  return { ok: true, id };
}

// ═══════════════════════ HTTP 工具 ═══════════════════════

/** 安全响应头 */
function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",   // 单文件前端，内联脚本；无外部脚本
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; ')
  );
}

function json(res, data, status = 200) {
  if (!res.headersSent) {
    setSecurityHeaders(res);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;

    req.on('data', (chunk) => {
      if (aborted) return;
      size += chunk.length;
      if (size > LIMITS.bodyBytes) {
        aborted = true;
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ text: raw });
      }
    });

    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;

  // 目录穿越防护：resolve 后必须仍在 public 内
  const full = resolve(PUBLIC_DIR, '.' + rel);
  if (!full.startsWith(PUBLIC_DIR + '/') && full !== resolve(PUBLIC_DIR, 'index.html')) {
    setSecurityHeaders(res);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }

  if (existsSync(full)) {
    setSecurityHeaders(res);
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Cache-Control': extname(full) === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    return res.end(readFileSync(full));
  }

  // SPA 回退
  const idx = resolve(PUBLIC_DIR, 'index.html');
  if (existsSync(idx)) {
    setSecurityHeaders(res);
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
    return res.end(readFileSync(idx));
  }

  setSecurityHeaders(res);
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

// ═══════════════════════ 业务辅助 ═══════════════════════

/** 精简存储结构（去掉不需要持久化的中间字段） */
function sliceForStorage(s) {
  return {
    id: s.id,
    company: s.company,
    position: s.position,
    salary: s.salary,
    city: s.city,
    experience: s.experience,
    education: s.education,
    link: s.link,
    text: s.text,
    createdAt: s.createdAt,
    total: s.total,
    grade: s.grade,
    gradeLabel: s.gradeLabel,
    workMode: s.workMode,
    dimensions: s.breakdown.dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      weight: d.weight,
      score: Number(d.score.toFixed(1)),
      ratio: Number(d.ratio.toFixed(3)),
      hits: d.hits.slice(0, 8),
    })),
    domainHits: s.breakdown.domainHits,
    pluses: s.breakdown.pluses,
    negatives: s.breakdown.negatives,
    years: s.breakdown.years,
    level: s.breakdown.level,
    strengths: s.strengths.map((x) => ({ name: x.name, hits: x.hits.slice(0, 5) })),
    weaknesses: s.weaknesses,
  };
}

function salaryRank(salary) {
  const m = String(salary || '').match(/(\d{1,3})\s*[-~到]\s*(\d{1,3})\s*[kK]/);
  if (m) return (Number(m[1]) + Number(m[2])) / 2;
  const one = String(salary || '').match(/(\d{1,3})\s*[kK]/);
  return one ? Number(one[1]) : 0;
}

// ═══════════════════════ DOCX 文本提取 ═══════════════════════

/**
 * 从 .docx 里提取纯文本（零依赖）
 *
 * .docx 本质是 zip，正文在 word/document.xml。
 * 这里手写最小 zip 解析：只读中央目录，找到目标条目，
 * 用 zlib.inflateRawSync 解压，再剥掉 XML 标签。
 */
function extractDocxText(base64) {
  const buf = Buffer.from(String(base64), 'base64');
  if (buf.length < 100 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('不是有效的 docx 文件');
  }

  // 找 End of Central Directory（EOCD 在末尾，签名 0x06054b50）
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 结构不完整');

  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  let target = null;

  for (let n = 0; n < cdCount; n++) {
    if (buf.readUInt32LE(cdOffset) !== 0x02014b50) break;

    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.slice(cdOffset + 46, cdOffset + 46 + nameLen).toString('utf-8');

    if (name === 'word/document.xml') {
      target = { localOffset };
      break;
    }
    cdOffset += 46 + nameLen + extraLen + commentLen;
  }

  if (!target) throw new Error('docx 里没找到正文（可能是 .doc 旧格式，请另存为 .docx）');

  // 读本地文件头，定位数据起点
  const lo = target.localOffset;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('zip 条目损坏');

  const lNameLen = buf.readUInt16LE(lo + 26);
  const lExtraLen = buf.readUInt16LE(lo + 28);
  const compSize = buf.readUInt32LE(lo + 18);
  const dataStart = lo + 30 + lNameLen + lExtraLen;

  const compressed = buf.slice(dataStart, dataStart + compSize);
  let xml;
  try {
    xml = inflateRawSync(compressed).toString('utf-8');
  } catch {
    xml = compressed.toString('utf-8');   // 未压缩存储的情况
  }

  // 段落 → 换行；制表 → 空格；剥标签
  return xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<w:tab[^>]*\/>/g, '\t')
    .replace(/<w:br[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ═══════════════════════ 路由表 ═══════════════════════

const routes = {
  // ─────────── 公开（无需鉴权）───────────

  'GET /api/health': async () => ({
    ok: true,
    uptime: Math.round(process.uptime()),
    version: '1.0.0',
  }),

  'GET /api/auth/required': async (q, p, b, req) => ({
    required: Boolean(TOKEN),
    authed: isAuthed(req),
  }),

  // ─────────── 账号 ───────────

  /** 注册 */
  'POST /api/auth/register': async (q, p, body, req, res) => {
    const rl = checkRate(`reg:${clientIp(req)}`, 10);
    if (!rl.ok) return { error: '尝试过于频繁，请稍后再试', status: 429 };

    const r = registerUser(body.username, body.password, body.displayName);
    if (!r.ok) return { error: r.error, status: 400 };

    const token = issueSession(r.user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return { ok: true, user: r.user };
  },

  /** 登录 */
  'POST /api/auth/login': async (q, p, body, req, res) => {
    const rl = checkRate(`login:${clientIp(req)}`, 15);
    if (!rl.ok) return { error: '尝试过于频繁，请稍后再试', status: 429 };

    const r = verifyUser(body.username, body.password);
    if (!r.ok) return { error: r.error, status: 401 };

    const token = issueSession(r.user.id);
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return { ok: true, user: r.user };
  },

  /** 退出 */
  'POST /api/auth/logout': async (q, p, b, req, res) => {
    res.setHeader('Set-Cookie', clearSessionCookie());
    return { ok: true };
  },

  /** 当前登录态 + 是否需要先导入简历 */
  'GET /api/auth/me': async (q, p, b, req) => {
    const user = userFromRequest(req);
    if (!user) return { user: null, hasResume: false };

    // 在用户上下文里检查画像
    return userContext.run({ userId: user.id }, async () => ({
      user,
      hasResume: hasOwnProfile(),
      jobCount: loadJobs().length,
    }));
  },

  /** 旧口令登录（保留兼容，多用户模式下停用） */
  'POST /api/auth/token': async (q, p, body, req, res) => {
    if (!TOKEN) return { ok: true, message: '未启用访问口令' };
    const input = str(body.token, 200).trim();
    if (!input || !safeEqual(input, TOKEN)) return { error: '口令错误', status: 401 };
    res.setHeader('Set-Cookie', buildAuthCookie(req));
    return { ok: true };
  },

  // ─────────── 简历 ───────────

  /** 读取当前用户的画像（含简历摘要） */
  'GET /api/resume': async () => {
    const p = loadProfile();
    if (!p) return { imported: false };
    return {
      imported: hasOwnProfile(),
      summary: summarizeImport(p),
      profile: p.profile,
      highlights: p.highlights || [],
      meta: p.meta || {},
    };
  },

  /** 导入简历：纯文本 或 .docx 的 base64 */
  'POST /api/resume': async (q, p, body) => {
    let text = str(body.text, 200_000);

    // 支持 .docx（zip 里的 word/document.xml）
    if (!text && body.docxBase64) {
      try {
        text = extractDocxText(String(body.docxBase64));
      } catch (e) {
        return { error: 'DOCX 解析失败：' + e.message, status: 400 };
      }
    }

    if (!text || !text.trim()) return { error: '简历内容为空', status: 400 };
    if (text.trim().length < 80) return { error: '简历内容太短，至少 80 字才能有效解析', status: 400 };

    const parsed = parseResume(text);
    const template = readJSON(resolve(__dirname, '../data/presets/profile.json'), null);
    if (!template) return { error: '画像模板缺失', status: 500 };

    const profile = buildProfileFromResume(parsed, template);
    saveProfile(profile);

    return {
      ok: true,
      summary: summarizeImport(profile),
      highlights: profile.highlights,
      meta: profile.meta,
    };
  },

  /** 手动修正画像基础信息（年限、城市等） */
  'PATCH /api/resume': async (q, p, body) => {
    const prof = loadProfile();
    if (!prof) return { error: '还没有导入简历', status: 400 };

    if (body.name !== undefined) prof.profile.name = str(body.name, 40);
    if (body.years !== undefined) prof.profile.years = Math.max(0, Math.min(50, Number(body.years) || 0));
    if (body.city !== undefined) prof.profile.currentCity = str(body.city, 20);
    if (body.headline !== undefined) prof.profile.headline = str(body.headline, 80);

    saveProfile(prof);
    return { ok: true, summary: summarizeImport(prof) };
  },

  // ─────────── 扩展令牌 ───────────

  /** 列出我的扩展令牌 */
  'GET /api/tokens': async () => {
    const user = currentUser();
    if (!user) return { error: '请先用账号登录再管理令牌', status: 401 };
    return { tokens: listTokens(user.id) };
  },

  /** 新建令牌（明文只返回一次） */
  'POST /api/tokens': async (q, p, body, req) => {
    const user = currentUser();
    if (!user) return { error: '请先用账号登录再管理令牌', status: 401 };
    const rl = checkRate(`token:${clientIp(req)}`, 10);
    if (!rl.ok) return { error: '操作过于频繁', status: 429 };

    const r = createToken(user.id, body.name);
    return { ok: true, token: r.token, record: r.record };
  },

  /** 撤销令牌 */
  'DELETE /api/tokens/:id': async (q, params) => {
    const user = currentUser();
    if (!user) return { error: '请先登录', status: 401 };
    const ok = revokeToken(user.id, params.id);
    return ok ? { ok: true } : { error: '令牌不存在', status: 404 };
  },

  // ─────────── 浏览器扩展 ───────────

  /** 扩展自检：令牌是否有效、简历是否已导入 */
  'GET /api/extension/status': async () => {
    const user = currentUser();
    if (!user) return { error: '令牌无效或已撤销', status: 401 };
    return {
      ok: true,
      user: { name: user.displayName || user.username },
      hasResume: hasOwnProfile(),
      jobCount: loadJobs().length,
    };
  },

  /**
   * 一键分析（扩展调用）
   * 输入 JD 文本 + 来源 URL，返回评分、得分构成、建议，并落库。
   */
  'POST /api/extension/analyze': async (q, p, body) => {
    const user = currentUser();
    if (!user) return { error: '令牌无效或已撤销', status: 401 };

    const rl = checkRate(`ext:${user.id}`, 60);
    if (!rl.ok) return { error: '分析过于频繁，稍等一下', status: 429 };

    const text = str(body.text, 60_000);
    if (!text || text.trim().length < 40) {
      return { error: 'JD 内容太短，可能没抓取到正文', status: 400 };
    }

    let profile = loadProfile();
    if (!profile) return { error: '还没导入简历，请先到网站导入', status: 400, needResume: true };

    // 解析 + 评分
    const parsed = parseJD(text);

    // 扩展已经识别出标题/公司时优先采用 —— 比从正文猜准得多
    const hintTitle = str(body.title, 80).trim();
    const hintCompany = str(body.company, 60).trim();
    const GENERIC = /^(职位描述|岗位职责|职位详情|工作职责|招聘|职位信息|岗位描述|职责描述)$/;

    if (hintTitle && (!parsed.position || parsed.position.length < 3 || GENERIC.test(parsed.position))) {
      parsed.position = hintTitle;
    }
    // 公司名以扩展识别结果为准：它看的是页面结构，比从正文里猜准
    if (hintCompany && hintCompany.length >= 2) {
      parsed.company = hintCompany;
    }

    const sourceUrl = str(body.url, 500);
    const sc = scoreJob(parsed, profile);

    // 来源标记：区分是扩展抓的还是手工贴的
    const record = sliceForStorage({
      ...sc,
      link: sourceUrl || sc.link || '',
      via: str(body.via, 20) || 'extension',
    });

    const { list, added, updated } = upsertJobs([record], loadJobs());
    saveJobs(list);
    const saved = added[0] || updated[0];

    // 轻量摘要：给扩展面板显示，不返回全文
    const scoreResult = {
      total: saved.total,
      grade: saved.grade,
      breakdown: {
        dimensions: (saved.dimensions || []).map((d) => ({
          id: d.id, name: d.name, weight: d.weight, ratio: d.ratio, hits: d.hits || [],
        })),
      },
    };

    let advice = null;
    try {
      advice = tailorResume(saved, profile, scoreResult);
    } catch { /* 定制失败不影响评分返回 */ }

    return {
      ok: true,
      job: {
        id: saved.id,
        position: saved.position,
        company: saved.company,
        city: saved.city,
        salary: saved.salary,
        total: saved.total,
        grade: saved.grade,
        isNew: added.length > 0,
      },
      dimensions: (saved.dimensions || [])
        .filter((d) => d.weight > 0)
        .map((d) => ({
          name: d.name,
          ratio: Math.round((d.ratio || 0) * 100),
          weight: d.weight,
          hits: (d.hits || []).slice(0, 6),
        })),
      strong: (advice?.strong || []).slice(0, 3).map((h) => h.text),
      gaps: (advice?.gaps || []).slice(0, 3).map((g) => ({
        name: g.dimension,
        ratio: Math.round((g.ratio || 0) * 100),
        weight: g.weight,
        tip: g.advice,
      })),
      missing: (advice?.missingKeywords || []).slice(0, 8),
      corrections: saved.corrections || [],
      url: sourceUrl,
    };
  },

  // ─────────── 我学会的技能 ───────────

  /** 列出用户已确认学会的技能 */
  'GET /api/resume/skills': async () => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };
    return { skills: profile.skillsExtra || [] };
  },

  /** 学会一个新技能（用户自己确认），会进入后续生成的简历技能区 */
  'POST /api/resume/skills': async (q, p, body) => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    const term = str(body.term, 40).trim();
    if (!term) return { error: '技能名不能为空', status: 400 };

    profile.skillsExtra = profile.skillsExtra || [];
    if (profile.skillsExtra.some((x) => String(x.term || x).toLowerCase() === term.toLowerCase())) {
      return { ok: true, duplicated: true, skills: profile.skillsExtra };
    }

    profile.skillsExtra.push({
      term,
      addedAt: new Date().toISOString(),
      // 用户自己声明的，标记来源，便于区分「简历原文里的」和「后来学的」
      source: str(body.source, 20) || 'learned',
    });
    saveProfile(profile);

    return { ok: true, skills: profile.skillsExtra };
  },

  /** 移除一个新增技能 */
  'DELETE /api/resume/skills/:term': async (q, params) => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    const term = decodeURIComponent(params.term || '').toLowerCase();
    const before = (profile.skillsExtra || []).length;
    profile.skillsExtra = (profile.skillsExtra || []).filter(
      (x) => String(x.term || x).toLowerCase() !== term
    );
    if (profile.skillsExtra.length === before) return { error: '没有这个技能', status: 404 };

    saveProfile(profile);
    return { ok: true, skills: profile.skillsExtra };
  },

  // ─────────── 洞察与权重校准 ───────────

  /** 投递漏斗 + 权重校准分析 */
  'GET /api/insights': async () => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    const jobs = loadJobs();
    const outcomes = analyzeOutcomes(jobs);
    const calib = calibrate(profile, jobs);

    return {
      outcomes: {
        total: outcomes.total,
        applied: outcomes.applied,
        positive: outcomes.positive,
        negative: outcomes.negative,
        pending: outcomes.pending,
        interviewRate: outcomes.interviewRate,
        offerCount: outcomes.offerCount,
        repliedCount: outcomes.repliedCount,
      },
      calibration: calib,
    };
  },

  /** 应用建议权重，并重算所有岗位分数 */
  'POST /api/insights/weights': async (q, p, body) => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    const incoming = body.weights && typeof body.weights === 'object' ? body.weights : null;
    if (!incoming) return { error: '缺少权重数据', status: 400 };

    // 只接受 profile 里存在的维度，且数值必须是合理的正数
    const clean = {};
    let sum = 0;
    for (const dim of profile.dimensions || []) {
      const v = Number(incoming[dim.id]);
      if (!Number.isFinite(v) || v < 1 || v > 60) continue;
      clean[dim.id] = Math.round(v);
      sum += Math.round(v);
    }
    if (!Object.keys(clean).length) return { error: '权重数据无效', status: 400 };
    if (Math.abs(sum - 100) > 2) {
      return { error: `权重合计应为 100，当前 ${sum}`, status: 400 };
    }

    profile.weights = clean;
    saveProfile(profile);

    // 立刻重算，让列表和详情反映新权重
    const jobs = loadJobs();
    const rescored = jobs.map((j) => {
      const parsed = { position: j.position, company: j.company, salary: j.salary, city: j.city, text: j.text };
      const sc = scoreJob(parsed, profile);
      return { ...j, total: sc.total, grade: sc.grade, dimensions: sc.breakdown.dimensions, corrections: sc.corrections };
    });
    saveJobs(rescored);

    return { ok: true, weights: clean, rescored: rescored.length };
  },

  /** 恢复默认权重 */
  'DELETE /api/insights/weights': async () => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    delete profile.weights;
    saveProfile(profile);

    const jobs = loadJobs();
    const rescored = jobs.map((j) => {
      const parsed = { position: j.position, company: j.company, salary: j.salary, city: j.city, text: j.text };
      const sc = scoreJob(parsed, profile);
      return { ...j, total: sc.total, grade: sc.grade, dimensions: sc.breakdown.dimensions, corrections: sc.corrections };
    });
    saveJobs(rescored);

    return { ok: true, rescored: rescored.length };
  },

  // ─────────── 定制简历 ───────────

  /**
   * 生成针对该岗位的简历
   * 返回完整 Markdown + 覆盖率 + 关键词位置矩阵 + ATS 检查
   */
  'POST /api/jobs/:id/generate-resume': async (q, params, body) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历，请先到「我的简历」导入', status: 400 };

    // 复用已有的定制分析（要点强弱分桶）
    const scoreResult = {
      total: job.total, grade: job.grade,
      breakdown: {
        dimensions: (job.dimensions || []).map((d) => ({
          id: d.id, name: d.name, weight: d.weight, ratio: d.ratio, hits: d.hits || [],
        })),
      },
    };
    const tailored = tailorResume(job, profile, scoreResult);

    const gen = generateResume(profile, job, tailored);

    // 缺失关键词 → 学习计划（让用户知道该补什么、怎么补、多久）
    const learningPlan = buildLearningPlan(gen.gaps);
    const planSummary = summarizePlan(learningPlan);
    const saved = addVersion({
      jobId: job.id,
      jobTitle: job.position,
      company: job.company,
      markdown: gen.markdown,
      coverage: gen.coverage,
      stats: {
        charCount: gen.markdown.length,
        bulletCount: gen.bulletCount,
        mustHaveTotal: gen.mustHaveTotal,
        mustHaveOwned: gen.mustHaveOwned,
        gaps: gen.gaps.length,
      },
    });

    return {
      ok: true,
      reused: Boolean(saved.reused),
      version: { ...saved.version, markdown: undefined },
      markdown: gen.markdown,
      coverage: gen.coverage,
      mustHave: { total: gen.mustHaveTotal, owned: gen.mustHaveOwned },
      matrix: gen.matrix,
      density: gen.density,
      checks: gen.checks,
      gaps: gen.gaps,
      learningPlan,
      planSummary,
      skillGroups: gen.skillGroups,
    };
  },

  /** 版本列表 */
  'GET /api/resume/versions': async () => {
    const list = loadVersions().map((v) => publicVersion(v, false));
    return { versions: list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)) };
  },

  /** 某一版的 Markdown */
  'GET /api/resume/versions/:id': async (q, params) => {
    const v = getVersion(params.id);
    if (!v) return { error: '版本不存在', status: 404 };
    return { version: publicVersion(v, true) };
  },

  /** 打印视图（用于浏览器「存为 PDF」） */
  'GET /api/resume/versions/:id/print': async (q, params) => {
    const v = getVersion(params.id);
    if (!v) return { error: '版本不存在', status: 404 };
    const profile = loadProfile();
    const job = { position: v.jobTitle, company: v.company };
    return {
      html: renderPrintableHTML(profile || {}, job, v.markdown),
      title: (profile?.profile?.name || '简历') + ' - ' + v.jobTitle,
    };
  },

  /** 采用某一版 */
  'PATCH /api/resume/versions/:id/select': async (q, params) => {
    const r = selectVersion(params.id);
    return r ? { ok: true, version: r } : { error: '版本不存在', status: 404 };
  },

  'DELETE /api/resume/versions/:id': async (q, params) => {
    return deleteVersion(params.id) ? { ok: true } : { error: '版本不存在', status: 404 };
  },

  /** 关键词提取预览（不生成简历） */
  'GET /api/jobs/:id/keywords': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };
    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const kw = extractKeywords(job.text || job.position || '');
    const profile = loadProfile();
    const fromMine = new Set((profile?.highlights || []).flatMap((h) => h.keywords || []).map((x) => String(x).toLowerCase()));

    return {
      mustHave: kw.mustHave.map((k) => ({ ...k, owned: fromMine.has(k.term.toLowerCase()) })),
      niceToHave: kw.niceToHave.map((k) => ({ ...k, owned: fromMine.has(k.term.toLowerCase()) })),
      categories: kw.categories,
    };
  },

  // ─────────── 职级与谈薪 ───────────

  'GET /api/jobs/:id/strategy': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    return buildStrategy(profile, job);
  },

  // ─────────── 面试故事库 ───────────

  'GET /api/stories': async () => {
    const list = loadStories();
    return {
      stories: list,
      types: STORY_TYPES,
      gaps: storyGaps(),
      total: list.length,
    };
  },

  /** 从简历生成故事骨架（不覆盖已有） */
  'POST /api/stories/seed': async () => {
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };
    const r = seedStoriesFromResume(profile);
    return { ok: true, added: r.added, total: r.stories.length, gaps: storyGaps() };
  },

  'PATCH /api/stories/:id': async (q, params, body) => {
    const s = updateStory(params.id, body);
    return s ? { ok: true, story: s } : { error: '故事不存在', status: 404 };
  },

  'DELETE /api/stories/:id': async (q, params) => {
    return deleteStory(params.id) ? { ok: true } : { error: '故事不存在', status: 404 };
  },

  /** 为某个岗位挑故事 */
  'GET /api/jobs/:id/stories': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };
    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };
    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    const picked = pickStoriesForJob(job, profile, 5);
    for (const s of picked) markStoryUsed(s.id, job.id);

    return {
      stories: picked.map((s) => ({
        id: s.id, type: s.type, typeName: STORY_TYPES[s.type]?.name || s.type,
        title: s.title, star: s.star, keywords: s.keywords,
        score: s._score, usedCount: (s.usedBy || []).length,
      })),
    };
  },

  // ─────────── 状态与元信息 ───────────

  'GET /api/status': async (q, p, b, req) => {
    const profile = loadProfile();
    const jobs = loadJobs();
    const user = userFromRequest(req);
    return {
      ok: true,
      user,
      multiUser: true,
      hasResume: hasOwnProfile(),
      profileLoaded: Boolean(profile),
      profileName: profile?.profile?.name || '',
      profileMeta: profile?.meta || null,
      jobsCount: jobs.length,
      ai: getAIPublicStatus(),
      aiReady: hasAI(),
      quota: quotaStatus(),
      requiresLogin: true,
    };
  },

  'GET /api/profile': async () => {
    const p = loadProfile();
    if (!p) return { error: '画像文件缺失', status: 500 };
    return {
      profile: p.profile,
      dimensions: p.dimensions.map((d) => ({
        id: d.id, name: d.name, weight: d.weight, level: d.level,
        description: d.description,
        keywordCount: Object.keys(d.keywords || {}).length,
      })),
      domains: p.domains.map((d) => d.name),
      negatives: p.negatives.map((n) => n.reason),
    };
  },

  'GET /api/providers': async () => ({ providers: listProviders() }),

  // ─────────── JD 解析与导入 ───────────

  'POST /api/parse': async (q, p, body) => {
    const v = validateJDText(body.text);
    if (!v.ok) return { error: v.error, status: 400 };

    const batch = body.batch === true;
    const parsed = batch
      ? parseBatch(v.text, {}).slice(0, LIMITS.batchMax)
      : [parseJD(v.text, {})];

    return { count: parsed.length, jobs: parsed };
  },

  'POST /api/jobs': async (q, p, body) => {
    const profile = loadProfile();
    if (!profile) return { error: '画像文件缺失', status: 500 };

    const v = validateJDText(body.text);
    if (!v.ok) return { error: v.error, status: 400 };

    const parsed = body.batch === true
      ? parseBatch(v.text, {}).slice(0, LIMITS.batchMax)
      : [parseJD(v.text, {})];

    if (!parsed.length) return { error: '未解析出有效 JD', status: 400 };

    const scored = parsed.map((j) => sliceForStorage(scoreJob(j, profile)));
    const { list, added, updated } = upsertJobs(scored, loadJobs());
    saveJobs(list);

    return {
      added: added.length,
      updated: updated.length,
      jobs: [...added, ...updated].slice(0, 50).map((j) => ({
        id: j.id, company: j.company, position: j.position,
        total: j.total, grade: j.grade, status: j.status,
      })),
    };
  },

  // ─────────── 样例库 ───────────

  /** 列出样例 JD（不含全文，避免响应过大） */
  'GET /api/samples': async () => {
    const file = resolve(__dirname, '../data/presets/jd-samples.json');
    if (!existsSync(file)) return { samples: [] };
    try {
      const data = JSON.parse(readFileSync(file, 'utf-8'));
      return {
        samples: (data.samples || []).map((s) => ({
          id: s.id,
          source: s.source,
          sourceName: s.sourceName,
          sourceUrl: s.sourceUrl || '',
          note: s.note || '',
          // 预览：取前 120 字
          preview: String(s.text || '').replace(/\s+/g, ' ').slice(0, 120),
          length: String(s.text || '').length,
        })),
      };
    } catch (e) {
      return { error: '样例库读取失败：' + e.message, status: 500 };
    }
  },

  /** 导入指定样例（可多选） */
  'POST /api/samples/import': async (q, p, body) => {
    const profile = loadProfile();
    if (!profile) return { error: '画像文件缺失', status: 500 };

    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 20) : [];
    if (!ids.length) return { error: '未选择样例', status: 400 };

    const file = resolve(__dirname, '../data/presets/jd-samples.json');
    if (!existsSync(file)) return { error: '样例库不存在', status: 500 };

    let data;
    try { data = JSON.parse(readFileSync(file, 'utf-8')); }
    catch (e) { return { error: '样例库解析失败', status: 500 }; }

    const picked = (data.samples || []).filter((s) => ids.includes(s.id));
    if (!picked.length) return { error: '未找到匹配的样例', status: 400 };

    const scored = picked.map((s) => {
      const parsed = parseJD(s.text);
      const sc = scoreJob(parsed, profile);
      return sliceForStorage({
        ...sc,
        // 样例来源写进备注，便于区分真实与示例数据
        company: sc.company,
      });
    });

    const { list, added, updated } = upsertJobs(scored, loadJobs());
    saveJobs(list);

    return {
      added: added.length,
      updated: updated.length,
      jobs: [...added, ...updated].map((j) => ({
        id: j.id, company: j.company, position: j.position,
        total: j.total, grade: j.grade,
      })),
    };
  },

  // ─────────── 查询 ───────────

  'GET /api/jobs': async (query) => {
    const jobs = loadJobs();

    const sortBy = str(query.get('sort') || 'score', 20);
    const grade = str(query.get('grade') || '', 2);
    const status = str(query.get('status') || '', 20);
    const kw = str(query.get('q') || '', 100).toLowerCase();

    let list = jobs;
    if (grade) list = list.filter((j) => j.grade === grade);
    if (status) list = list.filter((j) => (j.status || 'new') === status);
    if (kw) {
      list = list.filter((j) =>
        `${j.company} ${j.position} ${j.text || ''}`.toLowerCase().includes(kw));
    }

    const sorters = {
      score: (a, b) => (b.total || 0) - (a.total || 0),
      date: (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
      salary: (a, b) => salaryRank(b.salary) - salaryRank(a.salary),
      updated: (a, b) => {
        const at = new Date(a.statusHistory?.at(-1)?.at || 0).getTime();
        const bt = new Date(b.statusHistory?.at(-1)?.at || 0).getTime();
        return bt - at;
      },
    };
    list = [...list].sort(sorters[sortBy] || sorters.score);

    return {
      total: list.length,
      allCount: jobs.length,
      stats: computeStats(jobs),
      statusOptions: APPLICATION_STATUS,
      jobs: list,
    };
  },

  'GET /api/jobs/:id': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };
    return { job, statusOptions: APPLICATION_STATUS };
  },

  /** 针对该岗位定制简历建议 */
  'GET /api/jobs/:id/resume': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const profile = loadProfile();
    if (!profile) return { error: '画像文件缺失', status: 500 };

    // 用存储的分数结果重建一个最小 scoreResult（dimensions 已在 job 里）
    const scoreResult = {
      total: job.total,
      grade: job.grade,
      breakdown: {
        dimensions: (job.dimensions || []).map((d) => ({
          id: d.id,
          name: d.name,
          weight: d.weight,
          ratio: d.ratio,
          hits: d.hits || [],
        })),
      },
    };

    return tailorResume(job, profile, scoreResult);
  },

  /** 针对该岗位生成复习计划 */
  'GET /api/jobs/:id/prep': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const profile = loadProfile();
    if (!profile) return { error: '画像文件缺失', status: 500 };

    const scoreResult = {
      total: job.total,
      grade: job.grade,
      breakdown: {
        dimensions: (job.dimensions || []).map((d) => ({
          id: d.id,
          name: d.name,
          weight: d.weight,
          ratio: d.ratio,
          hits: d.hits || [],
        })),
      },
    };

    return buildStudyPlan(job, profile, scoreResult);
  },

  /** 深度复习文档（配了 AI 走 AI，没配走结构化知识库） */
  'GET /api/jobs/:id/prep-doc': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const profile = loadProfile();
    if (!profile) return { error: '还没有导入简历', status: 400 };

    const scoreResult = {
      total: job.total,
      grade: job.grade,
      breakdown: {
        dimensions: (job.dimensions || []).map((d) => ({
          id: d.id, name: d.name, weight: d.weight, ratio: d.ratio, hits: d.hits || [],
        })),
      },
    };

    const plan = buildStudyPlan(job, profile, scoreResult);
    const doc = await generatePrepDoc(job, profile, plan);

    return {
      jobTitle: job.position,
      company: job.company,
      source: doc.source,
      note: doc.note || '',
      rounds: doc.rounds || 1,
      complete: doc.complete !== false,
      content: doc.content,               // 原始 Markdown（"复制全文"用）
      chars: (doc.content || '').length,
      // 服务端渲成 HTML，前端直接插入；文本已全量转义
      html: renderMarkdown(doc.content),
    };
  },

  'DELETE /api/jobs/:id': async (q, params) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const jobs = loadJobs();
    const next = jobs.filter((j) => j.id !== v.id);
    if (next.length === jobs.length) return { error: '岗位不存在', status: 404 };

    saveJobs(next);
    return { ok: true, remain: next.length };
  },

  'PATCH /api/jobs/:id': async (q, params, body) => {
    const v = validateId(params.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const jobs = loadJobs();
    if (!jobs.some((j) => j.id === v.id)) return { error: '岗位不存在', status: 404 };

    if (body.status !== undefined) {
      const s = str(body.status, 20);
      if (!isValidStatus(s)) {
        return { error: `无效状态，可选：${Object.keys(APPLICATION_STATUS).join('/')}`, status: 400 };
      }
      setJobStatus(jobs, v.id, s, body.note !== undefined ? str(body.note, LIMITS.noteChars) : undefined);
    } else if (body.note !== undefined) {
      const job = jobs.find((j) => j.id === v.id);
      job.note = str(body.note, LIMITS.noteChars);
    }

    saveJobs(jobs);
    return { ok: true, job: jobs.find((j) => j.id === v.id) };
  },

  'POST /api/rescore': async () => {
    const profile = loadProfile();
    if (!profile) return { error: '画像文件缺失', status: 500 };

    const jobs = loadJobs();
    backupJobs(jobs);   // 改评分前自动备份，可回滚

    const rescored = jobs.map((j) => {
      const s = sliceForStorage(scoreJob(j, profile));
      return {
        ...s,
        status: j.status || 'new',
        note: j.note || '',
        appliedAt: j.appliedAt || '',
        statusHistory: j.statusHistory || [],
        firstSeenAt: j.firstSeenAt || j.createdAt,
      };
    });

    saveJobs(rescored);
    return { ok: true, count: rescored.length };
  },

  // ─────────── AI（消耗配额）───────────

  'POST /api/ai/test': async () => {
    if (!isAIEnabled()) return { ok: false, message: getAIPublicStatus().reason };

    const q = consumeAIQuota();
    if (!q.ok) return { ok: false, message: q.message };

    return testConnection();
  },

  'POST /api/ai/generate': async (q, p, body) => {
    if (!isAIEnabled()) {
      return { error: 'AI 未配置，请参考 docs/FREE-MODELS.md', status: 400 };
    }

    const quotaResult = consumeAIQuota();
    if (!quotaResult.ok) return { error: quotaResult.message, status: 429 };

    const v = validateId(body.id);
    if (!v.ok) return { error: v.error, status: 400 };

    const profile = loadProfile();
    const job = loadJobs().find((j) => j.id === v.id);
    if (!job) return { error: '岗位不存在', status: 404 };

    const [greeting, advice] = await Promise.allSettled([
      generateGreeting(job, profile, job),
      generateAdvice(job, profile, job),
    ]);

    return {
      greeting: greeting.status === 'fulfilled'
        ? greeting.value
        : `生成失败：${greeting.reason?.message || '未知错误'}`,
      advice: advice.status === 'fulfilled'
        ? advice.value
        : { raw: `生成失败：${advice.reason?.message || '未知错误'}` },
      quotaRemain: quotaResult.remain,
    };
  },

  'POST /api/ai/generate-top': async (q, p, body) => {
    if (!isAIEnabled()) return { error: 'AI 未配置', status: 400 };

    const n = Math.min(20, Math.max(1, Number(body.n) || 5));
    const quotaResult = consumeAIQuota();
    if (!quotaResult.ok) return { error: quotaResult.message, status: 429 };

    const profile = loadProfile();
    const top = [...loadJobs()]
      .sort((a, b) => (b.total || 0) - (a.total || 0))
      .slice(0, n);

    const results = await generateBatch(top, async (job) => ({
      id: job.id,
      company: job.company,
      position: job.position,
      total: job.total,
      greeting: await generateGreeting(job, profile, job),
    }), 2);

    return {
      count: results.filter((r) => r.ok).length,
      results: results.map((r, i) => r.ok ? r.value : {
        id: top[i].id,
        company: top[i].company,
        position: top[i].position,
        error: r.error,
      }),
      quotaRemain: quotaResult.remain,
    };
  },

  // ─────────── 导出 ───────────

  'GET /api/export': async (query) => {
    const jobs = loadJobs();
    const profile = loadProfile();
    const min = Math.max(0, Math.min(100, Number(query.get('min')) || 0));
    const format = str(query.get('format') || 'md', 10);

    if (format === 'csv') return { csv: buildCSV(jobs, min) };
    return { markdown: buildMarkdown(jobs, profile, min) };
  },
};

// ═══════════════════════ 导出格式化 ═══════════════════════

function buildMarkdown(jobs, profile, minScore) {
  const list = jobs.filter((j) => (j.total || 0) >= minScore).sort((a, b) => b.total - a.total);
  const stats = computeStats(jobs);
  const now = new Date().toLocaleString('zh-CN');

  const L = [];
  L.push('# 投递优先级报告', '');
  L.push(`> 生成时间：${now} ｜ 候选人：${profile?.profile?.name || '-'} ｜ ${list.length} 个岗位（最低分 ${minScore}）`, '');

  L.push('## 数据概览', '');
  L.push('| 指标 | 数值 |', '| --- | --- |');
  L.push(`| 收录岗位 | ${stats.total} |`);
  L.push(`| 已投递 | ${stats.appliedCount} |`);
  L.push(`| 收到回复 | ${stats.repliedCount}（回复率 ${stats.replyRate}%） |`);
  L.push(`| 进入面试 | ${stats.interviewCount}（面试率 ${stats.interviewRate}%） |`);
  L.push(`| 拿到 offer | ${stats.offerCount} |`);
  L.push(`| 平均匹配度 | ${stats.avgScore} |`, '');

  L.push('## 岗位列表', '');
  L.push('| 排名 | 公司 | 职位 | 匹配度 | 评级 | 状态 | 薪资 |');
  L.push('| --- | --- | --- | --- | --- | --- | --- |');
  list.forEach((j, i) => {
    const st = APPLICATION_STATUS[j.status || 'new']?.label || '待投递';
    L.push(`| ${i + 1} | ${j.company} | ${j.position} | **${j.total}** | ${j.grade} | ${st} | ${j.salary} |`);
  });
  L.push('');

  L.push('## 逐个分析', '');
  for (const j of list) {
    const st = APPLICATION_STATUS[j.status || 'new']?.label || '待投递';
    L.push(`### ${j.company} — ${j.position}`, '');
    L.push(`**${j.total} 分 / ${j.grade} 级（${j.gradeLabel}）｜ 状态：${st}**`, '');
    if (j.link) L.push(`- 链接：${j.link}`);
    L.push(`- 薪资：${j.salary}${j.city ? ` ｜ 城市：${j.city}` : ''}${j.experience ? ` ｜ 经验：${j.experience}` : ''}`);
    if (j.note) L.push(`- 备注：${j.note}`);
    L.push('');

    const dims = (j.dimensions || []).filter((d) => d.score > 0);
    if (dims.length) {
      L.push('**维度得分**：', '', '| 维度 | 权重 | 得分 | 命中关键词 |', '| --- | --- | --- | --- |');
      for (const d of dims) {
        L.push(`| ${d.name} | ${d.weight} | ${d.score} | ${(d.hits || []).join('、') || '-'} |`);
      }
      L.push('');
    }

    if (j.domainHits?.length) L.push(`**行业匹配**：${j.domainHits.map((d) => d.name).join('、')}`, '');
    if (j.negatives?.length) {
      L.push('**⚠️ 风险点**：');
      for (const n of j.negatives) L.push(`- ${n.reason}`);
      L.push('');
    }
    if (j.years?.note) L.push(`**年限判断**：${j.years.note}`, '');
    if (j.strengths?.length) L.push(`**优势**：${j.strengths.map((s) => s.name).join('、')}`);
    if (j.weaknesses?.length) L.push(`**需补**：${j.weaknesses.map((w) => w.name).join('、')}`);
    L.push('', '---', '');
  }

  return L.join('\n');
}

function buildCSV(jobs, minScore) {
  const list = jobs.filter((j) => (j.total || 0) >= minScore).sort((a, b) => b.total - a.total);
  const header = ['公司', '职位', '匹配度', '评级', '状态', '薪资', '城市', '经验', '投递时间', '备注', '链接'];
  const rows = list.map((j) => [
    j.company, j.position, j.total, j.grade,
    APPLICATION_STATUS[j.status || 'new']?.label || '待投递',
    j.salary, j.city || '', j.experience || '',
    j.appliedAt || '', j.note || '', j.link || '',
  ]);

  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\n');
}

// ═══════════════════════ 分发 ═══════════════════════

/**
 * CORS：只允许浏览器扩展来源。
 * 扩展从 background 发请求时因为有 host_permissions 本不需要 CORS，
 * 这里放开是为了让 content script 直连、以及在扩展调试页里测试时也能通。
 */
function applyCors(req, res) {
  const origin = req.headers.origin || '';
  // 扩展来源 + 本地开发来源（localhost 只能在开发机上用，不影响线上安全）
  const allowed =
    origin.startsWith('chrome-extension://') ||
    origin.startsWith('moz-extension://') ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
}

const PUBLIC_ROUTES = new Set([
  'GET /api/health',
  'GET /api/auth/required',
  'GET /api/auth/me',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/register',
  'POST /api/auth/token',
]);

/** 需要额外限流的 AI 路由 */
const AI_ROUTES = new Set([
  'POST /api/ai/test',
  'POST /api/ai/generate',
  'POST /api/ai/generate-top',
]);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = url.pathname;

  if (!path.startsWith('/api/')) return serveStatic(res, path);

  // CORS：先回预检，再进路由
  applyCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // 路由匹配
  let handler = null;
  let routeKey = '';
  let params = {};

  for (const [key, fn] of Object.entries(routes)) {
    const [method, pattern] = key.split(' ');
    if (method !== req.method) continue;

    if (pattern === path) {
      handler = fn; routeKey = key; params = {};
      break;
    }

    const pp = pattern.split('/');
    const ap = path.split('/');
    if (pp.length === ap.length) {
      let matched = true;
      const captured = {};
      for (let i = 0; i < pp.length; i++) {
        if (pp[i].startsWith(':')) {
          captured[pp[i].slice(1)] = decodeURIComponent(ap[i]);
        } else if (pp[i] !== ap[i]) {
          matched = false;
          break;
        }
      }
      if (matched) { handler = fn; routeKey = key; params = captured; break; }
    }
  }

  if (!handler) return json(res, { error: '接口不存在' }, 404);

  // ── 识别当前用户 ──
  // 优先 Cookie 会话（Web 端），其次 Bearer 令牌（浏览器扩展）
  let user = userFromRequest(req);
  const bearer = bearerFromRequest(req);
  if (!user && bearer) {
    const uid = verifyBearer(bearer);
    if (uid) {
      const u = getUserById(uid);
      if (u) user = publicUser(u);
    }
  }

  // 鉴权：登录用户放行；否则回退到单用户口令模式（本地/演示）
  const needsAuth = !PUBLIC_ROUTES.has(routeKey);
  if (needsAuth && !user && !isAuthed(req)) {
    return json(res, { error: '请先登录', needLogin: true }, 401);
  }

  // 限流
  const ip = clientIp(req);
  const globalRate = checkRate(`g:${ip}`, RATE.maxReq);
  if (!globalRate.ok) {
    return json(res, { error: '请求过于频繁，请稍后再试' }, 429);
  }

  if (AI_ROUTES.has(routeKey)) {
    const aiRate = checkRate(`ai:${ip}`, RATE.aiMaxReq);
    if (!aiRate.ok) {
      return json(res, { error: 'AI 调用过于频繁，请稍后再试' }, 429);
    }
  }

  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method)
      ? await readBody(req)
      : {};

    // 把 userId 注入 AsyncLocalStorage，数据层据此选择用户目录
    const result = await userContext.run({ userId: user?.id || null, user: user || null }, () =>
      handler(url.searchParams, params, body, req, res)
    );

    // handler 返回 { status: n, ...payload } 时自定义状态码
    if (result && typeof result === 'object' && Number.isInteger(result.status)) {
      const { status, ...payload } = result;
      return json(res, payload, status);
    }
    return json(res, result);
  } catch (e) {
    // 详细错误只进服务端日志，对外泛化（含请求体过大等）
    console.error(`[${req.method} ${path}]`, e.message);
    const isClientError = /过大/.test(e.message);
    return json(res, {
      error: isClientError ? e.message : '服务端处理失败，请重试',
    }, isClientError ? 413 : 500);
  }
});

// 优雅退出
function shutdown(signal) {
  console.log(`\n[${signal}] 正在关闭服务...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, HOST, () => {
  const ai = getAIPublicStatus();
  const profile = loadProfile();
  const jobs = loadJobs();

  console.log('');
  console.log('  ╔═══════════════════════════════════════════════╗');
  console.log('  ║   Job Matcher · 求职岗位匹配分析器            ║');
  console.log('  ╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log(`   监听      http://${HOST}:${PORT}`);
  console.log(`   画像      ${profile ? `已加载（${profile.profile.name}）` : '❌ 缺失 data/presets/profile.json'}`);
  console.log(`   岗位      ${jobs.length} 个`);
  console.log(`   鉴权      ${TOKEN ? '✅ 已启用访问口令' : '⚠️  未设口令（仅建议本地使用）'}`);
  console.log(`   AI        ${ai.enabled ? `✅ ${ai.label} / ${ai.model}（来源：${ai.source}）` : `⚠️  ${ai.reason}`}`);
  console.log(`   AI 配额   ${AI_DAILY_LIMIT} 次/天`);
  console.log(`   限流      ${RATE.maxReq} 次/分（AI ${RATE.aiMaxReq} 次/分）`);
  console.log('');
  console.log('   免费模型配置：docs/FREE-MODELS.md');
  console.log('');
});
