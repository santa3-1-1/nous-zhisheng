// 清除代理设置，确保直连腾讯云 API
delete process.env.HTTP_PROXY;
delete process.env.HTTPS_PROXY;
delete process.env.http_proxy;
delete process.env.https_proxy;
delete process.env.ALL_PROXY;
delete process.env.all_proxy;

import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { generateUserSig } from './trtc/usersig.js';
import { startAIConversation, stopAIConversation, controlAIConversation } from './trtc/ai-conversation.js';
import { buildSystemPrompt } from './engine/prompt.js';
import { generateSummary } from './engine/summary.js';
import { sendTransferNotify } from './transfer/notify.js';
import { initKnowledge, addKnowledge, searchKnowledge, getAllKnowledge, loadProfileKnowledge } from './rag/knowledge.js';
import { createCall, endCall, addTranscript, getCalls, getCall } from './db/store.js';
import profile from '../profiles/default.json' with { type: 'json' };

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(join(__dirname, '../web')));

// 存储活跃的 AI 对话任务
const activeSessions = new Map();

// =============================================
// API Routes
// =============================================

// --- TRTC 鉴权 ---
app.get('/api/usersig/:userId', (req, res) => {
  const { userId } = req.params;
  const sig = generateUserSig(userId);
  res.json({ sdkAppId: config.trtc.sdkAppId, userId, userSig: sig });
});

// --- AI 对话管理 ---
app.post('/api/ai/start', async (req, res) => {
  const { roomId, targetUserId } = req.body;
  if (!roomId || !targetUserId) {
    return res.status(400).json({ error: 'roomId and targetUserId required' });
  }

  try {
    // RAG 检索（用开场白触发一次上下文加载）
    const ragContext = await searchKnowledge('用户信息 偏好 规则', 5);
    const systemPrompt = buildSystemPrompt(profile, ragContext);
    
    const result = await startAIConversation({
      roomId: parseInt(roomId),
      targetUserId,
      systemPrompt,
      profile,
    });

    // 记录通话
    const sessionId = `session_${roomId}_${Date.now()}`;
    const callId = createCall({
      sessionId,
      taskId: result.TaskId,
      roomId: parseInt(roomId),
      callerId: targetUserId,
    });

    // 存储活跃会话
    activeSessions.set(result.TaskId, {
      sessionId,
      callId,
      roomId: parseInt(roomId),
      targetUserId,
      startTime: Date.now(),
    });

    res.json({ success: true, taskId: result.TaskId, sessionId, callId });
  } catch (err) {
    console.error('[StartAIConversation Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/stop', async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });

  try {
    await stopAIConversation(taskId);
    
    // 结束通话记录 + 生成纪要
    const session = activeSessions.get(taskId);
    if (session) {
      const duration = Math.floor((Date.now() - session.startTime) / 1000);
      const call = getCall(session.callId);
      const summary = await generateSummary(call?.transcript || []);
      
      endCall({
        sessionId: session.sessionId,
        action: 'ended',
        summary,
        duration,
      });

      activeSessions.delete(taskId);
      res.json({ success: true, summary, duration });
    } else {
      res.json({ success: true });
    }
  } catch (err) {
    console.error('[StopAIConversation Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/speak', async (req, res) => {
  const { taskId, text } = req.body;
  if (!taskId || !text) return res.status(400).json({ error: 'taskId and text required' });

  try {
    await controlAIConversation(taskId, text);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 转接 ---
app.post('/api/transfer', async (req, res) => {
  const { taskId, roomId, summary, urgency, callerInfo } = req.body;
  if (!taskId || !roomId) return res.status(400).json({ error: 'taskId and roomId required' });

  try {
    // TODO: 确认 ControlAIConversation 的正确参数后加回 Bot 过渡话
    // 目前直接发通知，不阻塞
    
    // 发送企微通知
    await sendTransferNotify({
      summary: summary || '来电方请求与本人通话',
      urgency: urgency || 7,
      callerInfo: callerInfo || '未知来电',
      roomId,
      taskId,
    });

    // 更新通话状态
    const session = activeSessions.get(taskId);
    if (session) {
      endCall({
        sessionId: session.sessionId,
        action: 'transferred',
        summary: summary || '已转接',
        duration: Math.floor((Date.now() - session.startTime) / 1000),
      });
    }

    res.json({ success: true, message: '转接通知已发送' });
  } catch (err) {
    console.error('[Transfer Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 通话记录 ---
app.get('/api/calls', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(getCalls(limit));
});

app.get('/api/calls/:id', (req, res) => {
  const call = getCall(parseInt(req.params.id));
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

// --- RAG 知识库 ---
app.get('/api/knowledge', (req, res) => {
  res.json(getAllKnowledge());
});

app.post('/api/knowledge', async (req, res) => {
  const { text, source } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  
  const id = await addKnowledge(text, { source: source || 'manual' });
  res.json({ success: true, id });
});

app.post('/api/knowledge/search', async (req, res) => {
  const { query, limit } = req.body;
  if (!query) return res.status(400).json({ error: 'query required' });
  
  const results = await searchKnowledge(query, limit || 3);
  res.json(results);
});

// --- Profile ---
app.get('/api/profile', (req, res) => {
  res.json(profile);
});

app.put('/api/profile', (req, res) => {
  // 更新 Profile（Demo 版只更新内存，不写文件）
  Object.assign(profile, req.body);
  res.json({ success: true, profile });
});

// =============================================
// 启动
// =============================================
async function start() {
  // 初始化 RAG
  await initKnowledge();
  await loadProfileKnowledge(profile);

  app.listen(config.server.port, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           知声 Nous Demo Server v1.0             ║
║──────────────────────────────────────────────────║
║  控制面板: http://localhost:${config.server.port}/index.html  ║
║  来电模拟: http://localhost:${config.server.port}/caller.html ║
║  接入通话: http://localhost:${config.server.port}/join.html   ║
║──────────────────────────────────────────────────║
║  TRTC AppID: ${config.trtc.sdkAppId}                    ║
║  引擎: DeepSeek (${config.deepseek.model})               ║
║  RAG: ${process.env.QDRANT_URL ? 'Qdrant' : '内存模式（降级）'}                            ║
╚══════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
