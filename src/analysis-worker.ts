import { parentPort, workerData } from 'node:worker_threads';
import { AVA, type AnalysisResponse, type ExecutionResult, type LLMConfig } from '@antv/ava';
import { avaSource } from './sources.js';
import { analysisPrompt } from './analysis-prompt.js';
import { chartConclusion, inlineCharts } from './charts.js';
import { bitableReadError, publicFailure, UserError, type FailureStage } from './errors.js';
import { elapsedMs, logEvent, requestLogContext, type RequestLogContext } from './logging.js';
import type { AnalysisOutput, DatasetInfo, DatasetSource } from './types.js';

const settings = workerData as { source: DatasetSource; llm: LLMConfig; maxResultRows: number };
const ava = new AVA({
  llm: settings.llm,
  engine: { type: 'duckdb', memoryLimit: '256MB', threads: 1, maxTempDirectorySize: '256MB', queryTimeoutMs: 30_000 },
});
const history: { query: string; sql?: string; text: string }[] = [];
let info: DatasetInfo | undefined;
let lastResult: AnalysisResponse | undefined;
let currentStage: FailureStage | undefined;
let activeAnalysis: { sql?: string; execution?: ExecutionResult; summaryFailed?: boolean } | undefined;
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

// AVA events can carry queries, records and provider errors. Select only process metadata.
const stages = {
  source: 'source', schema: 'schema', profile: 'profile',
  translate: 'generate_sql', query: 'execute_sql', summarize: 'summarize',
  suggest: 'suggest', visualize: 'visualize',
};
for (const [event, stage] of Object.entries(stages)) {
  let startedAt = 0;
  const stageName = () => event === 'query' && currentStage === 'preview' ? 'preview' : stage;
  ava.on(`${event}start`, (detail: { data?: { attempt?: number } | null }) => {
    if (!requestLogContext.getStore()) return;
    startedAt = performance.now();
    const attempt = detail.data?.attempt;
    logEvent('ava_stage_started', { stage: stageName(), file_name: settings.source.name, attempt: typeof attempt === 'number' ? attempt + 1 : undefined });
  });
  ava.on(`${event}end`, (detail: { data?: (Partial<ExecutionResult> & { error?: unknown; dsl?: string }) | null }) => {
    const data = detail.data;
    if (activeAnalysis && data) {
      if (event === 'translate' && typeof data.dsl === 'string') activeAnalysis.sql = data.dsl;
      if (event === 'query' && Array.isArray(data.data) && Array.isArray(data.schema)) activeAnalysis.execution = data as ExecutionResult;
      if (event === 'summarize' && data.error) activeAnalysis.summaryFailed = true;
    }
    if (!requestLogContext.getStore()) return;
    logEvent('ava_stage_finished', {
      stage: stageName(),
      file_name: settings.source.name,
      status: detail.data?.error ? 'failed' : 'ok',
      duration_ms: elapsedMs(startedAt),
      returned_rows: Array.isArray(detail.data?.data) ? detail.data.data.length : undefined,
    });
  });
}

type WorkerPayload = { query?: string; inlineCharts?: boolean };

async function execute(command: string, payload: WorkerPayload = {}): Promise<unknown> {
  if (command === 'load') {
    currentStage = 'source';
    const source = await avaSource(settings.source);
    try {
      await ava.source(source);
    } catch (error) {
      if (source.type === 'feishu-bitable') throw bitableReadError(error);
      throw error;
    }
    await ava.semantic({}, () => ({ description: '请用简体中文回答。数值必须基于查询结果，说明统计口径和缺失值。不要编造因果关系。' }));
    currentStage = 'schema';
    const schema = await ava.schema();
    currentStage = 'profile';
    const profile = await ava.profile({ metrics: ['row_count', 'null_count'] });
    currentStage = 'preview';
    const previews: DatasetInfo['previews'] = [];
    for (const model of schema.models.slice(0, 3)) {
      const ref = model.tableReference;
      const table = [ref.catalog, ref.schema, ref.table].filter((s): s is string => !!s).map(identifier).join('.');
      const result = await ava.query(`SELECT * FROM ${table} LIMIT 5`, { maxRows: 5, maxResultBytes: 16_384 });
      previews.push({ table: model.name, rows: result.data });
    }
    info = { name: settings.source.name, schema, profile, previews };
    return info;
  }
  if (command === 'dispose') { await ava.dispose(); return null; }
  if (!info) throw new UserError('请先上传表格。');
  if (command === 'info') return info;
  if (command === 'export') {
    if (!lastResult) throw new UserError('请先完成一次分析，再导出结果。', 'NO_ANALYSIS');
    return { result: lastResult, visualization: null } satisfies AnalysisOutput;
  }
  if (command === 'suggest') { currentStage = 'suggest'; return ava.suggest(3); }
  if (command === 'visualize') { currentStage = 'visualization'; return lastResult ? ava.visualize(lastResult) : null; }
  if (command !== 'analyze' || !payload.query?.trim()) throw new UserError('请输入要分析的问题。');
  const query = payload.query.trim();
  if (query.length > 6000) throw new UserError('问题最多支持 6000 个字符，请精简后重试。');
  const context = history.length ? `\n以下是同一份数据的历史问题与查询，用于理解本次追问。每次都需要重新执行查询。\n${JSON.stringify(history)}\n` : '';
  currentStage = 'analysis';
  if (requestLogContext.getStore()) {
    logEvent('analysis_started', { file_name: info.name, history_turns: history.length });
  }
  const options = {
    maxRows: settings.maxResultRows, maxResultBytes: 512 * 1024, strategy: { type: 'direct', maxRetries: 2 },
  } as const;
  let result: AnalysisResponse;
  activeAnalysis = payload.inlineCharts ? {} : undefined;
  try {
    result = await ava.analyze(analysisPrompt(query, info, context, payload.inlineCharts), options);
  } catch (error) {
    if (activeAnalysis?.summaryFailed && activeAnalysis.execution) {
      result = { ...activeAnalysis.execution, query, sql: activeAnalysis.sql, text: '' };
      result.text = chartConclusion(inlineCharts(result)[0]);
      if (requestLogContext.getStore()) logEvent('analysis_summary_fallback', {}, 'warn');
    } else {
      throw error;
    }
  } finally {
    activeAnalysis = undefined;
  }
  result.query = query;
  history.push({ query: query.slice(0, 1000), sql: result.sql?.slice(0, 2000), text: result.text.slice(0, 1000) });
  if (history.length > 4) history.shift();
  lastResult = result;
  const output: AnalysisOutput = { result, visualization: null };
  if (payload.inlineCharts) {
    output.charts = inlineCharts(result);
    if (requestLogContext.getStore()) logEvent('analysis_charts_prepared', { chart_count: output.charts.length });
  }
  return output;
}

// Keep every AVA instance and its conversation inside a dedicated worker.
let chain = Promise.resolve();
parentPort!.on('message', ({ id, command, payload, trace }: { id: number; command: string; payload: WorkerPayload; trace?: RequestLogContext }) => {
  chain = chain.then(() => requestLogContext.run(trace, async () => {
    currentStage = undefined;
    try { parentPort!.postMessage({ id, ok: true, value: await execute(command, payload) }); }
    catch (error) { parentPort!.postMessage({ id, ok: false, error: publicFailure(error, currentStage) }); }
  }));
});
