import TLSSigAPIv2 from 'tls-sig-api-v2';
import config from '../config.js';

/**
 * 生成 TRTC UserSig（进房鉴权凭证）
 * @param {string} userId - 用户ID
 * @param {number} expire - 过期时间（秒），默认24小时
 * @returns {string} userSig
 */
export function generateUserSig(userId, expire = 86400) {
  const api = new TLSSigAPIv2.Api(config.trtc.sdkAppId, config.trtc.secretKey);
  return api.genSig(userId, expire);
}
