/**
 * 知音 Rubric 评分系统 — 通用底座
 * 
 * 每轮对话后，LLM 对当前状态进行多维度评分
 * 加权总分超过阈值 → 触发转接
 * 权重由机主画像动态决定
 */

// 默认权重（新用户 / 画像未成熟时使用）
export const DEFAULT_WEIGHTS = {
  identity_match: 0.20,      // 对方身份 vs 机主关注名单
  topic_relevance: 0.25,     // 事情 vs 机主在意的领域
  capability_fit: 0.20,      // 知音能不能代处理
  boundary_violation: 0.15,  // 是否触碰机主底线
  explicit_signal: 0.10,     // 对方是否明确要求本人
  decay: 0.10,               // 多轮空转/无法推进
};

// 默认转接阈值
export const DEFAULT_THRESHOLD = {
  inbound: 6.0,   // 代接模式
  outbound: 7.0,  // 代打模式（有明确指令，容忍度更高）
};

/**
 * 构建 rubric 评分指令（嵌入到 system prompt 中）
 * @param {object} profile - 机主画像
 * @returns {string} rubric 评分部分的 prompt
 */
export function buildRubricPrompt(profile) {
  // 从画像中提取个性化上下文
  const vipNames = profile.rules?.always_transfer?.join('、') || '未设置';
  const autoHandleScenes = profile.rules?.auto_handle?.join('、') || '未设置';
  const forbidden = profile.rules?.forbidden_actions?.join('、') || '未设置';
  const shaping = profile.shaping || []; // 用户"塑造"过的规则

  const shapingContext = shaping.length > 0
    ? `\n## 用户的偏好和习惯（"塑造"记录）\n${shaping.map(s => `- ${s}`).join('\n')}`
    : '';

  return `
## 转接评分（每轮必须输出）

你每次回复时，必须同时输出一个 JSON 评分对象。评分基于"这件事对机主来说意味着什么"，不是通用规则。

### 评分维度（每个 1-10 分）

1. **identity_match** — 对方身份是否在机主的重要名单里？
   - 1分：完全陌生人/推销/骚扰
   - 5分：普通认识的人，关系一般
   - 10分：机主明确标注的重要人（${vipNames}）

2. **topic_relevance** — 这件事机主在不在意？
   - 1分：机主完全不care的事（如推销保险）
   - 5分：有点关系但不紧急
   - 10分：直接关系到机主当前核心工作/生活重要事项

3. **capability_fit** — 你（知音）能不能替机主处理好？
   - 1分：你完全能搞定（如确认快递、拒绝推销）
   - 5分：你勉强能应付但不完美
   - 10分：你完全没法处理（需要决策/承诺/敏感操作/你没有信息）
   - 参考可自动处理的：${autoHandleScenes}

4. **boundary_violation** — 是否触碰机主的底线/禁区？
   - 1分：完全安全
   - 5分：打擦边球
   - 10分：明确触碰禁区（${forbidden}）

5. **explicit_signal** — 对方是否给出"要找本人"的信号？
   - 1分：完全没提
   - 5分：暗示想直接沟通
   - 10分：明确说"我要跟TA本人说"

6. **decay** — 对话是否在空转/僵持？
   - 1分：对话推进顺利
   - 5分：有点卡但还在推进
   - 10分：连续多轮无法推进，陷入循环
${shapingContext}

### 输出格式

你每次回复的格式必须是：
\`\`\`json
{
  "reply": "你对来电方说的话（自然口语）",
  "rubric": {
    "identity_match": <1-10>,
    "topic_relevance": <1-10>,
    "capability_fit": <1-10>,
    "boundary_violation": <1-10>,
    "explicit_signal": <1-10>,
    "decay": <1-10>
  }
}
\`\`\`

不要输出其他格式。即使你判断需要转接，也先打分再说转接的话。`;
}

/**
 * 计算加权转接分数
 * @param {object} rubricScores - {identity_match, topic_relevance, ...}
 * @param {object} weights - 权重对象（来自画像，或使用默认）
 * @returns {number} 0-10 的加权分数
 */
export function calculateTransferScore(rubricScores, weights = DEFAULT_WEIGHTS) {
  let score = 0;
  for (const [dim, weight] of Object.entries(weights)) {
    score += (rubricScores[dim] || 0) * weight;
  }
  return Math.round(score * 100) / 100;
}

/**
 * 判断是否应该转接
 * @param {number} score - 加权分数
 * @param {string} mode - 'inbound' | 'outbound'
 * @param {number} customThreshold - 自定义阈值（来自画像）
 * @returns {boolean}
 */
export function shouldTransfer(score, mode = 'inbound', customThreshold = null) {
  const threshold = customThreshold || DEFAULT_THRESHOLD[mode] || 6.0;
  return score >= threshold;
}
