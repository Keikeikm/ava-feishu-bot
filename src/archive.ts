import type { Config } from './config.js';
import { UserError } from './errors.js';
import { runPython } from './python.js';
import { dataExtensions } from './sources.js';
import type { TrainingReport } from './training.js';

interface ArchiveFile { name: string; entry: string; path: string }
export interface Archive { kind: 'archive'; name: string; files: ArchiveFile[] }
interface SubmissionReport { report: TrainingReport; csv: string; rows: number; target: string }
export interface SavedSubmission { csv: string; target: string; task: TrainingReport['task']; template: string }
type Comparison =
  | { task: 'classification'; total: number; matches: number }
  | { task: 'regression'; total: number; mae: number; rmse: number };

export async function openArchive(name: string, path: string, config: Config): Promise<Archive> {
  const files = await runPython<ArchiveFile[]>('archive', {
    path, extensions: dataExtensions, limit: Math.min(3 * config.maxFileBytes, 100 * 1024 * 1024),
  }, Math.min(config.jobTimeoutMs, 30_000), config.mlPython);
  return { kind: 'archive', name, files };
}

export function archiveGuide(archive: Archive, selected?: number): string {
  const list = archive.files.map((file, i) => `${i + 1}. ${file.entry}${i === selected ? '（当前分析）' : ''}`).join('\n');
  const names = new Set(archive.files.map(file => file.name.toLowerCase()));
  const prediction = names.has('train.csv') && names.has('test.csv')
    ? '\n要训练并生成提交文件，发送「请用机器学习预测」或 /预测。'
    : '';
  return `已解压 ${archive.name}：\n${list}\n\n你想分析哪个文件？可以直接在问题里写文件名，也可以发送 /选文件 加编号后提问。${prediction}`;
}

/** Resolve full ZIP paths and standalone basenames embedded in a question. */
export function mentionedArchiveFiles(files: Archive['files'], text: string): number[] {
  const mentions = files.flatMap((file, index) => [...new Set([file.entry, file.name])].flatMap(name => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...text.matchAll(new RegExp(`(?<![a-z0-9_./-])${escaped}(?![a-z0-9_/-]|\\.[a-z0-9])`, 'giu'))]
      .map(match => ({ index, start: match.index, end: match.index + match[0].length }));
  }));
  return [...new Set(mentions.filter(mention => !mentions.some(other =>
    other.start <= mention.start && other.end >= mention.end
      && (other.start < mention.start || other.end > mention.end),
  )).map(mention => mention.index))];
}

export function isArchivePrediction(text: string): boolean {
  if (/^\/分析(?:\s|$)/.test(text)) return false;
  return /^\/(?:预测|predict)(?:\s|$)/i.test(text)
    || /(?:机器学习[\s\S]*预测|预测[\s\S]*机器学习|(?:预测|训练)[\s\S]*(?:测试集|test\.csv|提交文件|submission\.csv)|^预测(?:$|\s|一下|测试))/iu.test(text);
}

export function refersToSubmission(text: string): boolean {
  return /(?:^|[^a-z0-9_.-])submission\.csv(?![a-z0-9_.-])/i.test(text)
    || /(?:生成的|刚才的|上一轮的?|刚刚的|上次的|本次的|刚生成的)?预测(?:数据|结果|输出|值)|预测分布/.test(text);
}

export function isSubmissionOverview(text: string): boolean {
  return /^(?:(?:请(?:你)?(?:帮我)?|帮我)\s*)?(?:(?:对|把|将)\s*)?(?:(?:刚才|刚刚|刚|上一轮)?生成的|刚才的|上一轮的|上次的)?\s*(?:(?:预测(?:数据|结果|输出|值)|submission\.csv)\s*(?:进行|做|的)?)?\s*(?:可视化|画(?:一张|个|一下)?图|展示分布|看(?:一下)?分布|统计分布)[。！？!?\s]*$/i.test(text);
}

