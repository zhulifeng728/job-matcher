/**
 * auth.js —— 账号与会话
 *
 * 设计取舍：
 *   1. 密码用 scrypt 加盐哈希（Node 内置，零依赖）
 *   2. 会话用「签名 Cookie」而非服务端 Map —— 重启不掉线，无需清理过期数据
 *   3. 每个用户独立数据目录 data/users/<id>/，互不可见
 *   4. 用 AsyncLocalStorage 把 userId 透传到数据层，避免每个函数都传参
 */

import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AsyncLocalStorage } from 'node:async_hooks';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DATA_DIR = process.env.JOB_MATCHER_DATA_DIR
  ? resolve(process.env.JOB_MATCHER_DATA_DIR)
  : resolve(ROOT, 'data');

const USERS_FILE = resolve(DATA_DIR, 'users.json');
const SECRET_FILE = resolve(DATA_DIR, '.session-secret');
const USERS_DIR = resolve(DATA_DIR, 'users');

/** 请求上下文：携带当前登录用户 */
export const userContext = new AsyncLocalStorage();

/** 取当前用户 id（未登录返回 null） */
export function currentUserId() {
  return userContext.getStore()?.userId || null;
}

// ────────────────────────── 密钥 ──────────────────────────

let SECRET = '';

function loadSecret() {
  if (process.env.JOB_MATCHER_SECRET) { SECRET = process.env.JOB_MATCHER_SECRET; return; }
  if (existsSync(SECRET_FILE)) { SECRET = readFileSync(SECRET_FILE, 'utf-8').trim(); return; }
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  SECRET = randomBytes(32).toString('hex');
  writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
}
loadSecret();

// ────────────────────────── 用户存储 ──────────────────────────

function readUsers() {
  if (!existsSync(USERS_FILE)) return [];
  try {
    const d = JSON.parse(readFileSync(USERS_FILE, 'utf-8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}

function writeUsers(list) {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(USERS_FILE, JSON.stringify(list, null, 2), 'utf-8');
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

/** 用户名规范化：去空格、转小写（邮箱不区分大小写） */
function normUser(u) {
  return String(u || '').trim().toLowerCase();
}

export function findUser(username) {
  const n = normUser(username);
  return readUsers().find((u) => u.username === n) || null;
}

export function getUserById(id) {
  return readUsers().find((u) => u.id === id) || null;
}

/**
 * 注册
 * @returns {{ ok: true, user } | { ok: false, error }}
 */
export function registerUser(username, password, displayName) {
  const n = normUser(username);

  if (!n) return { ok: false, error: '请输入邮箱或用户名' };
  if (n.length < 4) return { ok: false, error: '账号至少 4 个字符' };
  if (!/^[a-z0-9@._+-]+$/.test(n)) return { ok: false, error: '账号只能包含字母、数字和 @ . _ + -' };
  if (!password || password.length < 6) return { ok: false, error: '密码至少 6 位' };
  if (findUser(n)) return { ok: false, error: '这个账号已注册，直接登录即可' };

  const salt = randomBytes(16).toString('hex');
  const user = {
    id: 'u_' + randomBytes(8).toString('hex'),
    username: n,
    displayName: String(displayName || '').trim().slice(0, 40) || n.split('@')[0],
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };

  const list = readUsers();
  list.push(user);
  writeUsers(list);

  // 建用户目录
  const dir = resolve(USERS_DIR, user.id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  return { ok: true, user: publicUser(user) };
}

export function verifyUser(username, password) {
  const u = findUser(username);
  if (!u) return { ok: false, error: '账号或密码不正确' };

  const input = Buffer.from(hashPassword(password, u.salt), 'hex');
  const stored = Buffer.from(u.passwordHash, 'hex');
  if (input.length !== stored.length || !timingSafeEqual(input, stored)) {
    return { ok: false, error: '账号或密码不正确' };
  }
  return { ok: true, user: publicUser(u) };
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.displayName,
    createdAt: u.createdAt,
  };
}

export function userDataDir(userId) {
  return resolve(USERS_DIR, userId);
}

export function hasUsers() {
  return readUsers().length > 0;
}

// ────────────────────────── 会话（签名 Cookie）──────────────────────────

const SESSION_DAYS = 30;
const COOKIE = 'jm_sid';

function sign(payload) {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

export function issueSession(userId) {
  const exp = Date.now() + SESSION_DAYS * 86400_000;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

export function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const payload = `${userId}.${expStr}`;

  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Date.now() > exp) return null;

  return userId;
}

export function parseCookie(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(req, token) {
  const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'
    || Boolean(req.socket?.encrypted);
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86400}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

/** 从请求解析当前用户 */
export function userFromRequest(req) {
  const cookies = parseCookie(req);
  const userId = readSession(cookies[COOKIE]);
  if (!userId) return null;
  const u = getUserById(userId);
  return u ? publicUser(u) : null;
}
