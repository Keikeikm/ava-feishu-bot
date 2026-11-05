import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { AVA } from '@antv/ava';
import { UserError } from './errors.js';
import type { DatasetInfo } from './types.js';

const trainingPrefix = /^(?:\/(?:训练|train)(?=\s|$)|(?:请)?(?:帮我)?(?:用(?:这张表|这份数据|当前表格|当前数据|随机森林|逻辑回归)(?:来)?)?(?:预测|训练(?:\s*(?:随机森林|逻辑回归)\s*预测)?))/i;
const rowLimit = 5000;
const featureLimit = 80;
const root = new URL('../../', import.meta.url);

export interface TrainingRequest { table: string; target: string }
interface TrainingColumn { name: string; kind: 'number' | 'category' }
export interface TrainingInput extends TrainingRequest {
  dataset: string;
  columns: TrainingColumn[];
  excluded: string[];
  rows: unknown[][];
}
export interface ModelScore {
  model: 'majority' | 'logistic' | 'forest';
  accuracy: number;
  balancedAccuracy: number;
  macroF1: number;
}
export interface TrainingReport {
  rows: number;
  missingLabels: number;
  features: number;
  folds: number;
  grouped: boolean;
  labels: string[];
  scores: ModelScore[];
  selected: 'logistic' | 'forest';
  confusion: number[][];
}

export function isTrainingRequest(text: string): boolean {
  return trainingPrefix.test(text);
}

export function resolveTrainingRequest(text: string, info: DatasetInfo): TrainingRequest {
  if (text.length > 6000) throw new UserError('请精简训练指令。', 'ML_TARGET');
  const input = text.replace(trainingPrefix, '').trim();
  const tableOption = /\s+--表\s+(?:"([^"]+)"|“([^”]+)”|(.+))$/u.exec(input);
  const table = tableOption && (tableOption[1] || tableOption[2] || tableOption[3])?.trim();
  const goal = (tableOption ? input.slice(0, tableOption.index) : input).trim();
  const quoted = /^(?:"([^"]+)"|“([^”]+)”|`([^`]+)`)/u.exec(goal);
  const target = (quoted?.[1] || quoted?.[2] || quoted?.[3] || goal.split(/[，,。；;！!？?]/u, 1)[0] || '').trim();
  const models = info.schema.models.filter(model => !table || model.name === table);
  if (!models.length) throw new UserError('找不到指定数据表。请用 /字段 查看表名和目标列。', 'ML_TARGET');

  const candidates = models.flatMap(model => model.columns
    .filter(column => column.name.toLowerCase() === target.toLowerCase()
      || (/^(?:是否)?(?:生还|幸存|存活)$/.test(target) && column.name.toLowerCase() === 'survived'))
    .map(column => ({ table: model.name, target: column.name })));
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    throw new UserError(`多张表包含目标列「${target}」。请发送 /训练 "${target}" --表 "表名"。`, 'ML_TARGET');
  }
  throw new UserError('请指定要预测的分类目标列，例如 /训练 Survived。目标列名称可通过 /字段 查看。', 'ML_TARGET');
}

function trainingColumn(name: string, type: string): TrainingColumn | undefined {
  // Avoid common identifiers and direct contact fields. Name matches are conservative.
  if (/(?:^|[_\s])id$|^(?:passengerid|name|full_?name|ticket|email|phone)$|编号|姓名|手机号|邮箱/i.test(name) || /(?:Id|ID)$/.test(name)) return;
  if (/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|INT[248]?|FLOAT|DOUBLE|REAL|DECIMAL|NUMERIC)(?:\b|\()/i.test(type)) return { name, kind: 'number' };
  if (/^(?:VARCHAR|TEXT|STRING|CHAR|ENUM|BOOLEAN|BOOL)\b/i.test(type) && !/\[\]$/.test(type)) return { name, kind: 'category' };
}

export async function trainingSnapshot(ava: AVA, info: DatasetInfo, request: TrainingRequest): Promise<TrainingInput> {
  const model = info.schema.models.find(m => m.name === request.table);
  const target = model?.columns.find(c => c.name === request.target);
  if (!model || !target) throw new UserError('找不到指定的目标列。请用 /字段 查看当前数据。', 'ML_TARGET');
  if (info.labelCaveat && target.name.toLowerCase() === 'survived') {
    throw new UserError(`${info.labelCaveat} 请上传带有可验证标签的训练数据后再训练。`, 'ML_UNVERIFIED_LABEL', 'training');
  }

  const features = model.columns.filter(c => c !== target);
  const columns = features.flatMap(c => trainingColumn(c.name, c.type) ?? []);
  if (!columns.length) throw new UserError('没有可用于训练的数值或类别特征。', 'ML_FEATURES', 'training');
  if (columns.length > featureLimit) throw new UserError(`单次训练最多支持 ${featureLimit} 个特征，请缩小数据范围。`, 'ML_LIMIT', 'training');
  const names = [target.name, ...columns.map(c => c.name)];
  const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const ref = model.tableReference;
  const table = [ref.catalog, ref.schema, ref.table].filter((name): name is string => Boolean(name)).map(identifier).join('.');
  const result = await ava.query(`SELECT ${names.map(identifier).join(', ')} FROM ${table}`, { maxRows: rowLimit, maxResultBytes: 4 * 1024 * 1024 });
  if (result.truncated) throw new UserError(`训练数据超过 ${rowLimit} 行或 4 MB，请提供更小的表格。`, 'ML_LIMIT', 'training');
  return {
    ...request, dataset: info.name, columns,
    excluded: features.filter(c => !names.includes(c.name)).map(c => c.name),
    rows: result.data.map(row => names.map(name => row[name])),
  };
}

export function trainClassifier(input: TrainingInput, timeoutMs: number, configuredPython?: string): Promise<TrainingReport> {
  const venv = fileURLToPath(new URL('.venv/bin/python', root));
  const python = configuredPython || (existsSync(venv) ? venv : 'python3');
  const script = fileURLToPath(new URL('ml/train.py', root));
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' },
    });
    let output = '';
    let interrupted = false;
    const timeout = setTimeout(() => {
      interrupted = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (output.length + chunk.length > 65_536) child.kill('SIGKILL');
      else output += chunk;
    });
    const unavailable = () => new UserError('训练环境未就绪。请按 README 安装 Python 训练依赖。', 'ML_RUNTIME', 'training');
    child.once('error', () => {
      clearTimeout(timeout);
      reject(unavailable());
    });
    child.once('close', code => {
      clearTimeout(timeout);
      if (interrupted) { reject(new UserError('训练超时，请缩小数据范围后重试。', 'ML_TIMEOUT', 'training')); return; }
      if (code !== 0) { reject(new UserError('训练进程执行失败，请检查训练环境和数据类型。', 'ML_FAILED', 'training')); return; }
      try {
        const reply = JSON.parse(output) as { report?: TrainingReport; error?: { code: string; message: string } };
        if (reply.error?.code === 'ML_RUNTIME') reject(unavailable());
        else if (reply.error) reject(new UserError(reply.error.message, reply.error.code, 'training'));
        else if (reply.report) resolve(reply.report);
        else throw new Error('Missing training report');
      } catch {
        reject(new UserError('训练进程没有返回有效的评估报告。', 'ML_FAILED', 'training'));
      }
    });
    child.stdin.on('error', () => { /* Process exit reports startup and training errors. */ });
    child.stdin.end(JSON.stringify(input));
  });
}
