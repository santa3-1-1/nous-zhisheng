/**
 * RAG 知识库模块 — Qdrant + DeepSeek Embedding
 * 
 * 如果 Qdrant 未运行，自动降级为内存检索（Demo 模式）
 */
import config from '../config.js';

// 内存模式的知识存储（Qdrant 不可用时降级使用）
const memoryStore = [];

let qdrantClient = null;
let useMemoryMode = true;

const COLLECTION_NAME = 'nous_knowledge';
const VECTOR_SIZE = 1536; // text-embedding-3-small

/**
 * 初始化知识库（尝试连接 Qdrant，失败则降级为内存模式）
 */
export async function initKnowledge() {
  try {
    const { QdrantClient } = await import('@qdrant/js-client-rest');
    qdrantClient = new QdrantClient({ url: process.env.QDRANT_URL || 'http://localhost:6333' });
    
    // 尝试连接
    await qdrantClient.getCollections();
    
    // 创建集合（如果不存在）
    try {
      await qdrantClient.createCollection(COLLECTION_NAME, {
        vectors: { size: VECTOR_SIZE, distance: 'Cosine' },
      });
      console.log('[RAG] Qdrant集合已创建:', COLLECTION_NAME);
    } catch (e) {
      // 集合已存在，正常
    }
    
    useMemoryMode = false;
    console.log('[RAG] Qdrant 连接成功，使用向量检索模式');
  } catch (err) {
    console.log('[RAG] Qdrant 不可用，使用内存关键词检索模式（Demo降级）');
    useMemoryMode = true;
  }
}

/**
 * 文本向量化（调用 DeepSeek embedding 或 OpenAI）
 */
async function embed(text) {
  // 优先用 OpenAI embedding（如果有 key）
  const apiKey = process.env.OPENAI_API_KEY || config.deepseek.apiKey;
  const baseUrl = process.env.OPENAI_API_KEY 
    ? 'https://api.openai.com' 
    : config.deepseek.baseUrl;
  const model = process.env.OPENAI_API_KEY 
    ? 'text-embedding-3-small' 
    : 'deepseek-chat'; // DeepSeek 暂不支持 embedding，降级

  // 如果没有 OpenAI key，使用简单的关键词匹配降级
  if (!process.env.OPENAI_API_KEY) {
    return null; // 触发内存模式
  }

  const res = await fetch(`${baseUrl}/v1/embeddings`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, input: text }),
  });
  const data = await res.json();
  return data.data[0].embedding;
}

/**
 * 添加知识条目
 */
export async function addKnowledge(text, metadata = {}) {
  const entry = { 
    id: Date.now(), 
    text, 
    ...metadata, 
    created_at: new Date().toISOString() 
  };

  if (!useMemoryMode && qdrantClient) {
    const vector = await embed(text);
    if (vector) {
      await qdrantClient.upsert(COLLECTION_NAME, {
        points: [{ id: entry.id, vector, payload: entry }],
      });
    }
  }
  
  // 同时存入内存（作为备份/降级）
  memoryStore.push(entry);
  console.log(`[RAG] 知识已添加: "${text.substring(0, 50)}..."`);
  return entry.id;
}

/**
 * 检索相关知识
 */
export async function searchKnowledge(query, limit = 3) {
  // 向量检索模式
  if (!useMemoryMode && qdrantClient) {
    const vector = await embed(query);
    if (vector) {
      const results = await qdrantClient.search(COLLECTION_NAME, {
        vector,
        limit,
        with_payload: true,
      });
      return results.map(r => r.payload.text);
    }
  }
  
  // 降级：简单关键词匹配
  const queryWords = query.toLowerCase().split(/\s+/);
  const scored = memoryStore.map(entry => {
    const text = entry.text.toLowerCase();
    const score = queryWords.filter(w => text.includes(w)).length;
    return { text: entry.text, score };
  });
  
  return scored
    .filter(s => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(s => s.text);
}

/**
 * 获取所有知识条目（管理用）
 */
export function getAllKnowledge() {
  return memoryStore;
}

/**
 * 从 Profile 加载初始知识
 */
export async function loadProfileKnowledge(profile) {
  // 如果 Profile 未填写，跳过
  if (!profile.identity.name || !profile.onboarding_completed) {
    console.log('[RAG] Profile 未完成引导，跳过知识加载');
    return;
  }

  const entries = [
    `${profile.identity.name}的职位是${profile.identity.role}，在${profile.identity.company}工作`,
    `${profile.identity.nickname}的快递放门口架子上`,
  ];
  
  for (const faq of profile.faq) {
    if (faq.q && faq.a) {
      entries.push(`问：${faq.q} 答：${faq.a}`);
    }
  }

  for (const entry of entries) {
    await addKnowledge(entry, { source: 'profile' });
  }
  
  console.log(`[RAG] 从 Profile 加载了 ${entries.length} 条知识`);
}
