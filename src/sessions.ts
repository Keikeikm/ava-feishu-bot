import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from './config.js';
import type { DatasetInfo, DatasetSource } from './types.js';
import { EngineClient } from './engine.js';
import { UserError } from './errors.js';
import { logEvent, requestLogContext } from './logging.js';
import type { Archive, SavedSubmission } from './archive.js';
import type { TrainingRun } from './training.js';

interface ArchiveSession {
  source: Archive;
  submission?: SavedSubmission;
  submissionEngine?: EngineClient;
  predictionFocused?: boolean;
}

interface Session {
  engine?: EngineClient;
  info?: DatasetInfo;
  archive?: ArchiveSession;
  activeFile?: number;
  training?: TrainingRun;
  directory: string;
  touched: number;
  busy: number;
}

export class Sessions {
  private entries = new Map<string, Session>();
  private loading = new Set<string>();
  constructor(private config: Config) {}

  async replace(key: string, source: DatasetSource, directory: string): Promise<DatasetInfo> {
    return (await this.install(key, source, directory))!;
  }

  async replaceArchive(key: string, archive: Archive, directory: string): Promise<void> {
    await this.install(key, archive, directory);
  }

  private async install(key: string, source: DatasetSource | Archive, directory: string): Promise<DatasetInfo | undefined> {
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
      let info: DatasetInfo | undefined;
      const archive = source.kind === 'archive' ? { source } : undefined;
      if (source.kind !== 'archive') {
        engine = new EngineClient(source, this.config, directory);
        info = await engine.request<DatasetInfo>('load');
      }
      const previous = this.entries.get(key);
      this.entries.set(key, { engine, info, archive, directory, touched: Date.now(), busy: 0 });
      if (requestLogContext.getStore()) {
        logEvent('dataset_activated', { file_name: source.name, previous_file_name: previous?.archive?.source.name ?? previous?.info?.name, tables: info?.schema.models.length, archive_files: archive?.source.files.length });
      }
      if (previous) await this.destroy(previous).catch(() => console.error('旧数据清理失败。'));
      return info;
    } catch (error) {
      if (engine) await engine.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally { if (reserved) this.loading.delete(key); }
  }

  async info(key: string): Promise<DatasetInfo> {
    const session = await this.get(key);
    if (!session.info || session.engine?.closed) throw new UserError('请先用 /选文件 1 选择压缩包中的数据文件。', 'ZIP_SELECT', 'source');
    return session.info;
  }

  archive(key: string): { source: Archive; selected?: number; predictionFocused: boolean; hasSubmission: boolean } | undefined {
    const session = this.entries.get(key);
    if (session?.archive && (session.busy || Date.now() - session.touched < this.config.sessionTtlMs)) {
      return {
        source: session.archive.source, selected: session.engine?.closed ? undefined : session.activeFile,
        predictionFocused: !!session.archive.predictionFocused, hasSubmission: !!session.archive.submission,
      };
    }
  }

  recordTraining(key: string, run: TrainingRun): void {
    const session = this.entries.get(key);
    if (session) {
      session.training = run;
      session.touched = Date.now();
    }
  }

  latestTraining(key: string): TrainingRun | undefined {
    const session = this.entries.get(key);
    if (session && (session.busy || Date.now() - session.touched < this.config.sessionTtlMs)) {
      session.touched = Date.now();
      return session.training;
    }
  }

  async useArchive<T>(key: string, work: (archive: ArchiveSession) => Promise<T>): Promise<T> {
    const session = await this.get(key);
    if (!session.archive) throw new UserError('请先上传包含训练集、测试集和提交模板的 ZIP。', 'ZIP_REQUIRED');
    session.busy++;
    try { return await work(session.archive); }
    finally { session.busy--; session.touched = Date.now(); }
  }

