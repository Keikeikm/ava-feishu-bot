import { Worker } from 'node:worker_threads';
import type { Config } from './config.js';
import type { AnalysisOutput, DatasetSource } from './types.js';
import type { VisualizeResponse } from '@antv/ava';
import { UserError, type Failure } from './errors.js';
import { requestLogContext } from './logging.js';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export class EngineClient {
  readonly worker: Worker;
  private nextId = 0;
  private pending = new Map<number, Pending>();
  closed = false;
  private closing?: Promise<void>;

  constructor(source: DatasetSource, private config: Pick<Config, 'llm' | 'maxResultRows' | 'jobTimeoutMs'>, directory?: string) {
    this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), {
      workerData: { source, directory, llm: config.llm, maxResultRows: config.maxResultRows },
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    this.worker.on('message', (reply: { id: number; ok: boolean; value: unknown; error?: Failure }) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new UserError(reply.error?.message || '数据分析失败。', reply.error?.code || 'ENGINE_ERROR', reply.error?.stage, reply.error?.diagnostic));
    });
    this.worker.on('error', () => this.fail(new UserError('数据引擎异常，当前数据已释放，请重新上传文件。', 'WORKER_ERROR')));
    this.worker.on('exit', () => this.fail(new UserError('数据引擎已关闭，请重新上传文件。', 'WORKER_CLOSED')));
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }

  request<T>(command: string, payload: unknown = {}, timeoutMs = this.config.jobTimeoutMs): Promise<T> {
    if (this.closed) return Promise.reject(new UserError('当前数据已释放，请重新上传文件。', 'WORKER_CLOSED'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new UserError('任务超过处理时限，当前会话已释放。请重新上传文件，并缩小问题范围。', 'TIMEOUT'));
        void this.worker.terminate();
      }, timeoutMs);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      this.worker.postMessage({ id, command, payload, trace: requestLogContext.getStore() });
    });
  }

  async analyze(query: string, options: boolean | { inlineCharts: boolean }): Promise<AnalysisOutput> {
    const output = await this.request<AnalysisOutput>('analyze', { query, inlineCharts: typeof options === 'object' && options.inlineCharts });
    if (options === true && output.result.data.length) {
      try { output.visualization = await this.request<VisualizeResponse | null>('visualize', {}, Math.min(this.config.jobTimeoutMs, 60_000)); }
      catch {
        output.chartWarning = this.closed
          ? '图表生成超时或引擎关闭，分析结论和数据已保留。请重新上传表格后继续提问。'
          : '本次图表生成失败，分析结论和结果数据已保留。';
      }
    }
    return output;
  }

  close(): Promise<void> {
    this.closing ??= (async () => {
      if (!this.closed) {
        try { await this.request('dispose', {}, 3000); } catch { /* forced termination below */ }
      }
      this.fail(new UserError('当前会话已清空，请重新上传文件。', 'WORKER_CLOSED'));
      await this.worker.terminate();
    })();
    return this.closing;
  }
}
