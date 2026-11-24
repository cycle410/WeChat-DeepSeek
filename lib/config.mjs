/**
 * Config persistence — project-local ./.config/
 * Security: all sensitive files are chmod 600, API keys are masked in logs.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// 获取当前文件的目录，进而推导项目根目录
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.join(__dirname, '..');

// 将数据目录指向项目本地文件夹
export const DATA_DIR = path.join(PROJECT_ROOT, '.config');

export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const TOKEN_FILE = path.join(DATA_DIR, 'token.json');

function ensureDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try { fs.chmodSync(DATA_DIR, 0o700); } catch {}
}

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function saveConfig(config) {
  ensureDir();
  const safe = { ...config };
  if (safe.apiKey) {
    safe._encKey = encryptKey(safe.apiKey);
    delete safe.apiKey;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(safe, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch {}
}

export function loadConfigWithKey() {
  const config = loadConfig();
  if (config._encKey) {
    try {
      config.apiKey = decryptKey(config._encKey);
    } catch {
      config.apiKey = '';
    }
    delete config._encKey;
  }
  return config;
}

/**
 * 微信登录 token —— 与 API Key 同级敏感，同样加密落盘。
 * 旧版本是明文 JSON，读到就顺手迁移成密文（_enc 字段）。
 */
export function loadToken() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));

    // 新格式：{ "_enc": "iv:密文" }
    if (raw && typeof raw._enc === 'string') {
      try { return JSON.parse(decryptKey(raw._enc)); }
      catch { return null; }   // 换了机器/密文损坏 → 当作未登录，重新扫码
    }

    // 旧格式：明文 token，立刻迁移
    if (raw && raw.token) {
      try { saveToken(raw); } catch { /* 迁移失败也不影响本次运行 */ }
      return raw;
    }
    return null;
  } catch { /* ignore */ }
  return null;
}

export function saveToken(token) {
  ensureDir();
  const payload = { _enc: encryptKey(JSON.stringify(token)) };
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2));
  try { fs.chmodSync(TOKEN_FILE, 0o600); } catch {}
}

/** Mask API key for safe logging: sk-abc...xyz */
export function maskKey(key) {
  if (!key || key.length < 8) return '***';
  return key.slice(0, 6) + '...' + key.slice(-3);
}

// ── Simple key obfuscation (not military-grade, but prevents plaintext on disk) ──

const MACHINE_ID = (() => {
  try {
    return crypto.createHash('sha256')
      .update(os.hostname() + os.homedir() + os.userInfo().username)
      .digest();
  } catch {
    return crypto.createHash('sha256').update('weixin-bot-default').digest();
  }
})();

function encryptKey(plaintext) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', MACHINE_ID, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function decryptKey(encoded) {
  const parts = encoded.split(':');
  if (parts.length !== 2) throw new Error('Invalid encrypted key format. Delete ./.config/config.json and reconfigure.');
  const [ivHex, encHex] = parts;
  const decipher = crypto.createDecipheriv('aes-256-cbc', MACHINE_ID, Buffer.from(ivHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf-8');
}