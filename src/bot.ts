import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SuggestResult } from '@antv/ava';
import type { Config } from './config.js';
import type { AnalysisOutput, IncomingMessage, MessageEvent } from './types.js';
import type { Messenger } from './feishu.js';
import { Sessions } from './sessions.js';
import { JobQueue } from './queue.js';
import { Deduplicator, normalizeMessage } from './messages.js';
import { bitableUrl, fileExtension } from './sources.js';
import { UserError, publicFailure } from './errors.js';
import { datasetCard, fieldsCard, helpCard, previewCard, profileCard, resultCard, resultCsv } from './cards.js';

export class Bot {
  private seen = new Deduplicator();
  private queue = new JobQueue();
  constructor(private config: Config, private runtimeDir: string, private messenger: Messenger, private sessions: Pick<Sessions, 'replace' | 'info' | 'run' | 'clear' | 'close'>) {}

  // Intentionally synchronous: the Feishu event handler can ACK within 3 seconds.
  accept(event: MessageEvent): void {
    const message = normalizeMessage(event, this.config);
    if (!message || !this.seen.accept(message.id)) return;
    if (!this.queue.enqueue(message.sessionKey, () => this.handle(message))) {
      void this.messenger.text(message, '任务队列已满，请等待前面的任务完成后重试。').catch(() => {});
    }
  }

  private async handle(message: IncomingMessage): Promise<void> {
    try {
      if (message.file) {
        if ((message.attachmentCount || 1) > 1) throw new UserError('请一次发送一个表格文件。需要分析多张表时，可放在同一个 XLSX 的不同工作表中。');
        if (message.file.name === '未命名文件') throw new UserError('没有读取到附件文件名，请将表格作为单独的文件消息重新发送。');
        const extension = fileExtension(message.file.name);
        await this.messenger.text(message, '已收到文件，正在加载并检查数据。完成后可直接发送分析问题。');
        const directory = await mkdtemp(join(this.runtimeDir, 'session-'));
        let imported = false;
        try {
          const path = join(directory, `input${extension}`);
          await this.messenger.download(message, path);
          const info = await this.sessions.replace(message.sessionKey, { kind: 'file', path, name: message.file.name }, directory);
          imported = true;
          await this.messenger.card(message, datasetCard(info));
        } catch (error) {
          if (!imported) await rm(directory, { recursive: true, force: true });
          throw error;
        }
        if (!message.text) return;
      }
      const text = message.text || '';
      if (/^(\/?帮助|\/?help|你好|您好|hello|hi|嗨|在吗)[!！?？。\s]*$/i.test(text)) { await this.messenger.card(message, helpCard()); return; }
      if (/^\/?清空$/.test(text)) {
        await this.sessions.clear(message.sessionKey);
        await this.messenger.text(message, '已清空你的数据和追问记录，可以重新发送表格。');
        return;
      }
      if (/^\/?导入\s+/.test(text) || /^https:\/\//.test(text)) {
        const url = bitableUrl(text.replace(/^\/?导入\s+/, ''));
        await this.messenger.text(message, '正在读取多维表格，请确保机器人应用具有该表的访问权限。');
        const directory = await mkdtemp(join(this.runtimeDir, 'session-'));
        const info = await this.sessions.replace(message.sessionKey, { kind: 'bitable', url, name: '飞书多维表格', appId: this.config.appId, appSecret: this.config.appSecret }, directory);
        await this.messenger.card(message, datasetCard(info));
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
      let query = text.replace(/^\/?分析\s*/, '');
      const noChart = /^不画图\s*/.test(query);
      if (noChart) query = query.replace(/^不画图\s*/, '');
      if (text.startsWith('/') && !text.startsWith('/分析')) throw new UserError('未识别此命令，发送 /帮助 查看用法。');
      if (!query.trim()) throw new UserError('请输入分析问题，例如「按地区汇总销售额」。');
      if (query.length > 6000) throw new UserError('问题最多支持 6000 个字符，请精简后重试。');
      const info = await this.sessions.info(message.sessionKey);
      await this.messenger.text(message, '正在调用 AVA 分析数据，请稍候。后续消息会按发送顺序处理。');
      const output = await this.sessions.run<AnalysisOutput>(message.sessionKey, 'analyze', { query, charts: this.config.enableCharts && !noChart });
      await this.messenger.card(message, resultCard(output, info.name));
      const report = { source: info.name, generatedAt: new Date().toISOString(), ...output.result, chart: output.visualization ? { chartType: output.visualization.chartType, config: output.visualization.config } : null, chartWarning: output.chartWarning };
      try {
        await this.messenger.file(message, 'analysis-report.json', Buffer.from(JSON.stringify(report, null, 2)));
        if (output.result.data.length) await this.messenger.file(message, 'analysis-result.csv', Buffer.from(resultCsv(output.result.data, output.result.schema.map(c => c.name))));
        if (output.visualization) await this.messenger.file(message, 'analysis-chart.html', Buffer.from(output.visualization.html));
      } catch {
        throw new UserError('分析已完成，但结果附件发送失败。请检查飞书 im:resource 权限和网络后重试。', 'EXPORT_FAILED');
      }
    } catch (error) {
      const failure = publicFailure(error);
      if (failure.code !== 'NO_DATASET') console.error(JSON.stringify({ event: 'job_failed', code: failure.code, stage: failure.stage, diagnostic: failure.diagnostic }));
      const text = failure.code === 'NO_DATASET' ? failure.message : `${failure.message}\n错误编号：${failure.code}`;
      await this.messenger.text(message, text).catch(() => console.error('[feishu] 错误提示发送失败。'));
    }
  }

  async close(): Promise<void> { await this.queue.drain(); await this.sessions.close(); }
}
