/**
 * 用户认证模块 — 账号密码注册/登录 + JWT Token
 * 
 * Demo 阶段：用户数据存 JSON 文件，每人独立 profile/知识库/通话记录
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const USERS_DIR = join(__dirname, '../../data/users');
const USERS_INDEX_FILE = join(USERS_DIR, '_index.json');

// 确保目录存在
if (!existsSync(USERS_DIR)) {
  mkdirSync(USERS_DIR, { recursive: true });
}

// JWT Secret (demo 级别，不需要高强度)
const JWT_SECRET = process.env.JWT_SECRET || 'nous-zhiyin-demo-secret-2026';

// 用户索引（username → userId）
let usersIndex = {};
if (existsSync(USERS_INDEX_FILE)) {
  try { usersIndex = JSON.parse(readFileSync(USERS_INDEX_FILE, 'utf-8')); } catch { usersIndex = {}; }
}

function saveIndex() {
  writeFileSync(USERS_INDEX_FILE, JSON.stringify(usersIndex, null, 2));
}

// 简单的 JWT 实现（不引入额外依赖）
function createToken(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, iat: Date.now(), exp: Date.now() + 7 * 24 * 3600 * 1000 })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  try {
    const [header, body, signature] = token.split('.');
    const expected = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

function hashPassword(password) {
  return crypto.createHash('sha256').update(password + JWT_SECRET).digest('hex');
}

/**
 * 获取用户数据目录
 */
export function getUserDir(userId) {
  const dir = join(USERS_DIR, userId);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 获取用户 profile
 */
export function getUserProfile(userId) {
  const profileFile = join(getUserDir(userId), 'profile.json');
  if (existsSync(profileFile)) {
    try { return JSON.parse(readFileSync(profileFile, 'utf-8')); } catch {}
  }
  // 新用户默认 profile
  const defaultProfile = {
    identity: { name: '', nickname: '', role: '', company: '' },
    greeting: '',
    voice: {
      mode: 'preset', // 'preset' | 'clone'
      tts_type: 'flow',
      voice_id: 'v-male-W1tH9jVc',
      model: 'flow_01_turbo',
      clone_voice_id: null,
      speed: 1.0,
      language: 'zh'
    },
    rules: {
      auto_handle: [],
      always_transfer: [],
      spam_policy: 'polite_reject',
      forbidden_actions: ['任何涉及转账/付款的请求', '泄露个人隐私信息']
    },
    style: { casual_to: [], formal_to: [] },
    faq: [],
    shaping: [],
    onboarding_completed: false
  };
  saveUserProfile(userId, defaultProfile);
  return defaultProfile;
}

/**
 * 保存用户 profile
 */
export function saveUserProfile(userId, profile) {
  const profileFile = join(getUserDir(userId), 'profile.json');
  writeFileSync(profileFile, JSON.stringify(profile, null, 2));
}

/**
 * 获取用户通话记录
 */
export function getUserCalls(userId) {
  const callsFile = join(getUserDir(userId), 'calls.json');
  if (existsSync(callsFile)) {
    try { return JSON.parse(readFileSync(callsFile, 'utf-8')); } catch {}
  }
  return [];
}

/**
 * 保存用户通话记录
 */
export function saveUserCalls(userId, calls) {
  const callsFile = join(getUserDir(userId), 'calls.json');
  writeFileSync(callsFile, JSON.stringify(calls, null, 2));
}

/**
 * 获取用户知识库
 */
export function getUserKnowledge(userId) {
  const knowledgeFile = join(getUserDir(userId), 'knowledge.json');
  if (existsSync(knowledgeFile)) {
    try { return JSON.parse(readFileSync(knowledgeFile, 'utf-8')); } catch {}
  }
  return [];
}

/**
 * 保存用户知识库
 */
export function saveUserKnowledge(userId, knowledge) {
  const knowledgeFile = join(getUserDir(userId), 'knowledge.json');
  writeFileSync(knowledgeFile, JSON.stringify(knowledge, null, 2));
}

/**
 * 注册
 */
export function register(username, password, nickname) {
  if (!username || !password) return { error: '用户名和密码不能为空' };
  if (username.length < 2 || username.length > 20) return { error: '用户名 2-20 个字符' };
  if (password.length < 4) return { error: '密码至少 4 位' };
  if (usersIndex[username]) return { error: '用户名已存在' };

  const userId = 'u_' + crypto.randomBytes(4).toString('hex');
  const passwordHash = hashPassword(password);

  usersIndex[username] = { userId, passwordHash, createdAt: new Date().toISOString() };
  saveIndex();

  // 创建初始 profile
  const profile = getUserProfile(userId);
  if (nickname) {
    profile.identity.nickname = nickname;
    profile.identity.name = nickname;
    saveUserProfile(userId, profile);
  }

  const token = createToken({ userId, username });
  return { success: true, token, userId, username };
}

/**
 * 登录
 */
export function login(username, password) {
  if (!username || !password) return { error: '用户名和密码不能为空' };
  const user = usersIndex[username];
  if (!user) return { error: '用户不存在' };
  if (user.passwordHash !== hashPassword(password)) return { error: '密码错误' };

  const token = createToken({ userId: user.userId, username });
  return { success: true, token, userId: user.userId, username };
}

/**
 * Express 中间件：验证 Token
 */
export function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Token 已过期，请重新登录' });

  req.userId = payload.userId;
  req.username = payload.username;
  next();
}

/**
 * 通过用户名查找 userId
 */
export function findUserByUsername(username) {
  const user = usersIndex[username];
  return user ? user.userId : null;
}

/**
 * 获取所有用户列表（用于代打时查找对方）
 */
export function getAllUsers() {
  return Object.entries(usersIndex).map(([username, data]) => ({
    username,
    userId: data.userId,
  }));
}
