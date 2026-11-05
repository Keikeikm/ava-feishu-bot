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
import { isTrainingModelQuestion, isTrainingRequest, resolveTrainingRequest, selectedTrainingModel, trainingMetric, trainingSummary, trainModel, type TrainingInput } from './training.js';
import { archiveGuide, compareSubmission, comparisonFile, isArchivePrediction, isSubmissionComparison, mentionedArchiveFiles, openArchive, predictArchive, refersToSubmission } from './archive.js';

// Only match standalone schema questions, so questions that also request analysis keep using AVA.
const fieldsQuestion = /^(?:(?:请(?:帮我)?|帮我)\s*)?(?:介绍(?:一下)?|列出|查看|看一下)\s*(?:这[份张]表(?:格)?(?:里|中)?(?:的)?|当前表(?:格)?(?:的)?|数据(?:表)?(?:的)?)?\s*(?:字段|列名)(?:\s*(?:分别)?(?:是什么|有哪些|有什么))?[。！？!?\s]*$/;
const fieldsListQuestion = /^(?:(?:数据|表格)的?)?(?:字段(?:分别)?(?:是什么|有哪些)|有哪些字段)[。！？!?\s]*$/;

export class Bot {
  private seen = new Deduplicator();
  private queue = new JobQueue();
  constructor(private config: Config, private runtimeDir: string, private messenger: Messenger,
    private sessions: Pick<Sessions, 'replace' | 'replaceArchive' | 'archive' | 'useArchive' | 'selectArchiveFile' | 'recordTraining' | 'latestTraining' | 'recordSubmission' | 'runSubmission' | 'info' | 'run' | 'clear' | 'close'>) {}

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
      if (!bitable && !message.file && isTrainingModelQuestion(message.text ?? '')) {
        const run = this.sessions.latestTraining(message.sessionKey);
        await this.messenger.text(message, run ? trainingSummary(run) : '当前数据会话还没有训练记录。完成一次训练后，可以发送 /模型 查看。');
        return;
      }
      const comparison = isSubmissionComparison(message.text ?? '');
      const comparisonCommand = /^\/(?:对比|评估)(?:\s|$)/.test(message.text ?? '');
      if (!bitable && comparison && (comparisonCommand || this.sessions.archive(message.sessionKey))
          && (!message.file || !/\.zip$/i.test(message.file.name))) {
        await this.sessions.useArchive(message.sessionKey, async ({ source, submission }) => {
          if (!submission) throw new UserError('当前 ZIP 会话还没有预测结果。请先发送 /预测，再对比参考文件。', 'ML_NO_SUBMISSION');
          const started = performance.now();
          let result: string;
          if (message.file) {
            if ((message.attachmentCount ?? 1) !== 1 || !/\.csv$/i.test(message.file.name)) {
              throw new UserError('请一次发送一个用于对比的 CSV 附件。', 'ML_REFERENCE');
            }
            const directory = await mkdtemp(join(this.runtimeDir, 'comparison-'));
            try {
              const path = join(directory, 'reference.csv');
              await this.messenger.download(message, path);
              result = await compareSubmission(submission, { name: message.file.name, path }, this.config);
            } finally { await rm(directory, { recursive: true, force: true }); }
          } else {
            const reference = comparisonFile(source, message.text!);
            result = await compareSubmission(submission, reference, this.config);
          }
          logEvent('submission_compared', { file_name: source.name, target: submission.target, duration_ms: elapsedMs(started) });
          await this.messenger.text(message, result);
        });
        return;
      }
      if (message.file) {
        if ((message.attachmentCount || 1) > 1) throw new UserError('请一次发送一个表格文件。需要分析多张表时，可放在同一个 XLSX 的不同工作表中。');
        if (message.file.name === '未命名文件') throw new UserError('没有读取到附件文件名，请将表格作为单独的文件消息重新发送。');
        const extension = fileExtension(message.file.name, true);
        await this.messenger.text(message, extension === '.zip' ? '正在解压 ZIP 并检查数据文件，请稍候。'
          : message.text ? '正在读取表格并分析，请稍候。' : '正在读取表格，请稍候。');
        const directory = await mkdtemp(join(this.runtimeDir, 'session-'));
        let imported = false;
        try {
          const path = join(directory, `input${extension}`);
          await this.messenger.download(message, path);
          if (extension === '.zip') {
            const archive = await openArchive(message.file.name, path, this.config);
            await rm(path);
            await this.sessions.replaceArchive(message.sessionKey, archive, directory);
            imported = true;
            logEvent('archive_opened', { file_name: archive.name, files: archive.files.length });
            if (!message.text) await this.messenger.text(message, archiveGuide(archive));
          } else {
            const info = await this.sessions.replace(message.sessionKey, { kind: 'file', path, name: message.file.name }, directory);
            imported = true;
            if (!message.text) await this.messenger.card(message, datasetCard(info));
          }
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
      let text = bitable?.question ?? message.text ?? '';
      const archive = this.sessions.archive(message.sessionKey);
      let analyzeSubmission = !bitable && !message.file && refersToSubmission(text)
        && (!!archive || /刚才|刚刚|上一轮|生成的|submission\.csv/i.test(text))
        && (!text.startsWith('/') || /^\/分析(?:\s|$)/.test(text));
      if (archive && comparison) throw new UserError('请先为当前 ZIP 发送 /预测，再对比参考文件。', 'ML_NO_SUBMISSION');
      if (archive && isArchivePrediction(text)) {
        await this.sessions.useArchive(message.sessionKey, async state => {
          const { source } = state;
          await this.messenger.text(message, '正在用训练集交叉验证模型，并为测试集生成提交文件，请稍候。');
          const started = performance.now();
          logEvent('submission_started', { file_name: source.name });
          const result = await predictArchive(source, text, this.config);
          logEvent('submission_finished', { file_name: source.name, target: result.target, task: result.report.task,
            model: result.report.selected, train_rows: result.report.rows, test_rows: result.rows, duration_ms: elapsedMs(started) });
          const best = result.report.scores.find(score => score.model === result.report.selected)!;
          const metric = trainingMetric(best);
          await this.messenger.file(message, 'submission.csv', Buffer.from(result.csv, 'utf8'));
          await this.sessions.recordSubmission(message.sessionKey, { csv: result.csv, target: result.target, task: result.report.task, template: result.template });
          this.sessions.recordTraining(message.sessionKey, {
            source: `${source.name} / train.csv`, target: result.target, report: result.report, predictionRows: result.rows,
          });
          await this.messenger.text(message, `本轮在本机训练，选定 ${selectedTrainingModel(result.report)}，用全部 ${result.report.rows} 条有标签记录重新拟合，为测试集生成 ${result.rows} 条「${result.target}」预测并写入 submission.csv。\n训练集 ${result.report.folds} 折交叉验证结果：${metric}。发送 /模型 可查看各模型的分数。`);
        });
        return;
      }
      if (archive && /^\/?状态$/.test(text)) {
        await this.sessions.useArchive(message.sessionKey, async ({ source }) => {
          await this.messenger.text(message, archiveGuide(source, archive.selected));
        });
        return;
      }
      const selection = /^\/选文件\s+(\d+)$/.exec(text);
      if (selection) {
        const info = await this.sessions.selectArchiveFile(message.sessionKey, Number(selection[1]) - 1);
        await this.messenger.card(message, datasetCard(info));
        return;
      }
      if (/^\/(?:预测|predict)(?:\s|$)/i.test(text)) throw new UserError('请先上传包含训练集、测试集和提交模板的 ZIP。', 'ZIP_REQUIRED');
      if (archive && !/^(?:\/?(?:清空|帮助|help)|你好|您好|hello|hi|嗨|在吗)[!！?？。\s]*$/i.test(text)) {
        const question = text.replace(/^\/?分析\s+/, '');
        const files = archive.source.files;
        const matches = !text.startsWith('/') || /^\/分析(?:\s|$)/.test(text)
          ? mentionedArchiveFiles(files, question).filter(index => !(analyzeSubmission && /^submission\.csv$/i.test(files[index]!.entry)))
          : [];
        if (matches.length > 1) {
          const choices = matches.map(index => `${index + 1}. ${files[index]!.entry}`).join('\n');
          throw new UserError(`这句话匹配到多个文件。请用 /选文件 加编号选择其中一个，也可以在问题中写完整路径。\n${choices}`, 'ZIP_SELECT', 'source');
        }
        if (matches[0] !== undefined) {
          const index = matches[0];
          const file = files[index]!;
          const info = await this.sessions.selectArchiveFile(message.sessionKey, index);
          const prefix = [file.entry, file.name].find(name =>
            question.toLowerCase().startsWith(name.toLowerCase()) && /^(?:\s|$)/u.test(question.slice(name.length)));
          const query = prefix ? question.slice(prefix.length).trim() : question;
          if (!query) { await this.messenger.card(message, datasetCard(info)); return; }
          analyzeSubmission = false;
          text = `/分析 ${query}`;
        } else if (archive.predictionFocused && (!text.startsWith('/') || /^\/分析(?:\s|$)/.test(text))
            && !isTrainingRequest(text) && !/^(?:状态|字段|预览|画像|建议|导出(?:\s*(?:CSV|JSON|图表))?)$/i.test(text)
            && !fieldsQuestion.test(text) && !fieldsListQuestion.test(text)) {
          analyzeSubmission = true;
        } else if (!analyzeSubmission && archive.selected === undefined && !/^\/?导出(?:\s*(?:CSV|JSON|图表))?$/i.test(text)) {
          if (archive.source.files.length === 1) await this.sessions.selectArchiveFile(message.sessionKey, 0);
          else { await this.messenger.text(message, archiveGuide(archive.source)); return; }
        }
      }
      if (!analyzeSubmission && isTrainingRequest(text)) {
        const info = await this.sessions.info(message.sessionKey);
        const training = resolveTrainingRequest(text, info);
        const dataset = { file_name: info.name, table: training.table, target: training.target, task: training.task };
        const prepStartedAt = performance.now();
        logEvent('training_data_requested', dataset);
        const input = await this.sessions.run<TrainingInput>(message.sessionKey, 'training-data', { training });
        logEvent('training_data_ready', { rows: input.rows.length, features: input.columns.length, excluded_features: input.excluded.length, duration_ms: elapsedMs(prepStartedAt) });
        const regression = training.task === 'regression';
        await this.messenger.text(message, `正在训练${regression ? '回归' : '分类'}模型并做交叉验证，请稍候。`);
        const trainingStartedAt = performance.now();
        logEvent('training_started', { ...dataset, runtime: 'local_python', models: regression ? ['median', 'ridge', 'forest'] : ['majority', 'logistic', 'forest'] });
        const report = await trainModel(input, Math.min(this.config.jobTimeoutMs, 120_000), this.config.mlPython);
        logEvent('training_finished', {
          task: report.task, model: report.selected, rows: report.rows, missing_labels: report.missingLabels, features: report.features,
          folds: report.folds, grouped: report.grouped, scores: report.scores, duration_ms: elapsedMs(trainingStartedAt),
        });
        this.sessions.recordTraining(message.sessionKey, { source: `${input.dataset} / ${input.table}`, target: input.target, report });
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
      const lookup = fieldsQuestion.test(text) || fieldsListQuestion.test(text) ? '字段' : text.replace(/^\//, '');
      if (/^(状态|字段|预览|画像)$/.test(lookup)) {
        const info = await this.sessions.info(message.sessionKey);
        const factory = { 状态: datasetCard, 字段: fieldsCard, 预览: previewCard, 画像: profileCard }[lookup as '状态' | '字段' | '预览' | '画像'];
        if (lookup === '字段') logEvent('fields_served', { file_name: info.name, tables: info.schema.models.length, source: 'session_metadata' });
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
        const run = <T>(command: 'export' | 'visualize') => archive?.predictionFocused
          ? this.sessions.runSubmission<T>(message.sessionKey, command) : this.sessions.run<T>(message.sessionKey, command);
        const output = await run<AnalysisOutput>('export');
        if (format === 'json') {
          const { query, text, data, truncated } = output.result;
          await this.messenger.file(message, 'analysis-report.json', Buffer.from(JSON.stringify({ query, text, data, truncated }, null, 2)));
        } else if (format === '图表') {
          if (!this.config.enableCharts) throw new UserError('当前未开启图表导出，请联系管理员。');
          const chart = await run<import('@antv/ava').VisualizeResponse | null>('visualize');
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
      if (analyzeSubmission) {
        if (!archive?.hasSubmission) throw new UserError('当前会话还没有可分析的预测结果。请上传 ZIP 并先发送 /预测。', 'ML_NO_SUBMISSION');
        const output = await this.sessions.runSubmission<AnalysisOutput>(message.sessionKey, 'analyze', { query, inlineCharts });
        await this.messenger.card(message, resultCard(output));
        return;
      }
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