export function isSubmissionComparison(text: string): boolean {
  if (/^\/(?:分析|预测|predict|训练|train)(?:\s|$)/i.test(text)) return false;
  return /^\/(?:对比|评估)(?:\s|$)/.test(text)
    || (/(?:对比|比较|核对|校验|检验|验证|评估|正确率|准确率|误差)/.test(text)
      && (/(?:真实(?:值|结果|标签)|参考(?:值|结果|标签)|答案|ground\s*truth)/i.test(text)
        || (/预测/.test(text) && /(?:正确率|准确率|误差|\.csv)/i.test(text))));
}

export function comparisonFile(archive: Archive, text: string): ArchiveFile {
  const command = /^\/(?:对比|评估)(?:\s+(.*))?$/.exec(text);
  const name = command?.[1]?.trim().replace(/^["“`]|["”`]$/g, '').toLowerCase();
  const csvFiles = archive.files.filter(file => /\.csv$/i.test(file.name));
  const matches = command ? csvFiles.filter(file => [file.entry, file.name].some(value => value.toLowerCase() === name))
    : mentionedArchiveFiles(csvFiles, text).map(index => csvFiles[index]!);
  if (matches.length !== 1) throw new UserError(matches.length
    ? '对比请求匹配到多个 CSV。请发送 /对比 加 ZIP 内的完整文件路径。'
    : '请发送 /对比 文件名.csv 指定 ZIP 里的对照表，也可以把真实标签 CSV 和「/对比」一起发给我。', 'ML_REFERENCE');
  return matches[0]!;
}

export async function compareSubmission(submission: SavedSubmission, reference: { name: string; path: string }, config: Config): Promise<string> {
  const result = await runPython<Comparison>('train', { comparison: {
    ...submission, reference: reference.path,
  } }, Math.min(config.jobTimeoutMs, 30_000), config.mlPython);
  const example = /^(?:gender|sample)[_-]submission\.csv$/i.test(reference.name)
    || reference.name.toLowerCase() === submission.template.toLowerCase();
  const intro = `上一轮「${submission.target}」预测与 ${reference.name} 按 ID 对齐，共 ${result.total} 条。`;
  const metric = result.task === 'classification'
    ? `${example ? '一致率' : '按所提供标签计算的准确率'} ${(100 * result.matches / result.total).toFixed(2)}%（一致 ${result.matches} 条，差异 ${result.total - result.matches} 条）。`
    : `MAE ${result.mae.toPrecision(4)}，RMSE ${result.rmse.toPrecision(4)}。`;
  const caveat = example ? '\n这个文件用作提交示例，以上数字只衡量与示例预测的差异。真实准确率需要测试集的真实标签。' : '';
  return `${intro}\n${metric}${caveat}`;
}

export async function predictArchive(archive: Archive, text: string, config: Config): Promise<SubmissionReport & { template: string }> {
  const find = (match: (name: string) => boolean, label: string) => {
    const files = archive.files.filter(file => match(file.name.toLowerCase()));
    if (files.length !== 1) throw new UserError(`ZIP 中需要且只能有一份${label}。`, 'ZIP_PREDICTION_FILES', 'training');
    return files[0]!;
  };
  const train = find(name => name === 'train.csv', ' train.csv');
  const test = find(name => name === 'test.csv', ' test.csv');
  const template = find(name => /^(?:(?:.+[_-])?submission|submission[_-]template)\.csv$/.test(name), '提交模板（如 sample_submission.csv 或 gender_submission.csv）');
  const regression = /(?:^|\s)--回归(?=\s|$)|回归(?:任务|模型|预测)/.test(text);
  const classification = /(?:^|\s)--分类(?=\s|$)|分类(?:任务|模型|预测)/.test(text);
  if (regression && classification) throw new UserError('请只指定一种预测任务：分类或回归。', 'ML_TARGET', 'training');
  const target = /(?:--目标\s+|目标(?:列|字段|变量)\s*(?:是|为|[:：=])\s*)(?:"([^"]+)"|“([^”]+)”|`([^`]+)`|([^\s，,。；;（(]+))/u.exec(text);
  const result = await runPython<SubmissionReport>('train', {
    submission: { train: train.path, test: test.path, template: template.path },
    task: regression ? 'regression' : classification ? 'classification' : undefined,
    target: target?.slice(1).find(Boolean),
  }, Math.min(config.jobTimeoutMs, 120_000), config.mlPython, 8 * 1024 * 1024);
  return { ...result, template: template.name };
}
