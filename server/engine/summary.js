/**
 * 通话纪要生成 — 通话结束后调用 DeepSeek 总结
 */
import OpenAI from 'openai';
import config from '../config.js';

const client = new OpenAI({
  baseURL: config.deepseek.baseUrl,
  apiKey: config.deepseek.apiKey,
});

/**
 * 根据对话记录生成通话纪要
 * @param {Array} transcript - [{role: 'caller'|'nous', text: '...'}]
 * @returns {string} 一段简短的纪要文字
 */
export async function generateSummary(transcript) {
  if (!transcript || transcript.length === 0) {
    return '无对话记录';
  }

  const conversationText = transcript
    .map(t => `${t.role === 'caller' ? '来电方' : '知声'}: ${t.text}`)
    .join('\n');

  try {
    const response = await client.chat.completions.create({
      model: config.deepseek.model,
      messages: [
        {
          role: 'system',
          content: '你是一个通话纪要生成器。请用3-5句话简洁总结这通电话的要点，格式：谁来电、什么事、处理结果、是否需要后续跟进。不要用Markdown格式，纯文字即可。',
        },
        {
          role: 'user',
          content: `请总结以下通话内容：\n\n${conversationText}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.3,
    });

    return response.choices[0].message.content.trim();
  } catch (err) {
    console.error('[Summary] 生成纪要失败:', err.message);
    return `通话记录 ${transcript.length} 轮对话（纪要生成失败）`;
  }
}
