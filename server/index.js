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
import { buildOutboundPrompt } from './engine/outbound-prompt.js';
import { generateSummary } from './engine/summary.js';
import { buildRubricPrompt, calculateTransferScore, shouldTransfer, DEFAULT_WEIGHTS } from './engine/rubric.js';
import { sendTransferNotify } from './transfer/notify.js';
import { initKnowledge, addKnowledge, searchKnowledge, getAllKnowledge, loadProfileKnowledge } from './rag/knowledge.js';
import {
  register, login, authMiddleware,
  getUserProfile, saveUserProfile,
  getUserCalls, saveUserCalls,
  getUserKnowledge, saveUserKnowledge,
  findUserByUsername, getAllUsers,
  searchUsers, getFriends, addFriend, removeFriend,
  updateFriendRemark, findUserByZhiyinId
} from './auth/users.js';
import { getVapidPublicKey, saveSubscription, pushIncomingCall, pushTransferNotify } from './push/web-push.js';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(cors());
app.use(express.json());

// sw.js 和 HTML 不缓存（确保用户总是拿到最新版）
app.use((req, res, next) => {
  if (req.path === '/sw.js' || req.path.endsWith('.html') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use(express.static(join(__dirname, '../web')));

// 存储活跃的 AI 对话任务
const activeSessions = new Map();

// 存储待处理的转接通知（每用户独立）
const pendingNotifications = new Map(); // userId → [notifications]

// 代打任务
const outboundTasks = new Map(); // outboundId → task

// =============================================
// 公开 API（无需登录）
// =============================================

// --- 注册 ---
app.post('/api/auth/register', (req, res) => {
  const { username, password, nickname } = req.body;
  const result = register(username, password, nickname);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// --- 登录 ---
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  const result = login(username, password);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// --- Web Push 订阅 ---
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: getVapidPublicKey() });
});

app.post('/api/push/subscribe', authMiddleware, (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'subscription required' });
  saveSubscription(req.userId, subscription);
  res.json({ success: true });
});

// --- TRTC 鉴权（来电方也需要，所以公开）---
app.get('/api/usersig/:userId', (req, res) => {
  const { userId } = req.params;
  const sig = generateUserSig(userId);
  res.json({ sdkAppId: config.trtc.sdkAppId, userId, userSig: sig });
});

// --- 来电方入口：获取机主公开信息 ---
app.get('/api/public/profile/:userId', (req, res) => {
  const profile = getUserProfile(req.params.userId);
  // 只返回公开信息
  res.json({
    nickname: profile.identity.nickname || '知音用户',
    greeting: profile.greeting || '',
  });
});

