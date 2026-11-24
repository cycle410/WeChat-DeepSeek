/**
 * Interactive first-time setup — DeepSeek API.
 * Prompts for API key and model name.
 */
import readline from 'node:readline';

function ask(rl, question) {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function interactiveSetup(config) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('  DeepSeek API Setup\n');
  console.log('  This bot uses DeepSeek API as the AI backend.');
  console.log('  You can get your API key from https://platform.deepseek.com/\n');

  const apiKey = await ask(rl, '  Enter your DeepSeek API key: ');
  const model = await ask(rl, '  Enter model name [deepseek-chat]: ') || 'deepseek-chat';

  config.apiKey = apiKey.trim();
  config.model = model.trim();
  config.provider = 'deepseek';
  config.baseUrl = 'https://api.deepseek.com/v1';

  rl.close();
  console.log(`\n  [OK] DeepSeek configured with model: ${config.model}\n`);
  console.log('  [INFO] You can change settings later by editing ./.config/config.json\n');

  return config;
}