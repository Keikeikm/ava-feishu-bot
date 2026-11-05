import { rm } from 'node:fs/promises';
import type { Config } from './config.js';
import type { DatasetInfo, DatasetSource } from './types.js';
import { EngineClient } from './engine.js';
import { UserError } from './errors.js';
import { logEvent, requestLogContext } from './logging.js';

interface Session {
  engine: EngineClient;
  info: DatasetInfo;
  directory: string;
  touched: number;
  busy: number;
}

export class Sessions {
  private entries = new Map<string, Session>();
  private loading = new Set<string>();
  constructor(private config: Config) {}

  async replace(key: string, source: DatasetSource, directory: string): Promise<DatasetInfo> {
    let engine: EngineClient | undefined;
    let reserved = false;
    try {
      await this.sweep();
      if (this.loading.has(key)) throw new UserError('当前表格正在加载，请稍后再试。');
      if (!this.entries.has(key) && this.entries.size + this.loading.size >= this.config.maxSessions) {
        throw new UserError('当前数据会话已满，请稍后再试，或先用 /清空 释放不用的数据。');
      }
      this.loading.add(key);
      reserved = true;
      engine = new EngineClient(source, this.config);
      const info = await engine.request<DatasetInfo>('load');
      const previous = this.entries.get(key);
      this.entries.set(key, { engine, info, directory, touched: Date.now(), busy: 0 });
      if (requestLogContext.getStore()) {
        logEvent('dataset_activated', { file_name: info.name, previous_file_name: previous?.info.name, tables: info.schema.models.length });
      }
      if (previous) await this.destroy(previous).catch(() => console.error('旧数据清理失败。'));
      return info;
    } catch (error) {
      if (engine) await engine.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally { if (reserved) this.loading.delete(key); }
  }

  async info(key: string): Promise<DatasetInfo> { return (await this.get(key)).info; }

  async run<T>(key: string, command: string, payload?: unknown): Promise<T> {
    const session = await this.get(key);
    session.busy++;
    try {
      if (command === 'analyze') {
        const options = payload as { query: string; inlineCharts: boolean };
        return await session.engine.analyze(options.query, { inlineCharts: options.inlineCharts }) as T;
      }
      return await session.engine.request<T>(command, payload);
    }
    finally {
      session.busy--;
      session.touched = Date.now();
      if (session.engine.closed && this.entries.get(key) === session) {
        this.entries.delete(key);
        await this.destroy(session);
      }
    }
  }

  private async get(key: string): Promise<Session> {
    const session = this.entries.get(key);
    if (session && !session.engine.closed && (session.busy || Date.now() - session.touched < this.config.sessionTtlMs)) {
      session.touched = Date.now();
      return session;
    }
    await this.clear(key);
    throw new UserError('请先发送表格文件，或用 /导入 加上飞书多维表格链接。你也可以把表格附件和分析要求放在同一条消息中发送。会话过期或服务重启后需要重新上传。', 'NO_DATASET');
  }

  async clear(key: string): Promise<void> {
    const session = this.entries.get(key);
    this.entries.delete(key);
    if (session) await this.destroy(session);
  }

  private async destroy(session: Session): Promise<void> {
    await session.engine.close();
    await rm(session.directory, { recursive: true, force: true });
  }

  async sweep(): Promise<void> {
    for (const [key, session] of this.entries) {
      if (!session.busy && (session.engine.closed || Date.now() - session.touched >= this.config.sessionTtlMs)) await this.clear(key);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(key => this.clear(key)));
  }
}
