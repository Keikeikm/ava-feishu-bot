import { parentPort, workerData } from 'node:worker_threads';
import { AVA, type AnalysisResponse, type ExecutionResult, type LLMConfig } from '@antv/ava';
import { avaSource } from './sources.js';
import { loadBitable } from './bitable.js';
import { analysisPrompt } from './analysis-prompt.js';
import { isSubmissionOverview } from './archive.js';
import { chartConclusion, inlineCharts } from './charts.js';
import { bitableReadError, publicFailure, UserError, type FailureStage } from './errors.js';
import { elapsedMs, logEvent, requestLogContext, type RequestLogContext } from './logging.js';
import type { AnalysisOutput, DatasetInfo, DatasetSource } from './types.js';
import { trainingSnapshot, type TrainingRequest } from './training.js';

const settings = workerData as { source: DatasetSource; directory?: string; llm: LLMConfig; maxResultRows: number };
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

async function labelCaveat(schema: DatasetInfo['schema'], profile: DatasetInfo['profile']): Promise<string | undefined> {
  const model = schema.models[0];
  if (settings.source.kind !== 'file' || schema.models.length !== 1 || model?.name !== 'data'
      || Number(profile.models[0]?.metrics.row_count) !== 418) return;
  const columns = new Set(model.columns.map(column => column.name.toLowerCase()));
  if (!['passengerid', 'survived', 'sex', 'pclass'].every(column => columns.has(column))) return;

  const { data } = await ava.query(`SELECT COUNT(DISTINCT PassengerId) AS ids,
    MIN(TRY_CAST(PassengerId AS BIGINT)) AS first_id, MAX(TRY_CAST(PassengerId AS BIGINT)) AS last_id,
    COUNT(*) FILTER (WHERE TRY_CAST(Survived AS DOUBLE) = CASE LOWER(TRIM(CAST(Sex AS VARCHAR))) WHEN 'female' THEN 1 WHEN 'male' THEN 0 END) AS matched
    FROM data`);
  const row = data[0];
  if (Number(row?.ids) === 418 && Number(row?.first_id) === 892 && Number(row?.last_id) === 1309 && Number(row?.matched) === 418) {
    return '这 418 条记录的 Survived 标签与 Kaggle 按性别生成的示例预测规则完全一致。标签来源待核实，分析只描述文件中的标签分布，不能作为历史生还率或模型效果。';
  }
}

// AVA events can carry queries, records and provider errors. Select only process metadata.
const stages = {
  source: 'source', schema: 'schema', profile: 'profile',
  translate: 'generate_sql', query: 'execute_sql', summarize: 'summarize',
  suggest: 'suggest', visualize: 'visualize',
};
for (const [event, stage] of Object.entries(stages)) {
  let startedAt = 0;
  const stageName = () => {
    if (event !== 'query') return stage;
    if (currentStage === 'preview') return 'preview';
    if (currentStage === 'training') return 'training_data';
    return stage;
  };
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

type WorkerPayload = { query?: string; inlineCharts?: boolean; training?: TrainingRequest };

async function execute(command: string, payload: WorkerPayload = {}): Promise<unknown> {
  if (command === 'load') {
    currentStage = 'source';
    if (settings.source.kind === 'bitable') {
      try {
        const tables = await loadBitable(ava, settings.source, settings.directory);
        if (requestLogContext.getStore()) logEvent('bitable_tables_loaded', { tables });
      } catch (error) {
        throw bitableReadError(error);
      }
    } else {
      await ava.source(await avaSource(settings.source));
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
    info = { name: settings.source.name, schema, profile, previews, labelCaveat: await labelCaveat(schema, profile) };
    return info;
  }
  if (command === 'dispose') { await ava.dispose(); return null; }
  if (!info) throw new UserError('请先上传表格。');
  if (command === 'info') return info;
  if (command === 'training-data' && payload.training) {
    currentStage = 'training';
    return trainingSnapshot(ava, info, payload.training);
  }
  if (command === 'export') {
    if (!lastResult) throw new UserError('请先完成一次分析，再导出结果。', 'NO_ANALYSIS');
    return { result: lastResult, visualization: null } satisfies AnalysisOutput;
  }
  if (command === 'suggest') { currentStage = 'suggest'; return ava.suggest(3); }
  if (command === 'visualize') { currentStage = 'visualization'; return lastResult ? ava.visualize(lastResult) : null; }
  if (command !== 'analyze' || !payload.query?.trim()) throw new UserError('请输入要分析的问题。');
  const query = payload.query.trim();
  if (query.length > 6000) throw new UserError('问题最多支持 6000 个字符，请精简后重试。');
  const prediction = settings.source.kind === 'file' ? settings.source.prediction : undefined;
  const predictionContext = prediction ? `\n当前表是同一会话上一轮生成的测试集预测 submission.csv，预测目标为 ${JSON.stringify(prediction.target)}。请把目标值描述为预测值；没有真实标签可用来计算准确率。画分布图时，分类用各预测类别计数，回归用数值分箱计数。\n` : '';
  const context = predictionContext + (history.length ? `\n以下是同一份数据的历史问题与查询，用于理解本次追问。每次都需要重新执行查询。\n${JSON.stringify(history)}\n` : '');
  currentStage = 'analysis';
  const startedAt = performance.now();
  if (requestLogContext.getStore()) {
    logEvent('analysis_started', { file_name: info.name, tables: info.schema.models.length, history_turns: history.length, charts_requested: !!payload.inlineCharts });
  }
  const options = {
    maxRows: settings.maxResultRows, maxResultBytes: 512 * 1024, strategy: { type: 'direct', maxRetries: 2 },
  } as const;
  let result: AnalysisResponse;
  const predictionOverview = prediction?.task === 'classification' && isSubmissionOverview(query);
  if (predictionOverview) {
    const target = identifier(prediction.target);
    const sql = `SELECT CAST(${target} AS VARCHAR) AS "预测类别", COUNT(*) AS "预测条数" FROM data GROUP BY 1 ORDER BY 2 DESC, 1`;
    const execution = await ava.query(sql, { maxRows: 20 });
    const total = execution.data.reduce((sum, row) => sum + Number(row.预测条数), 0);
    const distribution = execution.data.map(row => `${row.预测类别}：${row.预测条数} 条（${(100 * Number(row.预测条数) / total).toFixed(1)}%）`).join('；');
    result = { ...execution, query, sql, text: `上一轮 submission.csv 的「${prediction.target}」预测共 ${total} 条。\n${distribution}。\n图表统计的是模型预测类别。` };
  } else {
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
  }
  result.query = query;
  if (info.labelCaveat) result.text = `${result.text.trim()}\n【标签口径】${info.labelCaveat}`.trim();
  history.push({ query: query.slice(0, 1000), sql: result.sql?.slice(0, 2000), text: result.text.slice(0, 1000) });
  if (history.length > 4) history.shift();
  lastResult = result;
  const output: AnalysisOutput = { result, visualization: null };
  if (payload.inlineCharts) {
    output.charts = predictionOverview ? [{
      kind: 'bar', title: `${prediction.target} 预测类别分布（条）`, limited: !!result.truncated,
      points: result.data.map(row => ({ label: String(row.预测类别), value: Number(row.预测条数) })),
    }] : inlineCharts(result);
    if (requestLogContext.getStore()) logEvent('analysis_charts_prepared', { chart_count: output.charts.length });
  }
  if (requestLogContext.getStore()) {
    logEvent('analysis_finished', { returned_rows: result.data.length, truncated: !!result.truncated, chart_count: output.charts?.length ?? 0, duration_ms: elapsedMs(startedAt) });
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
