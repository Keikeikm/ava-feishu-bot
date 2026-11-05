import type { AnalysisOutput, DatasetInfo } from './types.js';
import { SUPPORTED_FILES } from './sources.js';

export type Card = ReturnType<typeof card>;
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
      bounded.push(plain('…内容较多，已截取显示。完整数据请查看原始表格或分析报告附件。'));
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
    plain(`先发送表格文件，再直接输入分析问题。\n支持：${SUPPORTED_FILES}\n也可发送 /导入 加上飞书多维表格链接。`),
    plain('例如：\n按地区汇总销售额，并画柱状图\n哪些产品的利润率最低？\n接着只看华东，按月份比较\n/分析 不画图 统计各地区销售额'),
    plain('/状态：当前数据概况\n/字段：查看字段与类型\n/预览：查看前几行\n/画像：查看行数和缺失值\n/建议：生成三个分析问题\n/清空：删除自己的数据和追问记录\n/帮助：查看用法'),
    plain('群聊中请 @ 机器人提问；数据按「会话 + 发送者」隔离。新文件加载成功后替换旧文件。多表 Excel 可在问题中指定工作表名。'),
  ]);
}
export function datasetCard(info: DatasetInfo): Card {
  const descriptions = info.schema.models.slice(0, 15).map(model => {
    const rows = info.profile.models.find(p => p.name === model.name)?.metrics.row_count;
    return `${value(model.name, 60)}：${rows ?? '未知'} 行，${model.columns.length} 列\n字段：${model.columns.slice(0, 10).map(c => value(c.name, 30)).join('、')}${model.columns.length > 10 ? '…' : ''}`;
  });
  return card('数据已就绪', [plain(`文件：${info.name}\n共 ${info.schema.models.length} 张表`), plain(descriptions.join('\n\n')), plain('现在可以输入问题，例如「按地区汇总销售额」。使用 /字段、/预览 或 /建议 进一步了解数据。')], 'green');
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
export function resultCard(output: AnalysisOutput, name: string): Card {
  const { result, visualization, chartWarning } = output;
  const elements = [plain(`数据：${name}\n问题：${result.query.slice(0, 1000)}`), plain(result.text || '分析完成，结果见下方数据。'), plain(`结果预览（返回 ${result.data.length} 行）\n${rowPreview(result.data)}`)];
  if (result.sql) elements.push(plain(`计算 SQL\n${result.sql.slice(0, 1600)}${result.sql.length > 1600 ? '\n…完整 SQL 见报告附件' : ''}`));
  if (result.truncated) elements.push(plain('结果达到行数或字节上限，展示和导出均为受限结果。需要完整明细时请缩小筛选范围。'));
  if (chartWarning) elements.push(plain(chartWarning));
  elements.push(plain(`将附上分析报告 JSON${result.data.length ? '和结果 CSV' : ''}${visualization ? '，以及可在浏览器打开的图表 HTML' : ''}。`));
  return card('AVA 分析结果', elements, 'green');
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
