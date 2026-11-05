import type { AnalysisOutput, DatasetInfo } from './types.js';
import { SUPPORTED_FILES } from './sources.js';
import { feishuChart } from './charts.js';

export type Card = ReturnType<typeof card> | { schema: '2.0'; header: ReturnType<typeof card>['header']; body: { elements: (ReturnType<typeof plain> | ReturnType<typeof feishuChart>)[] } };
const plain = (text: string) => ({ tag: 'div', text: { tag: 'plain_text', content: text.slice(0, 4000) } });
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
    plain(`发送表格和分析要求，我会给出结论、依据和相关图表。也可以只上传表格，再选择分析方向。\n支持：${SUPPORTED_FILES}\n也可发送 /导入 加上飞书多维表格链接。`),
    plain('例如：\n分析一下，看看哪些变化值得关注\n按地区汇总销售额，并画柱状图\n接着只看华东，按月份比较\n/分析 不画图 统计各地区销售额'),
    plain('/建议：看看接下来可以分析什么\n/状态：查看当前使用的文件\n/清空：删除自己的数据和追问记录'),
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
  const charts = output.charts?.map(feishuChart) || [];
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
