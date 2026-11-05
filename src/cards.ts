import type { AnalysisOutput, DatasetInfo } from './types.js';
import { SUPPORTED_FILES } from './sources.js';
import { feishuChart, feishuChartTitle, type InlineChart } from './charts.js';
import { trainingModelNames, type TrainingInput, type TrainingReport } from './training.js';

export type Card = ReturnType<typeof card> | { schema: '2.0'; header: ReturnType<typeof card>['header']; body: { elements: (ReturnType<typeof plain> | ReturnType<typeof feishuChart>)[] } };
const plain = (text: string) => ({ tag: 'div', text: { tag: 'plain_text', content: text.slice(0, 4000) } });
const chartElements = (chart: InlineChart) => [plain(feishuChartTitle(chart)), feishuChart(chart)];
function card(title: string, elements: ReturnType<typeof plain>[], color = 'blue') {
  // Keep large schemas and long answers within Feishu's message payload limit.
  const bounded: ReturnType<typeof plain>[] = [];
  let remaining = 7000;
  for (const element of elements) {
    const text = element.text.content;
    if (text.length <= remaining) { bounded.push(element); remaining -= text.length; }
    else {
      if (remaining) bounded.push(plain(text.slice(0, remaining)));
      bounded.push(plain('…内容较多，已截取显示。'));
      break;
    }
  }
  return { config: { wide_screen_mode: true }, header: { template: color, title: { tag: 'plain_text', content: title } }, elements: bounded };
}
function value(v: unknown, length = 70): string {
  const s = v == null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > length ? `${s.slice(0, length)}…` : s;
}
export function rowPreview(rows: Record<string, unknown>[], maxRows = 6): string {
  if (!rows.length) return '（没有数据行）';
  return rows.slice(0, maxRows).map((row, i) => `${i + 1}. ${Object.entries(row).slice(0, 6).map(([k, v]) => `${value(k, 35)}: ${value(v, 45)}`).join(' ｜ ')}`).join('\n');
}
export function helpCard(): Card {
  return card('AVA 数据分析助手', [
    plain(`发送表格和分析要求，我会给出结论、依据和相关图表。也可以只上传表格，再选择分析方向。\n支持：${SUPPORTED_FILES} / ZIP\n也可发送 /导入 加上飞书多维表格链接。`),
    plain('发送 ZIP 后可用 /选文件 1 选择表格。包含 train.csv、test.csv 和提交模板时，发送 /预测 可生成 submission.csv。'),
    plain('发送 /模型 可查看上一轮训练选定的模型和交叉验证分数。'),
    plain('例如：\n分析一下，看看哪些变化值得关注\n按地区汇总销售额，并画柱状图\n接着只看华东，按月份比较\n/分析 不画图 统计各地区销售额'),
    plain('/训练 目标列：训练分类模型\n/训练 目标列 --回归：预测连续数值并查看评估\n/建议：看看接下来可以分析什么\n/状态：查看当前使用的文件\n/清空：删除自己的数据和追问记录'),
    plain('群聊中请 @ 机器人提问；数据按「会话 + 发送者」隔离。新文件加载成功后替换旧文件。多表 Excel 可在问题中指定工作表名。'),
  ]);
}
export function datasetCard(info: DatasetInfo): Card {
  const columns = info.schema.models.flatMap(m => m.columns);
  const measure = columns.find(c => /销售额|收入|金额|营收/.test(c.name)) || columns.find(c => /INT|DOUBLE|DECIMAL|FLOAT|NUMERIC/i.test(c.type) && !/id|编号/i.test(c.name));
  const dimension = columns.find(c => /地区|部门|产品|渠道|类别/.test(c.name));
  const time = columns.find(c => /日期|月份|时间|年月/.test(c.name) || /DATE|TIMESTAMP/i.test(c.type));
  const questions = ['整体表现如何，最值得关注什么？'];
  if (measure && dimension) questions.push(`哪些${dimension.name}贡献了最多${measure.name}？`);
  if (measure && time) questions.push(`${measure.name}随${time.name}发生了什么变化？`);
  if (questions.length < 3) questions.push('有哪些异常或数据质量问题？');
  return card('表格已收到', [plain(`已读取 ${info.name}。你可以直接说“分析一下”，也可以选择一个方向：`), plain(questions.slice(0, 3).map((q, i) => `${i + 1}. ${q}`).join('\n'))], 'blue');
}
export function fieldsCard(info: DatasetInfo): Card {
  return card('字段与数据类型', info.schema.models.slice(0, 12).map(model => plain(`${model.name}\n${model.columns.slice(0, 50).map(c => `${c.name}：${c.type}`).join('\n')}${model.columns.length > 50 ? '\n…更多字段请查看原始表格' : ''}`)));
}
export function previewCard(info: DatasetInfo): Card {
  return card('数据预览（最多三张表，每表五行）', info.previews.map(p => plain(`${p.table}\n${rowPreview(p.rows, 5)}`)));
}
export function profileCard(info: DatasetInfo): Card {
  return card('数据画像', info.profile.models.slice(0, 12).map(model => {
    const nulls = model.columns.filter(c => Number(c.metrics.null_count) > 0).slice(0, 20);
    return plain(`${model.name}：${model.metrics.row_count ?? '未知'} 行\n${nulls.length ? nulls.map(c => `${c.name}：${c.metrics.null_count} 个空值`).join('\n') : '未检测到空值。'}`);
  }));
}
export function resultCard(output: AnalysisOutput): Card {
  const summary = output.result.text?.trim() || '暂时没有足够的数据得出结论。你最想比较哪个指标或时间段？';
  const caveat = output.result.truncated ? [plain('本次计算结果超出返回上限，可以缩小范围继续核实。')] : [];
  const charts = output.charts?.flatMap(chartElements) || [];
  if (!charts.length) return card('分析结论', [plain(summary), ...caveat], 'green');
  const next = summary.indexOf('【下一步】');
  const elements = next > 0
    ? [plain(summary.slice(0, next).trim()), ...charts, plain(summary.slice(next))]
    : [plain(summary), ...charts];
  return {
    schema: '2.0',
    header: { template: 'green', title: { tag: 'plain_text', content: '分析结论' } },
    body: { elements: [...elements, ...caveat] },
  };
}

