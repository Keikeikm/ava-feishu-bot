import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SuggestResult } from '@antv/ava';
import type { Config } from './config.js';
import type { AnalysisOutput, IncomingMessage, MessageEvent } from './types.js';
import type { Messenger } from './feishu.js';
import { Sessions } from './sessions.js';
import { JobQueue } from './queue.js';
import { Deduplicator, normalizeMessage } from './messages.js';
import { bitableRequest, fileExtension } from './sources.js';
import { UserError, publicFailure } from './errors.js';
import { datasetCard, fieldsCard, helpCard, previewCard, profileCard, resultCard, resultCsv, trainingCard } from './cards.js';
import { elapsedMs, inputLogFields, logEvent, requestLogContext } from './logging.js';
import { isTrainingRequest, resolveTrainingRequest, trainClassifier, type TrainingInput } from './training.js';

export class Bot {
  private seen = new Deduplicator();
  private queue = new JobQueue();
  constructor(private config: Config, private runtimeDir: string, private messenger: Messenger, private sessions: Pick<Sessions, 'replace' | 'info' | 'run' | 'clear' | 'close'>) {}

  // Intentionally synchronous: the Feishu event handler can ACK within 3 seconds.
  accept(event: MessageEvent): void {
    const message = normalizeMessage(event, this.config);
    if (!message || !this.seen.accept(message.id)) return;
    const context = {
      request_id: randomBytes(6).toString('hex'),
      session_id: createHash('sha256').update(message.sessionKey).digest('hex').slice(0, 12),
    };
    requestLogContext.run(context, () => {
      const queuedAt = performance.now();
      const metadata = { chat_type: event.message.chat_type, message_type: event.message.message_type, file_name: message.file?.name };
      logEvent('message_received', {
        ...metadata,
        attachment_count: message.attachmentCount ?? Number(!!message.file),
        ...inputLogFields(message.text, this.config.logUserInput, [this.config.appSecret, this.config.llm.apiKey]),
      });
      // A queued job can start while a different request's async context is active.
      const accepted = this.queue.enqueue(message.sessionKey, () => requestLogContext.run(context, () => this.handle(message, queuedAt)));
      if (accepted) logEvent('message_queued', metadata);
      else {
        logEvent('queue_full', metadata, 'warn');
        void this.messenger.text(message, '任务队列已满，请等待前面的任务完成后重试。').catch(() => {});
      }
    });
  }

