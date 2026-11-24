/**
 * AI chat module — DeepSeek API only.
 * Uses OpenAI-compatible chat/completions endpoint.
 * With persistent conversation history (saved to disk).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------- 持久化配置 ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');
const HISTORY_DIR = path.join(PROJECT_ROOT, '.config', 'history');

if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

const MAX_HISTORY = 200;
const conversations = new Map();

// ---- 辅助函数（不变） ----
function getHistoryFile(userId) {
  const safeId = userId.replace(/[\\/:*?"<>|]/g, '_');
  return path.join(HISTORY_DIR, `history_${safeId}.json`);
}

function loadHistoryFromDisk(userId) {
  const filePath = getHistoryFile(userId);
  if (fs.existsSync(filePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (Array.isArray(data)) {
        if (data.length > MAX_HISTORY) {
          const trimmed = data.slice(-MAX_HISTORY);
          fs.writeFileSync(filePath, JSON.stringify(trimmed, null, 2), 'utf-8');
          return trimmed;
        }
        return data;
      }
    } catch (err) {
      console.error(`  [WARN] Failed to load history for ${userId}:`, err.message);
    }
  }
  return [];
}

function saveHistoryToDisk(userId, history) {
  const filePath = getHistoryFile(userId);
  try {
    let dataToSave = history;
    if (dataToSave.length > MAX_HISTORY) {
      dataToSave = dataToSave.slice(-MAX_HISTORY);
    }
    fs.writeFileSync(filePath, JSON.stringify(dataToSave, null, 2), 'utf-8');
  } catch (err) {
    console.error(`  [WARN] Failed to save history for ${userId}:`, err.message);
  }
}

function getHistory(userId) {
  if (!conversations.has(userId)) {
    const diskHistory = loadHistoryFromDisk(userId);
    conversations.set(userId, diskHistory);
  }
  return conversations.get(userId);
}

function addMessage(userId, role, content) {
  const h = getHistory(userId);
  h.push({ role, content });
  if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
  saveHistoryToDisk(userId, h);
}

export function clearHistory(userId) {
  conversations.delete(userId);
  const filePath = getHistoryFile(userId);
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      console.error(`  [WARN] Failed to delete history file for ${userId}:`, err.message);
    }
  }
}

/**
 * 历史概况（给 /历史 命令用）：当前上下文里有多少条消息、多少字。
 */
export function getHistoryInfo(userId) {
  const h = getHistory(userId);
  const chars = h.reduce((n, m) => n + (typeof m.content === 'string' ? m.content.length : 0), 0);
  return {
    count: h.length,
    chars,
    lastRole: h.length ? h[h.length - 1].role : null,
    file: getHistoryFile(userId),
  };
}

// ---- 系统提示词（可自定） ----
const SYSTEM_PROMPT = '你是一个专业的 AI 助手，回答简洁清晰，保持友好；不确定的内容要说明，不要编造。';

// ---- 核心聊天函数 ----
export async function chat(config, userId, userText) {
  if (config.provider === 'echo') {
    return userText;
  }

  addMessage(userId, 'user', userText);
  const history = getHistory(userId);

  let reply;
  try {
    reply = await callDeepSeek(config, history);
  } catch (err) {
    const h = getHistory(userId);
    if (h.length && h[h.length - 1].role === 'user') {
      h.pop();
      saveHistoryToDisk(userId, h);
    }
    throw err;
  }

  addMessage(userId, 'assistant', reply);
  return reply;
}

/**
 * 思考模式：默认跟随服务端（开启）；config.thinking = 'disabled' 可关闭。
 * 实测同一问题：开 107 token / 关 38 token，关掉更快也更省。
 */
function thinkingField(config) {
  return config.thinking === 'disabled' ? { thinking: { type: 'disabled' } } : {};
}

// ---- 调用 DeepSeek API ----
async function callDeepSeek(config, history) {
  const baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  // 超时可配，默认 120 秒：避免网络挂住时整个轮询循环卡死
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 120000;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...history],
        // 不再写死小额度：默认 4096，够一段完整回复；仍可通过 config.maxTokens 调整
        max_tokens: Number(config.maxTokens) > 0 ? Number(config.maxTokens) : 4096,
        ...thinkingField(config),
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s），请稍后重试`);
    }
    throw new Error(`网络错误：${err?.message || err}`);
  }

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();

  // 空回复不把内部占位符透给用户
  if (!text) {
    const reason = data.choices?.[0]?.finish_reason;
    if (reason === 'length') throw new Error('回复被长度限制截断，请把问题拆短一些');
    if (reason === 'content_filter') throw new Error('这个问题被内容策略拦截了，换个说法试试');
    throw new Error('模型没有返回内容，请稍后重试');
  }
  return text;
}

/**
 * 一次性问答：不进长期对话历史，也不带角色设定。
 * 用于「搜索后总结」「读网页后总结」这类工具性请求。
 *
 * @param {object} config   { apiKey, baseUrl, model }
 * @param {string} system   这次请求专用的系统提示
 * @param {string} user     用户内容（可含检索到的资料）
 * @param {object} opts     { maxTokens, timeoutMs }
 */
export async function chatOnce(config, system, user, opts = {}) {
  const baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 120000;
  const maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : 1200;

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model || 'deepseek-chat',
        messages,
        max_tokens: maxTokens,
        ...thinkingField(config),
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s），请稍后重试`);
    }
    throw new Error(`网络错误：${err?.message || err}`);
  }

  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`DeepSeek API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) {
    const reason = data.choices?.[0]?.finish_reason;
    if (reason === 'length') throw new Error('内容太长被截断，请缩短问题');
    throw new Error('模型没有返回内容，请稍后重试');
  }
  return text;
}
function cleanupConversations() {
  if (conversations.size > 500) {
    const entries = [...conversations.entries()];
    const toRemove = entries.slice(0, entries.length - 200);
    for (const [key] of toRemove) conversations.delete(key);
  }
}
