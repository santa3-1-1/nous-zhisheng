/**
 * 通话数据存储 — JSON 文件（轻量 Demo 版，无需编译依赖）
 * 终态切换到 SQLite/PostgreSQL
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '../../data');
const CALLS_FILE = join(DATA_DIR, 'calls.json');

// 确保目录存在
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// 内存中的通话数据
let calls = [];

// 启动时从文件加载
if (existsSync(CALLS_FILE)) {
  try {
    calls = JSON.parse(readFileSync(CALLS_FILE, 'utf-8'));
  } catch (e) {
    calls = [];
  }
}

function save() {
  writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2));
}

/**
 * 记录通话开始
 */
export function createCall({ sessionId, taskId, roomId, callerId }) {
  const call = {
    id: calls.length + 1,
    session_id: sessionId,
    task_id: taskId,
    room_id: roomId,
    caller_id: callerId,
    start_time: new Date().toISOString(),
    end_time: null,
    duration_seconds: null,
    action_taken: 'in_progress',
    summary: null,
    transcript: [],
    urgency: 0,
  };
  calls.push(call);
  save();
  console.log(`[DB] 通话已创建: #${call.id}, 房间 ${roomId}`);
  return call.id;
}

/**
 * 添加对话记录到通话
 */
export function addTranscript(sessionId, role, text) {
  const call = calls.find(c => c.session_id === sessionId);
  if (call) {
    call.transcript.push({ role, text, time: new Date().toISOString() });
    save();
  }
}

/**
 * 更新通话结束
 */
export function endCall({ sessionId, action, summary, duration }) {
  const call = calls.find(c => c.session_id === sessionId);
  if (call) {
    call.end_time = new Date().toISOString();
    call.action_taken = action || 'ended';
    call.summary = summary;
    call.duration_seconds = duration;
    save();
    console.log(`[DB] 通话结束: #${call.id}, ${action}, "${summary}"`);
  }
}

/**
 * 获取通话历史
 */
export function getCalls(limit = 50) {
  return [...calls].reverse().slice(0, limit);
}

/**
 * 获取单条通话
 */
export function getCall(id) {
  return calls.find(c => c.id === id);
}

/**
 * 按 session_id 查找通话
 */
export function getCallBySession(sessionId) {
  return calls.find(c => c.session_id === sessionId);
}
