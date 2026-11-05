import type { AVA } from '@antv/ava';
import { UserError } from './errors.js';
import { runPython } from './python.js';
import type { DatasetInfo } from './types.js';

const trainingPrefix = /^(?:\/(?:训练|train)(?=\s|$)|(?:请)?(?:帮我)?(?:用(?:这张表|这份数据|当前表格|当前数据|随机森林|逻辑回归)(?:来)?)?(?:预测|训练(?:\s*(?:随机森林|逻辑回归)\s*预测)?))/i;
const rowLimit = 5000;
const featureLimit = 80;

type TrainingTask = 'classification' | 'regression';
export interface TrainingRequest { table: string; target: string; task: TrainingTask }
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
interface ValidationReport {
  rows: number;
  missingLabels: number;
  features: number;
  folds: number;
  grouped: boolean;
}
interface ClassificationReport extends ValidationReport {
  task: 'classification';
  labels: string[];
  scores: ModelScore[];
  selected: 'logistic' | 'forest';
  confusion: number[][];
}
interface RegressionReport extends ValidationReport {
  task: 'regression';
  scores: { model: 'median' | 'ridge' | 'forest'; mae: number; rmse: number; r2: number }[];
  selected: 'ridge' | 'forest';
}
export type TrainingReport = ClassificationReport | RegressionReport;
export interface TrainingRun {
  source: string;
  target: string;
  report: TrainingReport;
  predictionRows?: number;
}

export const trainingModelNames = {
  majority: '多数类基线', logistic: '逻辑回归', forest: '随机森林',
  median: '中位数基线', ridge: '岭回归',
};

export function isTrainingModelQuestion(text: string): boolean {
  if (/^\/(?:模型|model)[。！？!?\s]*$/i.test(text)) return true;
  if (text.startsWith('/')) return false;
  return /(?:用|选|比较|训练)[^。！？!?\n]{0,18}(?:什么|哪个|哪种|哪些)(?:机器学习)?(?:模型|算法)|(?:模型|算法)(?:是|用了|用的是)(?:什么|哪个|哪种|哪些)|模型[^。！？!?\n]{0,20}缓存[^。！？!?\n]{0,10}吗/.test(text);
}

export function trainingMetric(score: TrainingReport['scores'][number]): string {
  return 'mae' in score ? `MAE ${score.mae.toPrecision(4)}` : `宏平均 F1 ${(score.macroF1 * 100).toFixed(1)}%`;
}

export function selectedTrainingModel(report: TrainingReport): string {
  const estimator = report.selected === 'forest'
    ? (report.task === 'classification' ? 'RandomForestClassifier' : 'RandomForestRegressor')
    : report.selected === 'logistic' ? 'LogisticRegression' : 'Ridge';
  return `${trainingModelNames[report.selected]}（${estimator}）`;
}

export function trainingSummary(run: TrainingRun): string {
  const { source, target, report, predictionRows } = run;
  const comparison = report.scores.map(score => `${trainingModelNames[score.model]} ${trainingMetric(score)}`).join('、');
  const fitting = predictionRows === undefined ? '这轮只做了交叉验证评估。'
    : `选定后，用全部 ${report.rows} 条有标签记录重新拟合，为 ${predictionRows} 条测试记录生成预测。`;
  return `上一轮用 ${source} 训练，目标列为「${target}」。\n`
    + `选定模型：${selectedTrainingModel(report)}。\n`
    + `训练集 ${report.folds} 折交叉验证：${comparison}。\n`
    + `${fitting}训练在本机运行；会话保留评估记录，拟合后的模型随训练进程结束释放。`;
}

export function isTrainingRequest(text: string): boolean {
  return trainingPrefix.test(text);
}

export function resolveTrainingRequest(text: string, info: DatasetInfo): TrainingRequest {
  if (text.length > 6000) throw new UserError('请精简训练指令。', 'ML_TARGET');
  const input = text.replace(trainingPrefix, '').trim();
  const tableOption = /\s+--表\s+(?:"([^"]+)"|“([^”]+)”|(.+))$/u.exec(input);
  const table = tableOption && (tableOption[1] || tableOption[2] || tableOption[3])?.trim();
  const command = (tableOption ? input.slice(0, tableOption.index) : input).trim();
  const regressionFlag = /(?:^|\s)--回归$/u;
  const goal = command.replace(regressionFlag, '').trim();
  const natural = !text.startsWith('/');
  const explicitTarget = natural ? /(?:目标(?:字段|列|变量)|预测目标)\s*(?:是|为|[:：=])\s*/u.exec(goal) : null;
  const targetText = explicitTarget ? goal.slice(explicitTarget.index + explicitTarget[0].length) : goal;
  const quoted = /^(?:"([^"]+)"|“([^”]+)”|`([^`]+)`)/u.exec(targetText);
  const target = (quoted?.[1] || quoted?.[2] || quoted?.[3] || targetText.split(/[，,。；;！!？?]/u, 1)[0] || '').trim();
  const regression = regressionFlag.test(command) || (natural && /(?:回归任务|回归模型|做回归)/u.test(goal));
  const task: TrainingTask = regression ? 'regression' : 'classification';
  const models = info.schema.models.filter(model => !table || model.name === table);
  if (!models.length) throw new UserError('找不到指定数据表。请用 /字段 查看表名和目标列。', 'ML_TARGET');

  const columns = models.flatMap(model => model.columns.map(column => ({ table: model.name, target: column.name, task })));
  let candidates = columns
    .filter(column => column.target.toLowerCase() === target.toLowerCase()
      || (/^(?:是否)?(?:生还|幸存|存活)$/.test(target) && column.target.toLowerCase() === 'survived'));
  if (!candidates.length && explicitTarget && !quoted) {
    // The field may be followed by a human-readable annotation, such as MEDV（房价中位数）.
    const prefixes = columns.filter(column => target.toLowerCase().startsWith(column.target.toLowerCase())
      && /^\s*[(（]/u.test(target.slice(column.target.length)));
    const longest = Math.max(...prefixes.map(column => column.target.length));
    candidates = prefixes.filter(column => column.target.length === longest);
  }
  if (candidates.length === 1) return candidates[0]!;
  if (candidates.length > 1) {
    const name = candidates[0]!.target;
    throw new UserError(`多张表包含目标列「${name}」。请发送 /训练 "${name}"${task === 'regression' ? ' --回归' : ''} --表 "表名"。`, 'ML_TARGET');
  }
  throw new UserError('找不到要预测的目标列。请用 /字段 核对列名，再发送 /训练 目标列。回归任务可用 /训练 目标列 --回归。', 'ML_TARGET');
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

export function trainModel(input: TrainingInput, timeoutMs: number, configuredPython?: string): Promise<TrainingReport> {
  return runPython('train', input, timeoutMs, configuredPython);
}
