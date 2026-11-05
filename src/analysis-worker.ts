import { parentPort, workerData } from 'node:worker_threads';
import { AVA, type AnalysisResponse, type LLMConfig } from '@antv/ava';
import { avaSource } from './sources.js';
import { publicFailure, UserError, type FailureStage } from './errors.js';
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
const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;

async function execute(command: string, payload: { query?: string; charts?: boolean } = {}): Promise<unknown> {
  if (command === 'load') {
    currentStage = 'source';
    await ava.source(await avaSource(settings.source));
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
  if (command === 'suggest') { currentStage = 'suggest'; return ava.suggest(3); }
  if (command === 'visualize') { currentStage = 'visualization'; return lastResult ? ava.visualize(lastResult) : null; }
  if (command !== 'analyze' || !payload.query?.trim()) throw new UserError('请输入要分析的问题。');
  const query = payload.query.trim();
  if (query.length > 6000) throw new UserError('问题最多支持 6000 个字符，请精简后重试。');
  const context = history.length ? `\n以下是同一份数据的历史问题与查询，用于理解本次追问。每次都需要重新执行查询。\n${JSON.stringify(history)}\n` : '';
  currentStage = 'analysis';
  const result = await ava.analyze(`${context}\n当前问题：${query}\n请基于数据回答，用简体中文解释结论和统计口径。`, {
    maxRows: settings.maxResultRows,
    maxResultBytes: 512 * 1024,
    strategy: { type: 'direct', maxRetries: 2 },
  });
  result.query = query;
  history.push({ query: query.slice(0, 1000), sql: result.sql?.slice(0, 2000), text: result.text.slice(0, 1000) });
  if (history.length > 4) history.shift();
  lastResult = result;
  const output: AnalysisOutput = { result, visualization: null };
  return output;
}

// Keep every AVA instance and its conversation inside a dedicated worker.
let chain = Promise.resolve();
parentPort!.on('message', ({ id, command, payload }: { id: number; command: string; payload: { query?: string; charts?: boolean } }) => {
  chain = chain.then(async () => {
    currentStage = undefined;
    try { parentPort!.postMessage({ id, ok: true, value: await execute(command, payload) }); }
    catch (error) { parentPort!.postMessage({ id, ok: false, error: publicFailure(error, currentStage) }); }
  });
});