// --- 来电方发起通话（无需登录）---
app.post('/api/call/start', async (req, res) => {
  const { callerId, ownerUserId } = req.body;
  if (!callerId || !ownerUserId) return res.status(400).json({ error: 'callerId and ownerUserId required' });

  const profile = getUserProfile(ownerUserId);
  const roomId = Math.floor(10000 + Math.random() * 90000);

  try {
    const ragContext = []; // TODO: per-user RAG
    const systemPrompt = buildSystemPrompt(profile, ragContext);

    const result = await startAIConversation({
      roomId,
      targetUserId: callerId,
      systemPrompt,
      profile,
    });

    const sessionId = `session_${roomId}_${Date.now()}`;
    const calls = getUserCalls(ownerUserId);
    const callRecord = {
      id: calls.length + 1,
      session_id: sessionId,
      task_id: result.TaskId,
      room_id: roomId,
      caller_id: callerId,
      start_time: new Date().toISOString(),
      end_time: null,
      duration_seconds: null,
      action_taken: 'in_progress',
      summary: null,
      transcript: [],
    };
    calls.push(callRecord);
    saveUserCalls(ownerUserId, calls);

    activeSessions.set(result.TaskId, {
      sessionId, callId: callRecord.id, roomId, targetUserId: callerId,
      startTime: Date.now(), ownerUserId,
    });

    res.json({ success: true, taskId: result.TaskId, roomId, sdkAppId: config.trtc.sdkAppId });
  } catch (err) {
    console.error('[Call Start Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 代打对方接听（公开 API）---
app.get('/api/outbound/:id', (req, res) => {
  const task = outboundTasks.get(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  // 返回给对方的信息（不暴露内部指令）
  res.json({
    id: task.id,
    roomId: task.roomId,
    ownerName: task.ownerName || '',
    targetName: task.targetName,
    status: task.status,
  });
});

app.post('/api/outbound/start', async (req, res) => {
  const { outboundId, callerId } = req.body;
  const task = outboundTasks.get(outboundId);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  try {
    const profile = getUserProfile(task.ownerUserId);
    const systemPrompt = buildOutboundPrompt(profile, task);

    const result = await startAIConversation({
      roomId: task.roomId,
      targetUserId: callerId,
      systemPrompt,
      profile,
    });

    task.status = 'active';
    task.taskId = result.TaskId;

    const sessionId = `outbound_${task.roomId}_${Date.now()}`;
    const calls = getUserCalls(task.ownerUserId);
    const callRecord = {
      id: calls.length + 1,
      session_id: sessionId,
      task_id: result.TaskId,
      room_id: task.roomId,
      caller_id: `outbound→${task.targetName}`,
      start_time: new Date().toISOString(),
      end_time: null,
      duration_seconds: null,
      action_taken: 'in_progress',
      summary: null,
      transcript: [],
    };
    calls.push(callRecord);
    saveUserCalls(task.ownerUserId, calls);

    activeSessions.set(result.TaskId, {
      sessionId, callId: callRecord.id, roomId: task.roomId,
      targetUserId: callerId, startTime: Date.now(),
      ownerUserId: task.ownerUserId, outboundId,
    });

    res.json({ success: true, taskId: result.TaskId, roomId: task.roomId });
  } catch (err) {
    console.error('[Outbound Start Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Rubric 评分（来电方调用）---
const deepseekClient = new OpenAI({ baseURL: config.deepseek.baseUrl, apiKey: config.deepseek.apiKey });

app.post('/api/rubric/evaluate', async (req, res) => {
  const { transcript, mode, ownerUserId } = req.body;
  if (!transcript || transcript.length === 0) return res.json({ shouldTransfer: false, score: 0, rubric: {} });

  const profile = ownerUserId ? getUserProfile(ownerUserId) : { identity: {}, rules: {}, shaping: [] };
  const conversationText = transcript.map(t => `${t.role === 'caller' ? '来电方' : '知音（我）'}: ${t.text}`).join('\n');
  const rubricPrompt = buildRubricPrompt(profile);

  try {
    const response = await deepseekClient.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        { role: 'system', content: `你是一个转接评分器。根据以下对话和用户画像，对当前对话状态进行 rubric 评分。\n\n## 用户画像\n- 姓名：${profile.identity.name}\n- 必须转接的人：${(profile.rules?.always_transfer||[]).join('、')}\n- 可自动处理的：${(profile.rules?.auto_handle||[]).join('、')}\n- 禁止做的：${(profile.rules?.forbidden_actions||[]).join('、')}\n${profile.shaping?.length > 0 ? '\n## 塑造记录\n' + profile.shaping.map(s => '- ' + s).join('\n') : ''}\n${rubricPrompt}\n\n只输出 JSON，不要其他内容。` },
        { role: 'user', content: `对话内容：\n${conversationText}\n\n请输出 rubric 评分 JSON：` },
      ],
      max_tokens: 200,
      temperature: 0,
      response_format: { type: 'json_object' },
    });

    const raw = response.choices[0].message.content;
    let rubricScores = {};
    try { rubricScores = JSON.parse(raw).rubric || JSON.parse(raw); } catch { rubricScores = {}; }

    const weights = profile.rubric_weights || DEFAULT_WEIGHTS;
    const score = calculateTransferScore(rubricScores, weights);
    const transfer = shouldTransfer(score, mode || 'inbound', profile.transfer_threshold);

    res.json({ shouldTransfer: transfer, score, rubric: rubricScores, threshold: profile.transfer_threshold || 6.0 });
  } catch (err) {
    console.error('[Rubric Evaluate Error]', err.message);
    res.json({ shouldTransfer: false, score: 0, rubric: {}, error: err.message });
  }
});

// =============================================
// 需要登录的 API
// =============================================

// --- Profile ---
app.get('/api/profile', authMiddleware, (req, res) => {
  res.json(getUserProfile(req.userId));
});

app.put('/api/profile', authMiddleware, (req, res) => {
  const profile = getUserProfile(req.userId);
  Object.assign(profile, req.body);
  saveUserProfile(req.userId, profile);
  res.json({ success: true, profile });
});

// --- AI 对话管理（机主端）---
app.post('/api/ai/start', authMiddleware, async (req, res) => {
  const { roomId, targetUserId } = req.body;
  if (!roomId || !targetUserId) return res.status(400).json({ error: 'roomId and targetUserId required' });

  const profile = getUserProfile(req.userId);
  try {
    const ragContext = [];
    const systemPrompt = buildSystemPrompt(profile, ragContext);

    const result = await startAIConversation({
      roomId: parseInt(roomId),
      targetUserId,
      systemPrompt,
      profile,
    });

    const sessionId = `session_${roomId}_${Date.now()}`;
    const calls = getUserCalls(req.userId);
    const callRecord = {
      id: calls.length + 1,
      session_id: sessionId,
      task_id: result.TaskId,
      room_id: parseInt(roomId),
      caller_id: targetUserId,
      start_time: new Date().toISOString(),
      end_time: null,
      duration_seconds: null,
      action_taken: 'in_progress',
      summary: null,
      transcript: [],
    };
    calls.push(callRecord);
    saveUserCalls(req.userId, calls);

    activeSessions.set(result.TaskId, {
      sessionId, callId: callRecord.id, roomId: parseInt(roomId),
      targetUserId, startTime: Date.now(), ownerUserId: req.userId,
    });

    res.json({ success: true, taskId: result.TaskId, sessionId, callId: callRecord.id });
  } catch (err) {
    console.error('[StartAIConversation Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ai/stop', authMiddleware, async (req, res) => {
  const { taskId } = req.body;
  if (!taskId) return res.status(400).json({ error: 'taskId required' });

  try {
    await stopAIConversation(taskId);
    const session = activeSessions.get(taskId);
    if (session) {
      const duration = Math.floor((Date.now() - session.startTime) / 1000);
      const calls = getUserCalls(session.ownerUserId);
      const call = calls.find(c => c.id === session.callId);
      const summary = await generateSummary(call?.transcript || []);

      if (call) {
        call.end_time = new Date().toISOString();
        call.action_taken = 'ended';
        call.summary = summary;
        call.duration_seconds = duration;
        saveUserCalls(session.ownerUserId, calls);
      }
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

app.post('/api/ai/speak', authMiddleware, async (req, res) => {
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
  const { taskId, roomId, summary: clientSummary, urgency, callerInfo } = req.body;
  if (!taskId || !roomId) return res.status(400).json({ error: 'taskId and roomId required' });

  try {
    let summary = clientSummary || '来电方请求直接沟通';
    const session = activeSessions.get(taskId);
    let ownerUserId = session?.ownerUserId;

    if (session) {
      const calls = getUserCalls(ownerUserId);
      const call = calls.find(c => c.id === session.callId);
      if (call?.transcript?.length > 0) {
        summary = await generateSummary(call.transcript);
      }
    }

    await sendTransferNotify({ summary, urgency: urgency || 7, callerInfo: callerInfo || '未知来电', roomId, taskId });

    // 推到对应用户的通知队列 + Web Push
    if (ownerUserId) {
      if (!pendingNotifications.has(ownerUserId)) pendingNotifications.set(ownerUserId, []);
      pendingNotifications.get(ownerUserId).push({
        type: 'transfer', taskId, roomId, summary,
        urgency: urgency || 7, callerInfo: callerInfo || '未知来电',
        timestamp: Date.now(),
      });

      // Web Push 通知机主
      pushTransferNotify(ownerUserId, { summary, roomId, taskId })
        .catch(err => console.error('[Push Transfer Error]', err.message));
    }

    if (session) {
      const calls = getUserCalls(ownerUserId);
      const call = calls.find(c => c.id === session.callId);
      if (call) {
        call.end_time = new Date().toISOString();
        call.action_taken = 'transferred';
        call.summary = summary;
        call.duration_seconds = Math.floor((Date.now() - session.startTime) / 1000);
        saveUserCalls(ownerUserId, calls);
      }
    }

    res.json({ success: true, summary, message: '转接通知已发送' });
  } catch (err) {
    console.error('[Transfer Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 通话记录 ---
app.get('/api/calls', authMiddleware, (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const calls = getUserCalls(req.userId);
  res.json([...calls].reverse().slice(0, limit));
});

app.get('/api/calls/:id', authMiddleware, (req, res) => {
  const calls = getUserCalls(req.userId);
  const call = calls.find(c => c.id === parseInt(req.params.id));
  if (!call) return res.status(404).json({ error: 'Call not found' });
  res.json(call);
});

// --- 知识库 ---
app.get('/api/knowledge', authMiddleware, (req, res) => {
  res.json(getUserKnowledge(req.userId));
});

app.post('/api/knowledge', authMiddleware, (req, res) => {
  const { text, source } = req.body;
  if (!text) return res.status(400).json({ error: 'text required' });
  const knowledge = getUserKnowledge(req.userId);
  const entry = { id: Date.now(), text, source: source || 'manual', created_at: new Date().toISOString() };
  knowledge.push(entry);
  saveUserKnowledge(req.userId, knowledge);
  res.json({ success: true, id: entry.id });
});

app.delete('/api/knowledge/:id', authMiddleware, (req, res) => {
  const knowledge = getUserKnowledge(req.userId);
  const idx = knowledge.findIndex(k => k.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  knowledge.splice(idx, 1);
  saveUserKnowledge(req.userId, knowledge);
  res.json({ success: true });
});

// --- 塑造 ---
app.get('/api/shaping', authMiddleware, (req, res) => {
  const profile = getUserProfile(req.userId);
  res.json(profile.shaping || []);
});

app.post('/api/shaping', authMiddleware, (req, res) => {
  const { instruction } = req.body;
  if (!instruction) return res.status(400).json({ error: 'instruction required' });
  const profile = getUserProfile(req.userId);
  if (!profile.shaping) profile.shaping = [];
  profile.shaping.push(instruction);
  saveUserProfile(req.userId, profile);
  res.json({ success: true, shaping: profile.shaping });
});

app.delete('/api/shaping/:index', authMiddleware, (req, res) => {
  const profile = getUserProfile(req.userId);
  const idx = parseInt(req.params.index);
  if (!profile.shaping || idx < 0 || idx >= profile.shaping.length) return res.status(404).json({ error: 'not found' });
  profile.shaping.splice(idx, 1);
  saveUserProfile(req.userId, profile);
  res.json({ success: true, shaping: profile.shaping });
});

// --- 来电通知（机主轮询）---
app.get('/api/notifications', authMiddleware, (req, res) => {
  const notifications = pendingNotifications.get(req.userId) || [];
  pendingNotifications.set(req.userId, []);
  res.json(notifications);
});

// --- 代打（机主创建任务）---
app.post('/api/outbound/create', authMiddleware, (req, res) => {
  const { instruction, targetName, targetUsername } = req.body;
  if (!instruction) return res.status(400).json({ error: 'instruction required' });

  const profile = getUserProfile(req.userId);
  const roomId = Math.floor(10000 + Math.random() * 90000);
  const outboundId = 'ob_' + Date.now();
  const SERVER_BASE = process.env.SERVER_BASE_URL || `http://localhost:${config.server.port}`;
  const callLink = `${SERVER_BASE}/outbound.html?id=${outboundId}`;

  // 如果对方也是注册用户，查找他的 userId
  const targetUserId = targetUsername ? findUserByUsername(targetUsername) : null;

  outboundTasks.set(outboundId, {
    id: outboundId,
    instruction,
    targetName: targetName || '对方',
    targetUsername: targetUsername || null,
    targetUserId,
    ownerUserId: req.userId,
    ownerName: profile.identity.nickname || profile.identity.name || '',
    roomId,
    status: 'pending',
    callLink,
    taskId: null,
    summary: null,
    createdAt: Date.now(),
  });

  // 如果对方是注册用户 → 推送来电弹窗 + Web Push
  if (targetUserId) {
    if (!pendingNotifications.has(targetUserId)) pendingNotifications.set(targetUserId, []);
    pendingNotifications.get(targetUserId).push({
      type: 'incoming_call',
      outboundId,
      roomId,
      callerName: profile.identity.nickname || '知音用户',
      message: `${profile.identity.nickname || '有人'}有事要跟你说`,
      timestamp: Date.now(),
    });

    // Web Push 系统通知（即使 App 没打开也能收到）
    pushIncomingCall(targetUserId, {
      callerName: profile.identity.nickname || '知音用户',
      roomId,
      outboundId,
      message: `${profile.identity.nickname || '有人'}有事要跟你说`,
    }).catch(err => console.error('[Push Error]', err.message));
  }

  res.json({ success: true, outboundId, callLink, roomId, targetIsRegistered: !!targetUserId });
});

app.get('/api/outbound', authMiddleware, (req, res) => {
  const tasks = [...outboundTasks.values()]
    .filter(t => t.ownerUserId === req.userId)
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(tasks);
});

// --- 用户信息 ---
app.get('/api/me', authMiddleware, (req, res) => {
  res.json({ userId: req.userId, username: req.username });
});

// --- 通讯录（好友） ---
app.get('/api/friends', authMiddleware, (req, res) => {
  const friends = getFriends(req.userId);
  res.json(friends);
});

app.post('/api/friends/add', authMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: '请输入对方用户名' });
  const friendUserId = findUserByUsername(username);
  if (!friendUserId) return res.status(404).json({ error: '用户不存在' });
  if (friendUserId === req.userId) return res.status(400).json({ error: '不能添加自己' });

  const friendProfile = getUserProfile(friendUserId);
  const result = addFriend(req.userId, friendUserId, username, friendProfile.identity?.nickname || username);
  if (result.error) return res.status(400).json(result);
  res.json({ success: true, friend: { userId: friendUserId, username, nickname: friendProfile.identity?.nickname || username } });
});

app.delete('/api/friends/:userId', authMiddleware, (req, res) => {
  const result = removeFriend(req.userId, req.params.userId);
  res.json(result);
});

app.get('/api/users/search', authMiddleware, (req, res) => {
  const q = req.query.q || '';
  if (q.length < 1) return res.json([]);
  const results = searchUsers(q, req.userId);
  res.json(results);
});

// --- 好友备注 ---
app.put('/api/friends/:userId/remark', authMiddleware, (req, res) => {
  const { remark } = req.body;
  const result = updateFriendRemark(req.userId, req.params.userId, remark || '');
  if (result.error) return res.status(400).json(result);
  res.json({ success: true });
});

// --- 按知音号拨出（不需要加好友）---
app.post('/api/call/dial', authMiddleware, async (req, res) => {
  const { zhiyinId, instruction } = req.body;
  if (!zhiyinId) return res.status(400).json({ error: '请输入知音号' });
  if (!instruction) return res.status(400).json({ error: '请说明要说什么事' });

  const target = findUserByZhiyinId(zhiyinId);
  const profile = getUserProfile(req.userId);
  const roomId = Math.floor(10000 + Math.random() * 90000);
  const outboundId = 'ob_' + Date.now();
  const SERVER_BASE = process.env.SERVER_BASE_URL || `http://localhost:${config.server.port}`;

  outboundTasks.set(outboundId, {
    id: outboundId,
    instruction,
    targetName: target ? target.nickname : zhiyinId,
    targetUsername: zhiyinId,
    targetUserId: target ? target.userId : null,
    ownerUserId: req.userId,
    ownerName: profile.identity.nickname || profile.identity.name || '',
    roomId,
    status: 'pending',
    callLink: `${SERVER_BASE}/outbound.html?id=${outboundId}`,
    taskId: null,
    summary: null,
    createdAt: Date.now(),
  });

  // 对方是注册用户 → Push 通知
  if (target) {
    if (!pendingNotifications.has(target.userId)) pendingNotifications.set(target.userId, []);
    pendingNotifications.get(target.userId).push({
      type: 'incoming_call',
      outboundId, roomId,
      callerName: profile.identity.nickname || req.username,
      message: `${profile.identity.nickname || '有人'}有事要跟你说`,
      timestamp: Date.now(),
    });
    pushIncomingCall(target.userId, {
      callerName: profile.identity.nickname || req.username,
      roomId, outboundId,
      message: `${profile.identity.nickname || '有人'}有事要跟你说`,
    }).catch(err => console.error('[Push Error]', err.message));
  }

  res.json({
    success: true, outboundId, roomId,
    targetExists: !!target,
    callLink: target ? null : `${SERVER_BASE}/outbound.html?id=${outboundId}`,
  });
});

// --- 对话式塑造 ---
app.post('/api/shaping/chat', authMiddleware, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const profile = getUserProfile(req.userId);
  const shapingHistory = profile.shaping || [];

  try {
    const response = await deepseekClient.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        { role: 'system', content: `你是"知音"——用户的数字分身。用户正在教你了解 TA 自己。
你的任务：
1. 理解用户说的内容，提取成一条简短的规则/知识
2. 用口语化一句话确认你学到了什么
3. 然后问下一个相关问题继续了解用户（除非用户说不聊了）

保持轻松亲切，像朋友聊天。每次回复不超过2句话。
已经学过的：${shapingHistory.join('；') || '暂无'}` },
        { role: 'user', content: message },
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const reply = response.choices[0].message.content;

    // 自动提取规则存入 shaping
    const extracted = message.trim();
    if (extracted.length > 2) {
      if (!profile.shaping) profile.shaping = [];
      profile.shaping.push(extracted);
      saveUserProfile(req.userId, profile);
    }

    res.json({ success: true, reply, saved: extracted });
  } catch (err) {
    console.error('[Shaping Chat Error]', err.message);
    res.json({ reply: '记住了。还有什么要告诉我的吗？', saved: message });
  }
});

// --- 邀请链接 ---
app.get('/api/invite-link', authMiddleware, (req, res) => {
  const SERVER_BASE = process.env.SERVER_BASE_URL || `http://localhost:${config.server.port}`;
  const link = `${SERVER_BASE}/invite.html?from=${req.username}`;
  res.json({ link, zhiyinId: req.username });
});

// =============================================
// 启动
// =============================================
async function start() {
  await initKnowledge();

  app.listen(config.server.port, () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║           知音 Nous Demo Server v2.0             ║
║──────────────────────────────────────────────────║
║  机主端: http://localhost:${config.server.port}/index.html    ║
║  来电页: http://localhost:${config.server.port}/call.html     ║
║──────────────────────────────────────────────────║
║  TRTC AppID: ${config.trtc.sdkAppId}                    ║
║  引擎: DeepSeek (${config.deepseek.model})               ║
║  认证: 账号密码注册 + JWT Token              ║
║  数据: 每用户独立隔离                         ║
╚══════════════════════════════════════════════════╝
    `);
  });
}

start().catch(console.error);
