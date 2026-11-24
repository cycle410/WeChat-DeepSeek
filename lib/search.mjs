/**
 * 联网能力 —— DeepSeek 官方 Search / Fetch API
 *
 *   searchWeb(config, query, { count })  → POST /v1/tools/search
 *   fetchUrl(config, url)                → POST /v1/tools/fetch
 *
 * 计费：成功且有结果才计费（Search 5 元/千次，Fetch 5 元/千次）；
 *       失败、无结果、超时都不计费。
 * 限速：Search 100 QPS，Fetch 25 QPS（账号级）。
 */

const DEFAULT_TIMEOUT_MS = 30000;
const RETRY_DELAY_MS = 1000;

/** 从 config.baseUrl 推导出 https://api.deepseek.com/v1 */
function apiBase(config) {
  const raw = (config && config.baseUrl) || 'https://api.deepseek.com/v1';
  const noTrailing = String(raw).replace(/\/+$/, '');
  // baseUrl 可能带或不带 /v1
  return /\/v1$/.test(noTrailing) ? noTrailing : noTrailing + '/v1';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 统一的 POST 调用：错误分类 + 有限重试
 * 402 余额不足、401 Key 失效 → 不重试
 * 429 限流、5xx → 重试一次
 */
async function postJson(config, path, body, { retry = 1, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!config || !config.apiKey) throw new Error('没有可用的 API Key，请先配置');
  const url = apiBase(config) + path;

  let lastError = null;
  for (let attempt = 0; attempt <= retry; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      lastError = err?.name === 'TimeoutError'
        ? new Error('请求超时，请稍后重试')
        : new Error(`网络错误：${err?.message || err}`);
      if (attempt < retry) { await sleep(RETRY_DELAY_MS); continue; }
      throw lastError;
    }

    if (res.ok) {
      try { return await res.json(); }
      catch { throw new Error('返回内容不是合法 JSON'); }
    }

    const text = await res.text().catch(() => '');
    const detail = text.slice(0, 160).replace(/\s+/g, ' ');

    if (res.status === 401) throw new Error('API Key 无效或已过期');
    if (res.status === 402) throw new Error('DeepSeek 账户余额不足，搜索无法使用');
    if (res.status === 403) throw new Error(`该请求被拒绝（HTTP 403）：${detail}`);
    if (res.status === 404) throw new Error(`服务返回 404：${detail}`);
    if (res.status === 400) throw new Error(`请求参数有误：${detail}`);

    if (res.status === 429 || res.status >= 500) {
      lastError = new Error(res.status === 429
        ? '搜索频率超限，请稍后再试'
        : `搜索服务暂时不可用（HTTP ${res.status}）`);
      if (attempt < retry) { await sleep(RETRY_DELAY_MS); continue; }
      throw lastError;
    }

    throw new Error(`搜索失败（HTTP ${res.status}）：${detail}`);
  }
  throw lastError || new Error('搜索失败');
}

/**
 * 搜索网页
 * @param {object} config  { apiKey, baseUrl }
 * @param {string} query   搜索词（1~128 字符），支持 site: / -site: / lang: / after: 等语法
 * @param {object} opts    { count 1~50, needContent 是否返回正文, oriQuestion, timeoutMs }
 * @returns {Promise<Array>} [{ title, url, summary, snippet, content, siteName, date, authority, score }]
 */
export async function searchWeb(config, query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词不能为空');
  if (q.length > 128) throw new Error('搜索词太长了（最多 128 字符）');

  const body = {
    query: q,
    count: Math.min(50, Math.max(1, Number(opts.count) || 5)),
    need_content: opts.needContent === true,
  };
  if (opts.oriQuestion) body.ori_question = String(opts.oriQuestion).slice(0, 128);

  const data = await postJson(config, '/tools/search', body, { timeoutMs: opts.timeoutMs });

  const results = Array.isArray(data && data.results) ? data.results : [];
  return results.map((r) => ({
    title: r.title || '',
    url: r.url || '',
    summary: r.summary || '',
    snippet: r.snippet || '',
    content: r.content || '',
    siteName: r.site_name || '',
    date: r.date || '',
    authority: typeof r.authority === 'number' ? r.authority : -1,
    score: typeof r.rerank_score === 'number' ? r.rerank_score : 0,
  }));
}

/**
 * 抓取单个网页，返回 Markdown 正文
 * @returns {Promise<{title: string, content: string}>}
 */
export async function fetchUrl(config, url, opts = {}) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw new Error('链接必须以 http:// 或 https:// 开头');
  if (u.length > 8192) throw new Error('链接太长了');

  const data = await postJson(config, '/tools/fetch', { url: u }, { timeoutMs: opts.timeoutMs });
  return {
    title: (data && data.title) || '',
    content: (data && data.content) || '',
  };
}

/**
 * 把搜索结果整理成给模型阅读的文本块
 */
export function formatSearchResults(results, max = 5) {
  const list = (results || []).slice(0, Math.max(1, max));
  if (!list.length) return '';
  return list.map((r, i) => {
    const bits = [
      `[${i + 1}] ${r.title || '(无标题)'}`,
      `链接：${r.url}`,
      r.date ? `日期：${String(r.date).slice(0, 10)}` : '',
      r.siteName ? `站点：${r.siteName}` : '',
      `摘要：${(r.summary || r.snippet || '').slice(0, 500)}`,
    ].filter(Boolean);
    return bits.join('\n');
  }).join('\n\n');
}

/**
 * 把结果整理成给用户看的「来源清单」
 */
export function formatSources(results, max = 5) {
  const list = (results || []).slice(0, Math.max(1, max));
  if (!list.length) return '';
  return list.map((r, i) => `${i + 1}. ${r.title || '(无标题)'}\n   ${r.url}`).join('\n');
}