export function trainingCard(input: TrainingInput, report: TrainingReport, withChart: boolean): Card {
  const names = trainingModelNames;
  const source = `${value(input.dataset, 100)} / ${value(input.table, 80)} · 预测「${value(input.target, 80)}」`;
  const note = plain([
    `使用 ${report.rows} 条有标签记录、${report.features} 个特征，进行 ${report.folds} 折${report.task === 'classification' ? '分层' : ''}交叉验证。`,
    report.missingLabels ? `排除了 ${report.missingLabels} 条缺少目标标签的记录。` : '',
    report.grouped ? '相同特征的记录留在同一折。' : '',
    input.excluded.length ? `跳过字段：${input.excluded.slice(0, 6).map(name => value(name, 30)).join('、')}${input.excluded.length > 6 ? '等' : ''}。` : '',
    '指标来自这份数据的交叉验证。用于未来数据前，需要另做验证并确认特征在预测时可取得。',
  ].filter(Boolean).join('\n'));
  if (report.task === 'regression') {
    const format = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 4 });
    const best = report.scores.find(score => score.model === report.selected)!;
    const baseline = report.scores.find(score => score.model === 'median')!;
    const comparison = best.mae < baseline.mae ? '低于中位数基线' : '未优于中位数基线';
    const elements = [
      plain(`${source}\n两种回归模型中，${names[best.model]}的平均绝对误差（MAE）最小，为 ${format.format(best.mae)}（目标列原单位），${comparison}。`),
      plain(report.scores.map(s => `${names[s.model]} · MAE ${format.format(s.mae)} · RMSE ${format.format(s.rmse)} · R² ${s.r2.toFixed(3)}`).join('\n')),
    ];
    return trainingEvaluation('回归模型评估', elements, note, withChart, {
      kind: 'bar', title: '各模型平均绝对误差（越低越好）', limited: false,
      points: report.scores.map(s => ({ label: names[s.model], value: s.mae })),
    });
  }
  const pct = (n: number) => `${(100 * n).toFixed(1)}%`;
  const best = report.scores.find(score => score.model === report.selected)!;
  const baseline = report.scores.find(score => score.model === 'majority')!;
  const difference = (best.macroF1 - baseline.macroF1) * 100;
  const validation = difference > 0 ? `比多数类基线高 ${difference.toFixed(1)} 个百分点` : '未超过多数类基线';
  const groups = report.confusion.map((row, i) => ({
    label: value(report.labels[i], 40),
    total: row.reduce((sum, count) => sum + count, 0),
    errors: row.reduce((sum, count, j) => sum + (i === j ? 0 : count), 0),
  }));
  const elements = [
    plain(`${source}\n${names[report.selected]}的宏平均 F1 为 ${pct(best.macroF1)}，${validation}。`),
    plain(report.scores.map(s => `${names[s.model]} · 宏平均 F1 ${pct(s.macroF1)} · 平衡准确率 ${pct(s.balancedAccuracy)} · 准确率 ${pct(s.accuracy)}`).join('\n')),
    plain(`验证误判（${names[report.selected]}）\n${groups.map(group => `${group.label}：${group.errors} / ${group.total} 条`).join('\n')}`),
  ];
  return trainingEvaluation('分类模型评估', elements, note, withChart, {
    kind: 'bar', title: '按真实类别分组的误判条数', limited: false,
    points: groups.map((group, i) => ({ label: `${i + 1}. ${group.label}`, value: group.errors })),
  });
}

function trainingEvaluation(title: string, elements: ReturnType<typeof plain>[], note: ReturnType<typeof plain>, withChart: boolean, chart: Parameters<typeof chartElements>[0]): Card {
  if (!withChart) return card(title, [...elements, note], 'green');
  return {
    schema: '2.0',
    header: { template: 'green', title: { tag: 'plain_text', content: title } },
    body: { elements: [...elements, ...chartElements(chart), note] },
  };
}

/** Quote CSV cells and neutralize spreadsheet formula interpretation in exported strings. */
export function resultCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const keys = columns?.length ? columns : [...new Set(rows.flatMap(row => Object.keys(row)))];
  const cell = (value: unknown): string => {
    let text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    if (typeof value === 'string' && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return '\uFEFF' + [keys.map(cell).join(','), ...rows.map(row => keys.map(key => cell(row[key])).join(','))].join('\r\n');
}
