import type { AnalysisResponse } from '@antv/ava';

export interface InlineChart {
  kind: 'line' | 'bar' | 'column' | 'pie';
  title: string;
  points: { label: string; value: number }[];
  limited: boolean;
}

const chartKinds = new Set<string>(['line', 'bar', 'column', 'pie']);
const comparisonQuery = /\b(?:GROUP\s+BY|PIVOT|COUNT|SUM|AVG|MEDIAN|MIN|MAX|QUANTILE_CONT)\b/i;
const timeField = /日期|月份|季度|时间|年月|年份|^(?:年|月|周|日)$|(?:^|_)(?:date|time|month|quarter|year|week|period)(?:_|$)/i;
const dateLabel = /^\d{4}(?:[-/年]\d{1,2}(?:[-/]\d{1,2}|月)?|[- ]?Q[1-4])$/i;
const nonMetric = /编号|序号|排名|名次|(?:^|_)(?:id|rank|code)(?:_|$)/i;
const comparison = /占比|构成|份额|饼图|环形图|比例|分布|share|composition|pie/i;
const metricName = (s: string) => s.toLowerCase().replace(/合计|总计|汇总|总|统计|[\s_]/g, '');
const order = new Intl.Collator('zh-CN', { numeric: true });

function label(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') return '';
  return String(value).replace(/[\s\u0000-\u001f]+/g, ' ').trim().slice(0, maxLength);
}
function number(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER ? value : null;
  if (typeof value !== 'string' && typeof value !== 'bigint') return null;
  if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(String(value).trim())) return null;
  return number(Number(value));
}

function finish(kind: InlineChart['kind'], title: string, points: InlineChart['points'], truncated: boolean): InlineChart | null {
  if (points.length < 2 || new Set(points.map(p => p.label)).size !== points.length) return null;
  if (kind === 'pie' && (truncated || points.length > 8 || points.some(p => p.value < 0) || points.every(p => p.value === 0))) kind = 'bar';
  const limit = kind === 'line' ? 36 : 12;
  const limited = truncated || points.length > limit;
  if (kind === 'line') {
    points.sort((a, b) => order.compare(a.label, b.label));
    return { kind, title, points: points.slice(-limit), limited };
  }
  return { kind, title, points: points.slice(0, limit), limited };
}

/** Plot values computed by AVA. The model can name chart series, but never supplies a separate chart dataset. */
export function inlineCharts(result: AnalysisResponse): InlineChart[] {
  const rows = result.data;
  if (rows.length < 2) return [];
  const keys = result.schema.length ? result.schema.map(c => c.name) : Object.keys(rows[0]!);
  if (['chart_kind', 'chart_title', 'chart_label', 'chart_value'].every(k => keys.includes(k))) {
    const groups = new Map<string, { kind: InlineChart['kind']; points: InlineChart['points']; valid: boolean }>();
    for (const row of rows) {
      const title = label(row.chart_title, 64);
      const kind = row.chart_kind as InlineChart['kind'];
      if (!title || !chartKinds.has(kind)) continue; // Rows used as evidence can leave the chart fields empty.
      if (!groups.has(title)) groups.set(title, { kind, points: [], valid: true });
      const group = groups.get(title)!;
      const item = label(row.chart_label, 48);
      const value = number(row.chart_value);
      if (!item || value === null || group.kind !== kind) group.valid = false;
      else group.points.push({ label: item, value });
    }
    return [...groups].flatMap(([title, group]) => {
      const chart = group.valid && finish(group.kind, title, group.points, !!result.truncated);
      return chart ? [chart] : [];
    }).slice(0, 2);
  }

  // A simple grouped query may return ordinary category/metric columns without chart metadata.
  // Reject raw detail and repeated categories rather than mixing different groups or guessing totals.
  if (!comparisonQuery.test(result.sql || '')) return [];
  const axis = keys.filter(k => !nonMetric.test(k))
    .filter(k => rows.every(r => label(r[k], 48)) && new Set(rows.map(r => label(r[k], 48))).size === rows.length)
    .filter(k => timeField.test(k) || rows.every(r => typeof r[k] === 'string' && number(r[k]) === null))
    .sort((a, b) => Number(result.query.includes(b)) - Number(result.query.includes(a)))[0];
  if (!axis) return [];
  const intent = metricName(result.query);
  const metricScore = (key: string) => {
    const name = metricName(key);
    return (name.length > 1 && intent.includes(name) ? 4 : 0) +
      (comparison.test(result.query) === comparison.test(key) ? 1 : 0);
  };
  const metric = keys.filter(k => k !== axis && !timeField.test(k) && !nonMetric.test(k) && rows.every(r => number(r[k]) !== null))
    .sort((a, b) => metricScore(b) - metricScore(a))[0];
  if (!metric) return [];
  const points = rows.map(r => ({ label: label(r[axis], 48), value: number(r[metric])! }));
  const temporal = timeField.test(axis) || points.every(p => dateLabel.test(p.label));
  const kind = /饼图|环形图/.test(result.query) ? 'pie' : /柱状图/.test(result.query) ? 'column' : /条形图/.test(result.query) ? 'bar' : temporal ? 'line' : 'bar';
  const chart = finish(kind, `${metric} · 按${axis}`.slice(0, 64), points, !!result.truncated);
  return chart ? [chart] : [];
}

export function feishuChart(chart: InlineChart) {
  const title = { text: chart.limited ? `${chart.title}（部分结果）` : chart.title };
  const data = { values: chart.points };
  const chart_spec = chart.kind === 'pie'
    ? { type: 'pie', title, data, categoryField: 'label', valueField: 'value', legends: { visible: true } }
    : chart.kind === 'bar'
      ? { type: 'bar', title, data, direction: 'horizontal', xField: 'value', yField: 'label' }
      : { type: chart.kind === 'line' ? 'line' : 'bar', title, data, xField: 'label', yField: 'value' };
  return { tag: 'chart' as const, aspect_ratio: '16:9', preview: true, chart_spec };
}

/** Keep a useful, strictly numerical answer if AVA computed results but the model failed to summarize. */
export function chartConclusion(chart?: InlineChart): string {
  if (!chart) return '本次已完成计算，但未能生成可靠的文字解读。可以重试当前问题，或指定一个指标继续分析。';
  const format = new Intl.NumberFormat('zh-CN', { maximumSignificantDigits: 8 });
  const points = chart.kind === 'line' ? chart.points : [...chart.points].sort((a, b) => b.value - a.value);
  const a = points[0]!;
  const b = points.at(-1)!;
  const scope = chart.limited ? '可见结果中，' : '';
  const finding = chart.kind === 'line'
    ? `${scope}${chart.title}从 ${a.label} 的 ${format.format(a.value)} 变为 ${b.label} 的 ${format.format(b.value)}。`
    : a.value === b.value ? `${scope}${chart.title}各组均为 ${format.format(a.value)}。`
      : `${scope}${chart.title}最高为 ${a.label}（${format.format(a.value)}），最低为 ${b.label}（${format.format(b.value)}）。`;
  return `【结论】${finding}\n【下一步】要继续比较这些差异主要来自哪些分组吗？`;
}
