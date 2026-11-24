#!/usr/bin/env node
/**
 * WeChat-DeepSeek — WeChat AI Bot with DeepSeek API
 *
 * Usage:
 *   WeChat-DeepSeek                          # Interactive setup (first time)
 *   WeChat-DeepSeek --model deepseek-chat    # Use specific model
 *   WeChat-DeepSeek --api-key sk-xxx         # Provide API key
 *   WeChat-DeepSeek --login                  # Force re-login
 */
import { parseArgs } from 'node:util';
import { startBot } from '../lib/bot.mjs';
import { interactiveSetup } from '../lib/setup.mjs';
import { loadConfigWithKey, saveConfig } from '../lib/config.mjs';

const { values: args } = parseArgs({
  options: {
    'api-key':    { type: 'string' },
    'model':      { type: 'string' },
    'login':      { type: 'boolean', default: false },
    'help':       { type: 'boolean', short: 'h', default: false },
    'version':    { type: 'boolean', short: 'v', default: false },
  },
  strict: false,
});

if (args.version) {
  const pkg = JSON.parse((await import('fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  console.log(`WeChat-DeepSeek v${pkg.version}`);
  process.exit(0);
}

if (args.help) {
  console.log(`
  WeChat-DeepSeek — WeChat AI Bot with DeepSeek API

  Usage:
    WeChat-DeepSeek                    Interactive setup (first time)
    WeChat-DeepSeek --model deepseek-chat   Use a specific model
    WeChat-DeepSeek --api-key sk-xxx        Provide API key
    WeChat-DeepSeek --login            Force re-login (new QR code)

  Options:
    --api-key <key>  DeepSeek API key
    --model <name>   DeepSeek model (default: deepseek-chat)
    --login          Force re-login even if token exists
    -h, --help       Show this help
    -v, --version    Show version

  Environment:
    DEEPSEEK_API_KEY  Your DeepSeek API key

  Examples:
    WeChat-DeepSeek --model deepseek-reasoner
    WeChat-DeepSeek --api-key sk-xxx --model deepseek-chat
    WeChat-DeepSeek --login
`);
  process.exit(0);
}

async function main() {
  console.log('\n  WeChat-DeepSeek — WeChat AI Bot with DeepSeek API\n');

  let config = loadConfigWithKey();

  // 从环境变量读取 API Key
  if (process.env.DEEPSEEK_API_KEY) {
    config.apiKey = process.env.DEEPSEEK_API_KEY;
  }

  // CLI 参数覆盖
  if (args['api-key']) config.apiKey = args['api-key'];
  if (args.model) config.model = args.model;

  // 如果缺少必要配置，启动交互式设置
  if (!config.apiKey || !config.model) {
    config = await interactiveSetup(config);
    saveConfig(config);
  }

  // 默认值
  if (!config.model) config.model = 'deepseek-chat';
  if (!config.baseUrl) config.baseUrl = 'https://api.deepseek.com/v1';
  config.provider = 'deepseek';

  await startBot(config, { forceLogin: args.login });
}

main().catch((err) => {
  console.error('\n  [ERROR] Fatal:', err.message);
  process.exit(1);
});