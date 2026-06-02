import dotenv from 'dotenv';
dotenv.config();

export default {
  trtc: {
    sdkAppId: parseInt(process.env.TRTC_SDK_APP_ID),
    secretKey: process.env.TRTC_SECRET_KEY,
  },
  tencent: {
    secretId: process.env.TENCENT_SECRET_ID,
    secretKey: process.env.TENCENT_SECRET_KEY,
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  engine: {
    version: process.env.ENGINE_VERSION || 'v1',
  },
  server: {
    port: parseInt(process.env.PORT) || 3000,
  },
};
