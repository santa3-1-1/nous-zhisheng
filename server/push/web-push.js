/**
 * Web Push 通知模块
 * 
 * 用户安装 PWA 后订阅推送 → 有来电时发送系统通知
 * 点击通知 → 打开知音进入通话
 */
import webpush from 'web-push';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBS_DIR = join(__dirname, '../../data/push-subscriptions');

if (!existsSync(SUBS_DIR)) mkdirSync(SUBS_DIR, { recursive: true });

// VAPID 配置
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BGw6uncb_ioepg7Ik2GlPKlQnT_98-dCt7XQ4Nj0Q3PJGLZN_hTx-tH7pEgVT2fryzXd2gLTncLVHy48oAf7CFM';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'f7VBv3XIOxcWX_jA4JjSFbl3P_-4Weo2r3oSFW5eDFo';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:nous@zhiyin.app';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

/**
 * 获取 VAPID public key（前端订阅需要）
 */
export function getVapidPublicKey() {
  return VAPID_PUBLIC_KEY;
}

/**
 * 保存用户的推送订阅
 */
export function saveSubscription(userId, subscription) {
  const file = join(SUBS_DIR, `${userId}.json`);
  // 一个用户可能多设备，存为数组
  let subs = [];
  if (existsSync(file)) {
    try { subs = JSON.parse(readFileSync(file, 'utf-8')); } catch { subs = []; }
  }
  // 去重（按 endpoint）
  const exists = subs.find(s => s.endpoint === subscription.endpoint);
  if (!exists) {
    subs.push(subscription);
    writeFileSync(file, JSON.stringify(subs, null, 2));
  }
  console.log(`[Push] 用户 ${userId} 已订阅推送（共 ${subs.length} 个设备）`);
}

/**
 * 删除用户的推送订阅
 */
export function removeSubscription(userId, endpoint) {
  const file = join(SUBS_DIR, `${userId}.json`);
  if (!existsSync(file)) return;
  let subs = [];
  try { subs = JSON.parse(readFileSync(file, 'utf-8')); } catch { return; }
  subs = subs.filter(s => s.endpoint !== endpoint);
  writeFileSync(file, JSON.stringify(subs, null, 2));
}

/**
 * 向用户发送推送通知
 */
export async function sendPushNotification(userId, payload) {
  const file = join(SUBS_DIR, `${userId}.json`);
  if (!existsSync(file)) {
    console.log(`[Push] 用户 ${userId} 无订阅，跳过推送`);
    return false;
  }

  let subs = [];
  try { subs = JSON.parse(readFileSync(file, 'utf-8')); } catch { return false; }

  const message = JSON.stringify(payload);
  let sent = false;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, message);
      sent = true;
      console.log(`[Push] 已推送给用户 ${userId}`);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // 订阅已失效，清除
        removeSubscription(userId, sub.endpoint);
        console.log(`[Push] 清除失效订阅: ${userId}`);
      } else {
        console.error(`[Push] 推送失败:`, err.message);
      }
    }
  }

  return sent;
}

/**
 * 发送来电通知
 */
export async function pushIncomingCall(userId, { callerName, roomId, outboundId, message }) {
  return sendPushNotification(userId, {
    type: 'incoming_call',
    title: `${callerName || '知音'}来电`,
    body: message || '有人通过知音联系你',
    data: {
      type: 'incoming_call',
      roomId,
      outboundId,
      url: outboundId ? `/outbound.html?id=${outboundId}` : `/call.html`,
    },
  });
}

/**
 * 发送转接通知给机主
 */
export async function pushTransferNotify(userId, { summary, roomId, taskId }) {
  return sendPushNotification(userId, {
    type: 'transfer',
    title: '知音需要你接手',
    body: summary || '有来电需要你亲自处理',
    data: {
      type: 'transfer',
      roomId,
      taskId,
      url: `/index.html`,
    },
  });
}
