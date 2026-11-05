import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Card } from './cards.js';
import type { Config } from './config.js';
import type { IncomingMessage } from './types.js';
import { UserError } from './errors.js';
import { elapsedMs, logEvent } from './logging.js';

function permissionScopes(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const data = body as { msg?: unknown; error?: { permission_violations?: { subject?: unknown }[] } };
  const subjects = Array.isArray(data.error?.permission_violations) ? data.error.permission_violations.map(v => v?.subject) : [];
  if (!subjects.length && typeof data.msg === 'string') {
    const list = data.msg.match(/scopes? (?:is|are) required:\s*\[([^\]]+)\]/i)?.[1];
    if (list) subjects.push(...list.split(',').map(s => s.trim()));
  }
  return [...new Set(subjects.filter((s): s is string => typeof s === 'string' && s.length <= 120 && /^[a-z][a-z0-9_.-]*(?::[a-z0-9_.-]+)+$/.test(s)))].slice(0, 20);
}

function downloadError(code?: number, httpStatus?: number, nativeCode?: string, body?: unknown): UserError {
  const requiredScopes = permissionScopes(body);
  const diagnostic = { errorType: 'Error', httpStatus, nativeCode, feishuCode: code, requiredScopes };
  if (code === 99991672) {
    const instruction = requiredScopes.includes('im:message:readonly')
      ? '请开通应用身份权限 im:message:readonly（获取单聊、群组消息）。im:resource 不能替代此消息读取权限。'
      : requiredScopes.length ? `接口要求的权限为：${requiredScopes.join('、')}。请按接口要求开通对应的应用身份权限。`
        : '请核对该接口的消息读取权限；飞书未返回具体缺失权限名，可查看终端诊断日志。';
    return new UserError(`飞书拒绝下载附件：${instruction}发布新版本后重启机器人，再重新发送文件。`, 'FEISHU_DOWNLOAD_PERMISSION', 'download', diagnostic);
  }
  const details = [code ? `飞书错误码 ${code}` : '', httpStatus ? `HTTP ${httpStatus}` : ''].filter(Boolean).join('，');
  return new UserError(`文件下载失败${details ? `（${details}）` : ''}，请检查文件资源权限和网络后重试。`, 'FEISHU_DOWNLOAD', 'download', diagnostic);
}

async function fileDownloadFailure(error: unknown): Promise<UserError> {
  if (error instanceof UserError) return error;
  const value = error as { code?: string; response?: { status?: number; data?: unknown } };
  let data = value?.response?.data;
  if (data instanceof Readable) {
    const stream = data;
    const timer = setTimeout(() => stream.destroy(new Error('Response timeout')), 5000);
    try {
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 16_384) break;
        parts.push(bytes);
      }
      data = Buffer.concat(parts).toString('utf8');
    } catch { data = undefined; }
    finally { clearTimeout(timer); }
  }
  if (Buffer.isBuffer(data)) data = data.toString('utf8');
  if (typeof data === 'string') { try { data = JSON.parse(data.slice(0, 16_384)); } catch { data = undefined; } }
  const code = data && typeof data === 'object' && 'code' in data && typeof data.code === 'number' ? data.code : undefined;
  const nativeCode = typeof value?.code === 'string' && /^[A-Z][A-Z0-9_]{1,50}$/.test(value.code) ? value.code : undefined;
  return downloadError(code, value?.response?.status, nativeCode, data);
}

export interface Messenger {
  text(message: IncomingMessage, text: string): Promise<void>;
  card(message: IncomingMessage, card: Card): Promise<void>;
  file(message: IncomingMessage, name: string, data: Buffer): Promise<void>;
  download(message: IncomingMessage, destination: string): Promise<void>;
}

export async function writeBoundedFile(stream: Readable, destination: string, maxBytes: number): Promise<void> {
  let size = 0;
  await pipeline(stream, new Transform({ transform(chunk: Buffer, _encoding, callback) {
    size += chunk.length;
    if (size > maxBytes) callback(new UserError(`文件超过 ${Math.floor(maxBytes / 1024 / 1024)} MB 限制，请缩小文件后重试。`));
    else callback(null, chunk);
  } }), createWriteStream(destination, { flags: 'wx', mode: 0o600 }), { signal: AbortSignal.timeout(45_000) });
  if (!(await stat(destination)).size) throw new UserError('文件内容为空，请重新发送有数据的表格。');
}

// SDK error objects can contain Authorization headers. Log only fixed diagnostic labels.
const logger: lark.Logger = {
  error: () => console.error('[feishu] SDK 请求或连接异常，请检查应用配置及权限。'),
  warn: () => console.warn('[feishu] SDK 连接警告。'),
  info: () => {}, debug: () => {}, trace: () => {},
};

