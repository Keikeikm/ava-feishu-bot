import { extname } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DataSourceConfig } from '@antv/ava';
import type { DatasetSource } from './types.js';
import { UserError } from './errors.js';

export const SUPPORTED_FILES = 'CSV / TSV / JSON / JSONL / NDJSON / XLSX / Parquet / TXT / Markdown / SQLite';
export const dataExtensions = ['.csv', '.tsv', '.json', '.jsonl', '.ndjson', '.xlsx', '.parquet', '.txt', '.md', '.sqlite', '.sqlite3', '.db'];
const extensions = new Set(dataExtensions);
const feishuHost = /^(?:[a-z0-9-]+\.)?feishu\.cn$/i;
const bitablePath = /^\/(?:base|wiki|share\/base)\//;

export function fileExtension(name: string, allowZip = false): string {
  const ext = extname(name).toLowerCase();
  if (allowZip && ext === '.zip') return ext;
  if (ext === '.xls') throw new UserError('AVA 的 Excel 接口支持 .xlsx，请先将旧版 .xls 另存为 .xlsx 或 CSV。');
  if (!extensions.has(ext)) throw new UserError(`不支持此文件类型。请发送：${SUPPORTED_FILES}${allowZip ? ' / ZIP' : ''}。`);
  return ext;
}

export function bitableUrl(text: string): string {
  let url: URL;
  try { url = new URL(text.trim()); } catch { throw new UserError('请提供完整的飞书多维表格链接。'); }
  const isFeishuUrl = url.protocol === 'https:' && feishuHost.test(url.hostname) && !url.port && !url.username && !url.password;
  if (isFeishuUrl && url.pathname.startsWith('/share/base/')) {
    throw new UserError('这是飞书的发布分享链接。请打开原始多维表格，复制浏览器地址栏里的 /base/ 或 /wiki/ 链接。', 'BITABLE_SHARE_LINK');
  }
  if (!isFeishuUrl || !/^\/(base|wiki)\/[a-zA-Z0-9]+\/?$/.test(url.pathname)) {
    throw new UserError('请提供 https://企业域名.feishu.cn/base/... 或 /wiki/... 多维表格链接。');
  }
  // Keep only the information consumed by AVA; discard unrelated tracking parameters.
  const table = url.searchParams.get('table');
  url.search = '';
  url.hash = '';
  if (table) {
    if (!/^tbl[a-zA-Z0-9]+$/.test(table)) throw new UserError('多维表格链接中的 table 参数无效。');
    url.searchParams.set('table', table);
  }
  return url.toString();
}

export function isBitableLink(text: string): boolean {
  const url = URL.parse(text);
  return url?.protocol === 'https:' && feishuHost.test(url.hostname) && bitablePath.test(url.pathname);
}

export function bitableRequest(text: string): { url: string; question: string } | undefined {
  const command = /^\/?导入(?:\s+|$)/.exec(text);
  const input = text.slice(command?.[0].length ?? 0);
  // Feishu links use ASCII (non-ASCII URL values are percent-encoded). Stop at
  // Chinese prose even when a plain-text link and the question touch.
  const links = [...input.matchAll(/https:\/\/[A-Za-z0-9._~:/?@!$&*+,;=%#-]+/gi)].flatMap(match => {
    const raw = match[0].replace(/[.,;:!?]+$/, '');
    return isBitableLink(raw) ? [{ url: bitableUrl(raw), start: match.index, end: match.index + raw.length }] : [];
  });
  if (new Set(links.map(link => link.url)).size > 1) throw new UserError('请在一条消息里发送一张要分析的多维表格。');
  const first = links[0];
  if (!first) {
    if (command || /^https:\/\//i.test(input)) return { url: bitableUrl(input), question: '' };
    return undefined;
  }
  let question = input;
  for (const { start, end } of links.reverse()) question = question.slice(0, start) + ' ' + question.slice(end);
  question = question.replace(/^[\s，,：:；;。]+|[\s，,：:；;。]+$/g, '');
  return { url: first.url, question };
}

export async function avaSource(source: DatasetSource): Promise<DataSourceConfig> {
  if (source.kind === 'bitable') {
    return { type: 'feishu-bitable', options: { url: bitableUrl(source.url), appId: source.appId, appSecret: source.appSecret } };
  }
  const ext = fileExtension(source.name);
  switch (ext) {
    case '.csv': return { type: 'csv-file', options: {
      path: source.path, options: { header: true, all_varchar: source.prediction?.task === 'classification' || undefined },
    } };
    case '.tsv': return { type: 'csv-file', options: { path: source.path, options: { header: true, delim: '\t' } } };
    case '.json': return { type: 'json-file', options: { path: source.path } };
    case '.jsonl': case '.ndjson': return { type: 'json-file', options: { path: source.path, options: { format: 'newline_delimited' } } };
    case '.xlsx': return { type: 'excel', options: { path: source.path } };
    case '.parquet': return { type: 'parquet', options: { path: source.path } };
    case '.db': case '.sqlite': case '.sqlite3': return { type: 'sqlite', options: { path: source.path } };
    default: {
      const bytes = await readFile(source.path);
      if (bytes.length > 256 * 1024) throw new UserError('文本抽取最多支持 256 KB，请拆分文本，或改用 CSV / JSON 文件。');
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new UserError('文本文件需要 UTF-8 编码，请转换编码后重新发送。'); }
      return { type: 'text', options: { text } };
    }
  }
}