  private async handle(message: IncomingMessage, queuedAt: number): Promise<void> {
    const startedAt = performance.now();
    logEvent('job_started', { wait_ms: elapsedMs(queuedAt) });
    let failed = false;
    try {
      const bitable = bitableRequest(message.text || '');
      if (bitable && message.file) throw new UserError('请在一条消息里选择一个数据来源：表格附件或多维表格链接。');
      if (message.file) {
        if ((message.attachmentCount || 1) > 1) throw new UserError('请一次发送一个表格文件。需要分析多张表时，可放在同一个 XLSX 的不同工作表中。');
        if (message.file.name === '未命名文件') throw new UserError('没有读取到附件文件名，请将表格作为单独的文件消息重新发送。');
        const extension = fileExtension(message.file.name);
        await this.messenger.text(message, message.text ? '正在读取表格并分析，请稍候。' : '正在读取表格，请稍候。');
        const directory = await mkdtemp(join(this.runtimeDir, 'session-'));
        let imported = false;
        try {
          const path = join(directory, `input${extension}`);
          await this.messenger.download(message, path);
          const info = await this.sessions.replace(message.sessionKey, { kind: 'file', path, name: message.file.name }, directory);
          imported = true;
          if (!message.text) await this.messenger.card(message, datasetCard(info));
        } catch (error) {
          if (!imported) await rm(directory, { recursive: true, force: true });
          throw error;
        }
        if (!message.text) return;
      }
      if (bitable) {
        const link = new URL(bitable.url);
        logEvent('bitable_import_started', { link_kind: link.pathname.startsWith('/wiki/') ? 'wiki' : 'base', has_table_id: link.searchParams.has('table') });
        await this.messenger.text(message, bitable.question ? '正在读取多维表格并分析，请稍候。' : '正在读取多维表格，请稍候。');
        const directory = await mkdtemp(join(this.runtimeDir, 'session-'));
        const info = await this.sessions.replace(message.sessionKey, { kind: 'bitable', url: bitable.url, name: '飞书多维表格', appId: this.config.appId, appSecret: this.config.appSecret }, directory);
        if (!bitable.question) { await this.messenger.card(message, datasetCard(info)); return; }
      }
      const text = bitable?.question ?? message.text ?? '';
      if (isTrainingRequest(text)) {
        const info = await this.sessions.info(message.sessionKey);
        const training = resolveTrainingRequest(text, info);
        const dataset = { file_name: info.name, table: training.table, target: training.target };
        const prepStartedAt = performance.now();
        logEvent('training_data_requested', dataset);
        const input = await this.sessions.run<TrainingInput>(message.sessionKey, 'training-data', { training });
        logEvent('training_data_ready', { rows: input.rows.length, features: input.columns.length, excluded_features: input.excluded.length, duration_ms: elapsedMs(prepStartedAt) });
        await this.messenger.text(message, '正在训练分类模型并做交叉验证，请稍候。');
        const trainingStartedAt = performance.now();
        logEvent('training_started', { ...dataset, runtime: 'local_python', models: ['majority', 'logistic', 'forest'] });
        const report = await trainClassifier(input, Math.min(this.config.jobTimeoutMs, 120_000), this.config.mlPython);
        logEvent('training_finished', {
          model: report.selected, rows: report.rows, missing_labels: report.missingLabels, features: report.features,
          folds: report.folds, grouped: report.grouped, scores: report.scores, duration_ms: elapsedMs(trainingStartedAt),
        });
        await this.messenger.card(message, trainingCard(input, report, this.config.enableCharts));
        return;
      }
      if (/^(\/?帮助|\/?help|你好|您好|hello|hi|嗨|在吗)[!！?？。\s]*$/i.test(text)) { await this.messenger.card(message, helpCard()); return; }
      if (/^\/?清空$/.test(text)) {
        await this.sessions.clear(message.sessionKey);
        logEvent('dataset_cleared');
        await this.messenger.text(message, '已清空你的数据和追问记录，可以重新发送表格。');
        return;
      }
      if (/^\/?(状态|字段|预览|画像)$/.test(text)) {
        const info = await this.sessions.info(message.sessionKey);
        const factory = { 状态: datasetCard, 字段: fieldsCard, 预览: previewCard, 画像: profileCard }[text.replace(/^\//, '') as '状态'];
        await this.messenger.card(message, factory(info));
        return;
      }
      if (/^\/?建议$/.test(text)) {
        await this.sessions.info(message.sessionKey);
        await this.messenger.text(message, '正在根据数据生成分析建议。');
        const suggestions = await this.sessions.run<SuggestResult[]>(message.sessionKey, 'suggest');
        await this.messenger.text(message, suggestions.map((s, i) => `${i + 1}. ${s.query}\n${s.reason}`).join('\n\n') || '暂无建议，可以直接输入你想分析的问题。');
        return;
      }
      if (/^\/?导出(?:\s*(CSV|JSON|图表))?$/i.test(text)) {
        const format = text.match(/(CSV|JSON|图表)$/i)?.[1]?.toLowerCase() || 'csv';
        const output = await this.sessions.run<AnalysisOutput>(message.sessionKey, 'export');
        if (format === 'json') {
          const { query, text, data, truncated } = output.result;
          await this.messenger.file(message, 'analysis-report.json', Buffer.from(JSON.stringify({ query, text, data, truncated }, null, 2)));
        } else if (format === '图表') {
          if (!this.config.enableCharts) throw new UserError('当前未开启图表导出，请联系管理员。');
          const chart = await this.sessions.run<import('@antv/ava').VisualizeResponse | null>(message.sessionKey, 'visualize');
          if (!chart) { await this.messenger.text(message, '这次结果不适合绘制图表，可以继续提问或导出 CSV。'); return; }
          await this.messenger.file(message, 'analysis-chart.html', Buffer.from(chart.html));
        } else {
          await this.messenger.file(message, 'analysis-result.csv', Buffer.from(resultCsv(output.result.data, output.result.schema.map(c => c.name))));
        }
        return;
      }
      // Only strip the explicit slash command; natural phrases such as “分析一下” are the question itself.
      let query = text.replace(/^\/分析(?:\s+|$)/, '').trim();
      const inlineCharts = this.config.enableCharts && !/^不画图/.test(query);
      query = query.replace(/^不画图[，,：:\s]*/, '');
      if (text.startsWith('/') && !/^\/分析(?:\s|$)/.test(text)) throw new UserError('未识别此命令，发送 /帮助 查看用法。');
      if (!query) throw new UserError('请输入分析问题，或发送“分析一下”获取整体判断。');
      if (query.length > 6000) throw new UserError('问题最多支持 6000 个字符，请精简后重试。');
      await this.sessions.info(message.sessionKey);
      if (!message.file && !bitable) await this.messenger.text(message, '正在分析，请稍候。');
      const output = await this.sessions.run<AnalysisOutput>(message.sessionKey, 'analyze', { query, inlineCharts });
      await this.messenger.card(message, resultCard(output));
    } catch (error) {
      failed = true;
      const failure = publicFailure(error);
      logEvent('job_failed', {
        code: failure.code,
        stage: failure.stage,
        diagnostic: failure.diagnostic,
        duration_ms: elapsedMs(startedAt),
      }, failure.code === 'NO_DATASET' ? 'warn' : 'error');
      const text = failure.code === 'NO_DATASET' ? failure.message : `${failure.message}\n错误编号：${failure.code}`;
      await this.messenger.text(message, text).catch(() => logEvent('error_notice_failed', {}, 'warn'));
    } finally {
      if (!failed) logEvent('job_finished', { duration_ms: elapsedMs(startedAt) });
    }
  }

  async close(): Promise<void> { await this.queue.drain(); await this.sessions.close(); }
}