export function createFeishu(config: Config, transport?: lark.HttpInstance): { messenger: Messenger; ws: lark.WSClient } {
  // The SDK's interceptor unwraps Axios responses; its exported Axios type does not reflect that.
  const httpInstance = new Proxy(lark.defaultHttpInstance, {
    get(target, property) {
      if (property === 'request') return (options: lark.HttpRequestOptions<unknown>) => target.request({ ...options, timeout: 30_000 });
      if (['post', 'put', 'patch'].includes(String(property))) return (url: string, data: unknown, options: lark.HttpRequestOptions<unknown> = {}) => target.request({ ...options, url, data, method: String(property), timeout: 30_000 });
      if (['get', 'delete', 'head', 'options'].includes(String(property))) return (url: string, options: lark.HttpRequestOptions<unknown> = {}) => target.request({ ...options, url, method: String(property), timeout: 30_000 });
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as lark.HttpInstance;
  const base = { appId: config.appId, appSecret: config.appSecret, domain: lark.Domain.Feishu, logger, loggerLevel: lark.LoggerLevel.warn, httpInstance: transport || httpInstance };
  const client = new lark.Client({ ...base, appType: lark.AppType.SelfBuild });
  const ws = new lark.WSClient({ ...base, handshakeTimeoutMs: 15_000,
    onReady: () => console.info('[feishu] 长连接已连接，可以接收消息。'),
    onReconnecting: () => console.info('[feishu] 正在重连。'),
    onReconnected: () => console.info('[feishu] 长连接已恢复。'),
    onError: () => console.error('[feishu] 长连接失败，请检查应用凭据、订阅配置和网络。'),
  });
  const sends = new Map<string, Promise<void>>();
  const lastSent = new Map<string, number>();
  async function reply(message: IncomingMessage, type: string, content: object): Promise<void> {
    const startedAt = performance.now();
    const serialized = JSON.stringify(content);
    const previous = sends.get(message.chatId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const wait = Math.max(0, 300 - (Date.now() - (lastSent.get(message.chatId) || 0)));
      if (wait) await new Promise(resolve => setTimeout(resolve, wait));
      lastSent.set(message.chatId, Date.now());
      const result = await client.im.message.reply({
        path: { message_id: message.id },
        data: { msg_type: type, content: serialized, uuid: createHash('sha256').update(`${message.id}:${type}:${serialized}`).digest('hex').slice(0, 32) },
      });
      if (result.code !== 0) throw new UserError(`飞书消息发送失败（错误码 ${result.code ?? '未知'}），请检查机器人发言权限。`, 'FEISHU_SEND');
    });
    sends.set(message.chatId, next);
    try {
      await next;
      logEvent('reply_sent', { reply_type: type, duration_ms: elapsedMs(startedAt) });
    } catch (error) {
      logEvent('reply_failed', { reply_type: type, duration_ms: elapsedMs(startedAt) }, 'warn');
      throw error;
    } finally {
      if (sends.get(message.chatId) === next) sends.delete(message.chatId);
      // Bound the idle chat timestamp cache.
      if (lastSent.size > 1000) for (const [key, at] of lastSent) if (Date.now() - at > 60_000) lastSent.delete(key);
    }
  }
  return { ws, messenger: {
    text: (message, text) => reply(message, 'text', { text }),
    card: (message, card) => reply(message, 'interactive', card),
    file: async (message, name, data) => {
      if (data.length > 29 * 1024 * 1024) throw new UserError('导出文件超过飞书上传限制，请缩小结果范围。');
      const uploaded = await client.im.file.create({ data: { file_type: 'stream', file_name: name, file: data } });
      if (!uploaded?.file_key) throw new UserError('结果附件上传失败，请检查 im:resource 权限。', 'FEISHU_UPLOAD');
      await reply(message, 'file', { file_key: uploaded.file_key });
    },
    download: async (message, destination) => {
      if (!message.file) throw new UserError('没有找到消息中的文件。');
      const startedAt = performance.now();
      logEvent('file_download_started', { file_name: message.file.name });
      try {
        const resource = await client.im.messageResource.get({ path: { message_id: message.id, file_key: message.file.key }, params: { type: 'file' } });
        const stream = resource.getReadableStream();
        if (Number(resource.headers?.['content-length']) > config.maxFileBytes) {
          stream.destroy();
          throw new UserError(`文件超过 ${Math.floor(config.maxFileBytes / 1024 / 1024)} MB 限制。`);
        }
        await writeBoundedFile(stream, destination, config.maxFileBytes);
        const { size } = await stat(destination);
        // Some API failures arrive as a JSON response stream; do not feed that envelope into AVA.
        if (size < 16_384 && !resource.headers?.['content-disposition'] && /application\/json/i.test(resource.headers?.['content-type'] || '')) {
          let body: { code?: unknown; msg?: unknown } | undefined;
          try { body = JSON.parse(await readFile(destination, 'utf8')); } catch { /* valid downloaded data need not be JSON */ }
          if (body && typeof body.code === 'number' && body.code >= 10_000 && typeof body.msg === 'string') throw downloadError(body.code, undefined, undefined, body);
        }
        logEvent('file_downloaded', { file_name: message.file.name, bytes: size, duration_ms: elapsedMs(startedAt) });
      } catch (error) {
        throw await fileDownloadFailure(error);
      }
    },
  } };
}
