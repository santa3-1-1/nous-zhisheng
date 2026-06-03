/**
 * 转接通知模块 — 推送到企微群机器人
 */

const WECOM_WEBHOOK_URL = process.env.WECOM_WEBHOOK_URL;
const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://localhost:3002';

/**
 * 发送转接通知到企微
 * @param {object} options
 * @param {string} options.summary - 通话摘要
 * @param {number} options.urgency - 紧急度 0-10
 * @param {string} options.callerInfo - 来电方信息
 * @param {number} options.roomId - TRTC 房间号
 * @param {string} options.taskId - AI 对话任务 ID
 */
export async function sendTransferNotify({ summary, urgency, callerInfo, roomId, taskId }) {
  if (!WECOM_WEBHOOK_URL) {
    console.warn('[Notify] WECOM_WEBHOOK_URL not configured');
    return;
  }

  const joinUrl = `${SERVER_BASE_URL}/join.html?room=${roomId}&taskId=${taskId}`;
  
  const content = [
    `## ⚠️ 知音转接提醒`,
    `> **来电方**: ${callerInfo || '未知号码'}`,
    `> **摘要**: ${summary}`,
    `> **紧急度**: ${urgency}/10`,
    ``,
    `[👉 点击接入通话](${joinUrl})`,
  ].join('\n');

  try {
    const res = await fetch(WECOM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { content },
      }),
    });
    const result = await res.json();
    
    if (result.errcode === 0) {
      console.log('[Notify] 转接通知已发送到企微');
    } else {
      console.error('[Notify] 发送失败:', result);
    }
    
    return result;
  } catch (err) {
    console.error('[Notify] 发送异常:', err.message);
  }
}
