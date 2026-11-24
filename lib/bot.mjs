/**
 * Main bot loop — login + poll + AI reply + auto-reconnect.
 */
import { loadToken, saveToken, maskKey } from './config.mjs';
import { getQrCode, pollQrStatus, getUpdates, sendText, sendTyping, extractText } from './weixin.mjs';
import { chat, chatOnce, clearHistory, getHistoryInfo } from './ai.mjs';
import { searchWeb, fetchUrl, formatSearchResults, formatSources } from './search.mjs';
import { renderQR } from './qr.mjs';

const BASE_URL = 'https://ilinkai.weixin.qq.com';
const MAX_RECONNECT = 5;
const RECONNECT_DELAY = [3000, 5000, 10000, 20000, 30000];

async function login(forceLogin) {
  if (!forceLogin) {
    const saved = loadToken();
    if (saved?.token) {
      console.log(`  [OK] Using saved session (Bot: ${saved.accountId || 'unknown'})`);
      console.log(`       Saved at: ${saved.savedAt || 'unknown'}\n`);
      return saved;
    }
  }

  console.log('  [INFO] WeChat QR Login\n');
  const qrResp = await getQrCode();
  let qrcode = qrResp.qrcode;

  displayQR(qrResp.qrcode_img_content);

  const deadline = Date.now() + 5 * 60_000;
  let refreshCount = 0;

  while (Date.now() < deadline) {
    const status = await pollQrStatus(qrcode);

    if (status.status === 'scaned') {
      console.log('  [INFO] Scanned! Confirm on your phone...');
    }

    if (status.status === 'expired') {
      if (++refreshCount > 3) throw new Error('QR expired 3 times');
      console.log(`  [WARN] QR expired, refreshing (${refreshCount}/3)...`);
      const newQr = await getQrCode();
      qrcode = newQr.qrcode;
      displayQR(newQr.qrcode_img_content);
    }

    if (status.status === 'confirmed') {
      const session = {
        token: status.bot_token,
        baseUrl: status.baseurl || BASE_URL,
        accountId: status.ilink_bot_id,
        userId: status.ilink_user_id,
        savedAt: new Date().toISOString(),
      };
      saveToken(session);
      console.log(`  [OK] Login successful! Bot ID: ${session.accountId}\n`);
      return session;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  throw new Error('Login timeout');
}

function displayQR(url) {
  if (!url) {
    console.log('  [WARN] No QR URL received\n');
    return;
  }

  console.log('  [INFO] Scan with WeChat:\n');

  // Try terminal QR rendering
  const qrArt = renderQR(url);
  if (qrArt) {
    for (const line of qrArt.split('\n')) {
      console.log('  ' + line);
    }
    console.log();
  }

  // Always show URL as fallback
  console.log(`  [INFO] Or open: ${url}\n`);
  console.log('  Waiting for scan...');
}

function formatTime() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// Slash commands
const COMMANDS = {
  '/clear': (userId) => { clearHistory(userId); return '[OK] Conversation cleared.'; },
  '/历史': (userId) => {
    const info = getHistoryInfo(userId);
    if (!info.count) return '当前没有对话历史。';
    return [
      `对话历史：${info.count} 条消息 / 约 ${info.chars} 字`,
      `最后一条：${info.lastRole === 'user' ? '你' : '我'}`,
      '发 /clear 可以清空。',
    ].join('\n');
  },
  '/help': () => `可用命令：
/clear — 清除聊天记录
/历史 — 查看当前对话历史概况
/help — 显示本帮助
/ping — 测试机器人是否在线
/status — 显示机器人状态
/搜 关键词 — 联网搜索并总结（会附来源链接）
/读 链接 — 读取网页正文并总结`,
  '/ping': () => 'Pong!',

};

export async function startBot(config, { forceLogin = false } = {}) {
  const session = await login(forceLogin);

  const providerLabel = config.provider === 'echo' ? 'Echo'
    : (config.model || 'default');

  // Mask sensitive info in logs
  const keyDisplay = config.apiKey ? maskKey(config.apiKey) : 'env/none';

  console.log(`  [OK] WeChat-DeepSeek is running!`);
  console.log(`  AI: ${providerLabel}`);
  console.log(`  Key: ${keyDisplay}`);
  console.log(`  Press Ctrl+C to stop.\n`);
  console.log('  ' + '─'.repeat(30) + '\n');

  // Add /status command dynamically
  const startTime = Date.now();
  let totalMessages = 0;
  COMMANDS['/status'] = () => {
    const uptime = Math.floor((Date.now() - startTime) / 60000);
    return `WeChat-DeepSeek status\nUptime: ${uptime}m\nMessages: ${totalMessages}\nAI: ${providerLabel}`;
    
  };

  await pollLoop(config, session, { startTime, onMessage: () => totalMessages++ });
}

async function pollLoop(config, session, ctx) {
  let { token, baseUrl } = session;
  let running = true;
  let buf = '';
  let reconnectCount = 0;

  process.on('SIGINT', () => {
    console.log('\n\n  [INFO] Bye!');
    running = false;
    setTimeout(() => process.exit(0), 500);
  });

  while (running) {
    try {
      const resp = await getUpdates(baseUrl, token, buf);
      if (resp.get_updates_buf) buf = resp.get_updates_buf;

      // Session expired — try auto-reconnect
      if (resp.errcode === -14 || resp.errcode === -13) {
        console.log(`\n  [WARN] Session expired (code: ${resp.errcode})`);

        if (reconnectCount >= MAX_RECONNECT) {
          console.log('  [ERROR] Max reconnect attempts reached. Run with --login to re-authenticate.');
          process.exit(1);
        }

        reconnectCount++;
        const delay = RECONNECT_DELAY[Math.min(reconnectCount - 1, RECONNECT_DELAY.length - 1)];
        console.log(`  [INFO] Reconnecting (${reconnectCount}/${MAX_RECONNECT}) in ${delay / 1000}s...`);
        await new Promise(r => setTimeout(r, delay));

        try {
          const newSession = await login(true);
          token = newSession.token;
          baseUrl = newSession.baseUrl;
          buf = '';
          reconnectCount = 0;
          console.log('  [OK] Reconnected!\n');
        } catch (loginErr) {
          console.error(`  [ERROR] Reconnect failed: ${loginErr.message}`);
        }
        continue;
      }

      // Reset reconnect counter on successful poll
      reconnectCount = 0;

      for (const msg of resp.msgs || []) {
        if (msg.message_type !== 1) continue;

        const from = msg.from_user_id;
        const text = extractText(msg);
        const ctx_token = msg.context_token;
        ctx.onMessage();

        // Sanitize user input for logging (prevent log injection)
        const safeText = text.replace(/[\n\r]/g, ' ').slice(0, 200);
        const safeFrom = from.replace(/[\n\r]/g, '');

        console.log(`  [MSG] [${formatTime()}] From: ${safeFrom}`);
        console.log(`        Text: ${safeText}`);

        // Check slash commands
        const cmdKey = text.trim().toLowerCase();
        const cmd = COMMANDS[cmdKey];
        if (cmd) {
          const reply = typeof cmd === 'function' ? cmd(from) : cmd;
          await sendText(baseUrl, token, from, reply, ctx_token);
          console.log(`        [OK] ${reply.split('\n')[0]}\n`);
          continue;
        }

        // Skip non-text for AI (media labels from extractText)
        const mediaLabels = ['[图片]', '[视频]', '[语音]'];
        const isMedia = mediaLabels.some(l => text === l) || text.startsWith('[文件]');
        if (isMedia) {
          await sendText(baseUrl, token, from, `收到${text}，目前仅支持文字对话~`, ctx_token);
          console.log(`        [SKIP] Media ignored\n`);
          continue;
        }

        // Rate limit check (simple per-user cooldown)
        if (isRateLimited(from)) {
          await sendText(baseUrl, token, from, '请稍等，消息太频繁了~', ctx_token);
          console.log(`        [RATE] Rate limited\n`);
          continue;
        }

        sendTyping(baseUrl, token, from, ctx_token).catch(() => {});  // 失败忽略：不影响回复

        // ── 联网命令：/搜 <词>、/读 <链接> ──
        const netCmd = parseNetCommand(text);
        if (netCmd) {
          const t0 = Date.now();
          try {
            const reply = await runNetCommand(config, netCmd);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            for (const chunk of splitMessage(reply, 1800)) {
              await sendText(baseUrl, token, from, chunk, ctx_token);
            }
            console.log(`        [OK] [${elapsed}s] ${netCmd.kind}: ${reply.slice(0, 60).replace(/\s+/g, ' ')}…\n`);
          } catch (netErr) {
            console.log(`        [ERROR] ${netCmd.kind} failed: ${netErr.message}\n`);
            await sendText(baseUrl, token, from, `联网查询失败：${netErr.message}`, ctx_token).catch(() => {});
          }
          continue;
        }

        console.log(`        [AI] Thinking...`);
        const startTime = Date.now();

        try {
          const reply = await chat(config, from, text);
          const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

          const chunks = splitMessage(reply, 1800);
          for (const chunk of chunks) {
            await sendText(baseUrl, token, from, chunk, ctx_token);
          }

          const preview = reply.length > 80 ? reply.slice(0, 80) + '…' : reply;
          console.log(`        [OK] [${elapsed}s] ${preview}\n`);
        } catch (aiErr) {
          console.log(`        [ERROR] AI error: ${aiErr.message}\n`);
          await sendText(baseUrl, token, from, '抱歉，AI 处理出错了，请稍后再试~', ctx_token).catch(() => {});
        }
      }
    } catch (err) {
      if (!running) break;
      console.error(`  [WARN] Poll error: ${err.message}, retrying in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

// ── Rate limiting ──

const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 3000; // 同一用户两条消息最小间隔 3 秒（与 README 一致）
const RATE_LIMIT_MAX = 10; // 每分钟最多 10 条（每次都要调用大模型，避免烧额度）

function isRateLimited(userId) {
  const now = Date.now();
  let entry = rateLimits.get(userId);

  // Periodic cleanup: remove stale entries
  if (rateLimits.size > 500) {
    for (const [id, e] of rateLimits) {
      if (now - e.last > 300000) rateLimits.delete(id); // 5 min stale
    }
  }

  if (!entry) {
    entry = { last: now, count: 1, windowStart: now };
    rateLimits.set(userId, entry);
    return false;
  }

  // Per-minute limit
  if (now - entry.windowStart > 60000) {
    entry.windowStart = now;
    entry.count = 0;
  }
  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) return true;

  // Cooldown between messages
  if (now - entry.last < RATE_LIMIT_WINDOW) return true;

  entry.last = now;
  return false;
}

// ── 联网命令（/搜、/读）──

/**
 * 解析联网命令：
 *   /搜 关键词   搜一下 关键词   搜索 关键词   /search 关键词
 *   /读 链接     /read 链接     读一下 链接
 */
function parseNetCommand(raw) {
  const t = String(raw || '').trim();
  let m = t.match(/^(?:\/搜|\/search|搜一下|搜索一下|搜索)\s+([\s\S]+)$/i);
  if (m && m[1].trim()) return { kind: 'search', arg: m[1].trim() };
  m = t.match(/^(?:\/读|\/read|读一下|读网页)\s+([\s\S]+)$/i);
  if (m && m[1].trim()) return { kind: 'read', arg: m[1].trim() };
  return null;
}

const SEARCH_SYSTEM = [
  '你是信息整理助手。根据用户问题与检索资料作答，要求：',
  '1) 先给结论，再列要点；',
  '2) 关键信息后用方括号标注来源序号，例如 [1]；',
  '3) 全文不超过 400 字；',
  '4) 资料不足就直说缺什么，不要编造。',
].join('\n');

const READ_SYSTEM = '你是网页摘要助手。用中文简要总结网页要点，200 字以内，保留关键数据与结论；不要写网页里没有的内容。';

async function runNetCommand(config, cmd) {
  if (cmd.kind === 'search') {
    const results = await searchWeb(config, cmd.arg, { count: 5 });
    if (!results.length) return `没有搜到「${cmd.arg}」的结果，换个说法再试。`;

    const material = formatSearchResults(results, 5);
    const answer = await chatOnce(
      config,
      SEARCH_SYSTEM,
      `用户问题：${cmd.arg}\n\n检索资料：\n${material}`,
      { maxTokens: 800 },
    );
    return `${answer}\n\n来源：\n${formatSources(results, 5)}`;
  }

  if (cmd.kind === 'read') {
    const page = await fetchUrl(config, cmd.arg);
    const body = String(page.content || '').slice(0, 12000);
    if (!body.trim()) return `没能取到正文：${cmd.arg}`;

    const answer = await chatOnce(
      config,
      READ_SYSTEM,
      `网页标题：${page.title || '(无标题)'}\n网页正文（已截断）：\n${body}`,
      { maxTokens: 600 },
    );
    return `${answer}\n\n原文：${cmd.arg}`;
  }

  return '未知的联网命令';
}

function splitMessage(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) {
      // Try to split at space or CJK boundary
      splitAt = remaining.lastIndexOf(' ', maxLen);
      if (splitAt < maxLen * 0.3) splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return chunks;
}