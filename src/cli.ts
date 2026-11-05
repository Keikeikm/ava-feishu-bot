import 'dotenv/config';
import { parseArgs } from 'node:util';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { loadConfig } from './config.js';
import { fileExtension } from './sources.js';
import { EngineClient } from './engine.js';
import { resultCsv } from './cards.js';
import { publicFailure } from './errors.js';
import type { AnalysisOutput, DatasetInfo } from './types.js';

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { file: { type: 'string' }, prompt: { type: 'string' }, out: { type: 'string', default: './output' }, 'no-chart': { type: 'boolean', default: false }, help: { type: 'boolean' } } });
  if (values.help || !values.file || !values.prompt) {
    console.info('用法：npm run analyze -- --file examples/sales.csv --prompt "按地区汇总销售额" [--no-chart] [--out output]');
    if (!values.help) process.exitCode = 1;
    return;
  }
  const config = loadConfig(process.env, false);
  const name = basename(values.file);
  const ext = fileExtension(name);
  if ((await stat(values.file)).size > config.maxFileBytes) throw new Error('文件超过 MAX_FILE_MB 限制。');
  const directory = await mkdtemp(join(tmpdir(), 'ava-cli-'));
  let engine: EngineClient | undefined;
  try {
    const path = join(directory, `input${ext}`);
    await copyFile(values.file, path);
    engine = new EngineClient({ kind: 'file', path, name }, config);
    const info = await engine.request<DatasetInfo>('load');
    console.info(`已加载 ${name}，${info.schema.models.length} 张表。`);
    const output: AnalysisOutput = await engine.analyze(values.prompt, config.enableCharts && !values['no-chart']);
    const out = resolve(values.out!);
    await mkdir(out, { recursive: true, mode: 0o700 });
    await writeFile(join(out, 'analysis-report.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
    await writeFile(join(out, 'analysis-result.csv'), resultCsv(output.result.data, output.result.schema.map(c => c.name)), { mode: 0o600 });
    if (output.visualization) await writeFile(join(out, 'analysis-chart.html'), output.visualization.html, { mode: 0o600 });
    console.info(output.result.text);
    console.info(`结果已保存至 ${out}`);
  } finally {
    await engine?.close();
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(publicFailure(error).message); process.exitCode = 1; });
