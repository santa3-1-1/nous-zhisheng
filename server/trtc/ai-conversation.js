import * as tencentcloud from 'tencentcloud-sdk-nodejs-trtc';
import config from '../config.js';
import { generateUserSig } from './usersig.js';

const TrtcClient = tencentcloud.trtc.v20190722.Client;

const client = new TrtcClient({
  credential: {
    secretId: config.tencent.secretId,
    secretKey: config.tencent.secretKey,
  },
  region: 'ap-guangzhou',
  profile: {
    httpProfile: { endpoint: 'trtc.tencentcloudapi.com' },
  },
});

/**
 * 启动 AI 对话
 * - AI Bot 自动进入指定 TRTC 房间
 * - 自动完成 ASR → LLM(DeepSeek) → TTS → 推流
 */
export async function startAIConversation({ roomId, targetUserId, systemPrompt, profile }) {
  const params = {
    SdkAppId: config.trtc.sdkAppId,
    RoomId: String(roomId),
    RoomIdType: 0, // 数字房间号
    AgentConfig: {
      UserId: 'nous_bot_001',
      UserSig: generateUserSig('nous_bot_001'),
      TargetUserId: targetUserId,
    },
    // LLM 配置 — 接入 DeepSeek
    LLMConfig: JSON.stringify({
      LLMType: 'openai',
      Model: config.deepseek.model,
      APIKey: config.deepseek.apiKey,
      APIUrl: `${config.deepseek.baseUrl}/v1/chat/completions`,
      Streaming: true,
      SystemPrompt: systemPrompt,
      Timeout: 5.0,
      History: 10,
      MaxTokens: 300,
      Temperature: 0.7,
    }),
    // TTS 配置 — TRTC 内置音色
    TTSConfig: JSON.stringify({
      TTSType: profile.voice.tts_type,
      VoiceId: profile.voice.voice_id,
      Model: profile.voice.model,
      Speed: profile.voice.speed,
      Language: profile.voice.language,
    }),
  };

  console.log('[StartAIConversation] Params:', JSON.stringify(params, null, 2));
  
  const result = await client.StartAIConversation(params);
  console.log('[StartAIConversation] Success, TaskId:', result.TaskId);
  return result;
}

/**
 * 停止 AI 对话
 */
export async function stopAIConversation(taskId) {
  const params = {
    TaskId: taskId,
  };
  
  const result = await client.StopAIConversation(params);
  console.log('[StopAIConversation] Success');
  return result;
}

/**
 * 控制 AI Bot 主动播报一段话
 */
export async function controlAIConversation(taskId, text) {
  const params = {
    TaskId: taskId,
    Command: 'speak',
    Text: text,
  };
  
  const result = await client.ControlAIConversation(params);
  console.log('[ControlAIConversation] Bot speaking:', text);
  return result;
}