  async selectArchiveFile(key: string, index: number): Promise<DatasetInfo> {
    const session = await this.get(key);
    const file = session.archive?.source.files[index];
    if (!file) throw new UserError('找不到该文件编号，发送 /状态 查看压缩包文件列表。', 'ZIP_SELECT');
    if (session.activeFile === index && session.engine && !session.engine.closed && session.info) {
      session.archive!.predictionFocused = false;
      return session.info;
    }
    const engine = new EngineClient({ kind: 'file', path: file.path, name: file.name }, this.config, session.directory);
    session.busy++;
    try {
      const info = await engine.request<DatasetInfo>('load');
      const previous = session.engine;
      session.engine = engine;
      session.info = info;
      session.activeFile = index;
      session.archive!.predictionFocused = false;
      await previous?.close();
      return info;
    } catch (error) {
      if (session.engine !== engine) await engine.close();
      throw error;
    } finally { session.busy--; session.touched = Date.now(); }
  }

  async recordSubmission(key: string, submission: SavedSubmission): Promise<void> {
    await this.useArchive(key, async archive => {
      const previous = archive.submissionEngine;
      archive.submission = submission;
      archive.submissionEngine = undefined;
      archive.predictionFocused = true;
      await previous?.close();
    });
  }

  async runSubmission<T>(key: string, command: 'analyze' | 'export' | 'visualize', payload?: { query: string; inlineCharts: boolean }): Promise<T> {
    const session = await this.get(key);
    const archive = session.archive;
    if (!archive?.submission) throw new UserError('当前会话还没有可分析的预测结果。请上传 ZIP 并先发送 /预测。', 'ML_NO_SUBMISSION');
    session.busy++;
    try {
      let engine = archive.submissionEngine;
      if (!engine || engine.closed) {
        if (command !== 'analyze') throw new UserError('请先分析一次预测结果，再导出。', 'NO_ANALYSIS');
        await engine?.close();
        const path = join(session.directory, 'submission.csv');
        await writeFile(path, archive.submission.csv, { mode: 0o600 });
        const { task, target } = archive.submission;
        engine = new EngineClient({ kind: 'file', path, name: 'submission.csv', prediction: { task, target } }, this.config, session.directory);
        try { await engine.request<DatasetInfo>('load'); }
        catch (error) { await engine.close(); throw error; }
        archive.submissionEngine = engine;
      }
      if (command === 'analyze' && payload) {
        const output = await engine.analyze(payload.query, { inlineCharts: payload.inlineCharts });
        archive.predictionFocused = true;
        return output as T;
      }
      return await engine.request<T>(command);
    } finally { session.busy--; session.touched = Date.now(); }
  }

  async run<T>(key: string, command: string, payload?: unknown): Promise<T> {
    const session = await this.get(key);
    const engine = session.engine;
    if (!engine) throw new UserError('请先用 /选文件 1 选择压缩包中的数据文件。', 'ZIP_SELECT', 'source');
    session.busy++;
    try {
      if (command === 'analyze') {
        const options = payload as { query: string; inlineCharts: boolean };
        return await engine.analyze(options.query, { inlineCharts: options.inlineCharts }) as T;
      }
      return await engine.request<T>(command, payload);
    }
    finally {
      session.busy--;
      session.touched = Date.now();
      if (engine.closed && this.entries.get(key) === session) {
        if (session.archive) {
          session.engine = undefined;
          session.info = undefined;
          session.activeFile = undefined;
          await engine.close();
        } else {
          await this.clear(key);
        }
      }
    }
  }

  private async get(key: string): Promise<Session> {
    const session = this.entries.get(key);
    if (session && (session.archive || !session.engine?.closed) && (session.busy || Date.now() - session.touched < this.config.sessionTtlMs)) {
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
    await Promise.all([session.engine?.close(), session.archive?.submissionEngine?.close()]);
    await rm(session.directory, { recursive: true, force: true });
  }

  async sweep(): Promise<void> {
    for (const [key, session] of this.entries) {
      if (!session.busy && ((!session.archive && session.engine?.closed) || Date.now() - session.touched >= this.config.sessionTtlMs)) await this.clear(key);
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(key => this.clear(key)));
  }
}
