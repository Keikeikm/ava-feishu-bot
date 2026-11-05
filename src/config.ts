import { resolve } from 'node:path';
import type { LLMConfig } from '@antv/ava';

export interface Config {
  appId: string;
  appSecret: string;
  botOpenId: string;
  llm: LLMConfig;
  allowedUsers: Set<string>;
  dataDir: string;
  maxFileBytes: number;
  maxSessions: number;
  sessionTtlMs: number;
  jobTimeoutMs: number;
  maxResultRows: number;
  enableCharts: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, requireFeishu = true): Config {
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`请在 .env 中配置 ${name}，参考 .env.example。`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(env[name]?.trim() || fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} 必须是 ${min}～${max} 之间的整数。`);
    return n;
  };
  const baseURL = env.LLM_BASE_URL?.trim();
  if (baseURL && !/^https?:\/\//.test(baseURL)) throw new Error('LLM_BASE_URL 必须是 http(s) API 地址。');
  if (env.ENABLE_CHARTS && !['true', 'false'].includes(env.ENABLE_CHARTS)) throw new Error('ENABLE_CHARTS 只能填写 true 或 false。');
  return {
    appId: requireFeishu ? required('FEISHU_APP_ID') : env.FEISHU_APP_ID || '',
    appSecret: requireFeishu ? required('FEISHU_APP_SECRET') : env.FEISHU_APP_SECRET || '',
    botOpenId: env.FEISHU_BOT_OPEN_ID?.trim() || '',
    llm: { model: required('LLM_MODEL'), apiKey: required('LLM_API_KEY'), ...(baseURL ? { baseURL } : {}), maxRetries: 1 },
    allowedUsers: new Set((env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean)),
    dataDir: resolve(env.DATA_DIR || './data'),
    maxFileBytes: integer('MAX_FILE_MB', 20, 1, 100) * 1024 * 1024,
    maxSessions: integer('MAX_SESSIONS', 8, 1, 32),
    sessionTtlMs: integer('SESSION_TTL_MINUTES', 60, 1, 1440) * 60_000,
    jobTimeoutMs: integer('JOB_TIMEOUT_SECONDS', 180, 10, 600) * 1000,
    maxResultRows: integer('MAX_RESULT_ROWS', 500, 1, 10_000),
    enableCharts: env.ENABLE_CHARTS !== 'false',
  };
}
