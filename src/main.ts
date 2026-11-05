import 'dotenv/config';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { EventDispatcher } from '@larksuiteoapi/node-sdk';
import { loadConfig } from './config.js';
import { createFeishu } from './feishu.js';
import { Sessions } from './sessions.js';
import { Bot } from './bot.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const runtimeDir = await mkdtemp(join(config.dataDir, 'run-'));
  const sessions = new Sessions(config);
  const { messenger, ws } = createFeishu(config);
  const bot = new Bot(config, runtimeDir, messenger, sessions);
  const interval = setInterval(() => { void sessions.sweep().catch(() => console.error('过期会话清理失败。')); }, 60_000);
  interval.unref();
  if (!config.botOpenId) console.info('FEISHU_BOT_OPEN_ID 未配置：可在私聊使用；配置后可响应群聊 @ 提问。');
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    ws.close({ force: true });
    clearInterval(interval);
    console.info('正在停止机器人并清理数据。');
    const deadline = setTimeout(() => {
      void sessions.close().finally(() => rm(runtimeDir, { recursive: true, force: true }).finally(() => process.exit(0)));
    }, 20_000);
    try { await bot.close(); await rm(runtimeDir, { recursive: true, force: true }); }
    finally { clearTimeout(deadline); }
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  try {
    await ws.start({ eventDispatcher: new EventDispatcher({}).register({ 'im.message.receive_v1': event => { bot.accept(event); } }) });
    console.info(`AVA 飞书机器人已启动，长连接状态：${ws.getConnectionStatus().state}`);
  } catch {
    await shutdown();
    throw new Error('飞书长连接启动失败，请检查应用凭据、长连接订阅配置和网络。');
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : '启动失败。'); process.exitCode = 1; });
