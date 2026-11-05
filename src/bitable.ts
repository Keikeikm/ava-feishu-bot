import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { join } from 'node:path';
import type { AVA, DataSourceConfig } from '@antv/ava';
import { UserError } from './errors.js';
import { bitableUrl } from './sources.js';
import type { DatasetSource } from './types.js';

type BitableSource = Extract<DatasetSource, { kind: 'bitable' }>;
const origin = 'https://open.feishu.cn/open-apis';
const identifier = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function feishu<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(origin + path, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await response.json() as { code: number; msg?: string; data?: T };
  if (body.code !== 0) throw new Error(`Feishu Error ${body.code}: ${body.msg}`);
  return (body.data ?? body) as T;
}

async function listTables(source: BitableSource, url: URL) {
  const token = await feishu<{ tenant_access_token: string }>('/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: source.appId, app_secret: source.appSecret }),
  });
  const headers = { Authorization: `Bearer ${token.tenant_access_token}` };
  const [, kind, linkToken] = url.pathname.split('/');
  let appToken = linkToken!;
  if (kind === 'wiki') {
    const { node } = await feishu<{ node: { obj_type: string; obj_token: string } }>(`/wiki/v2/spaces/get_node?token=${encodeURIComponent(appToken)}&obj_type=wiki`, { headers });
    if (node?.obj_type !== 'bitable' || !node.obj_token) {
      throw new UserError('这个知识库链接没有指向多维表格。', 'BITABLE_WIKI_TYPE', 'source');
    }
    appToken = node.obj_token;
  }

  const tables = new Map<string, string>();
  const seenPages = new Set<string>();
  let cursor = '';
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (cursor) params.set('page_token', cursor);
    const page = await feishu<{ items?: { table_id: string; name: string }[]; has_more?: boolean; page_token?: string }>(
      `/bitable/v1/apps/${encodeURIComponent(appToken)}/tables?${params}`, { headers },
    );
    for (const table of page.items ?? []) tables.set(table.table_id, table.name);
    if (!page.has_more) break;
    if (!page.page_token || seenPages.has(page.page_token)) throw new Error('Feishu tables pagination returned an invalid page token');
    cursor = page.page_token;
    seenPages.add(cursor);
  } while (cursor);
  if (!tables.size) throw new UserError('飞书没有返回机器人可读取的数据表。请核对应用对该多维表格的读取权限。', 'BITABLE_NO_TABLES', 'source');
  return { appToken, tables };
}

function sqliteType(type: string): 'INTEGER' | 'REAL' | 'TEXT' {
  if (/^(?:U?(?:TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT)|BOOLEAN)$/i.test(type)) return 'INTEGER';
  if (/^(?:FLOAT|DOUBLE|DECIMAL)/i.test(type)) return 'REAL';
  return 'TEXT';
}

function sqliteValue(value: unknown, type: ReturnType<typeof sqliteType>): SQLInputValue {
  if (value == null) return null;
  if (type === 'INTEGER') {
    if (typeof value === 'boolean') return Number(value);
    if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  }
  if (type !== 'TEXT' && typeof value === 'number') return value;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

async function copyTable(ava: AVA, db: DatabaseSync, name: string) {
  const model = (await ava.schema()).models[0];
  if (!model?.columns.length) throw new Error('Feishu Bitable has no supported fields');
  const columns = model.columns.map(column => ({ name: column.name, type: sqliteType(column.type) }));
  db.exec(`CREATE TABLE ${identifier(name)} (${columns.map(c => `${identifier(c.name)} ${c.type}`).join(', ')})`);
  const insert = db.prepare(`INSERT INTO ${identifier(name)} VALUES (${columns.map(() => '?').join(', ')})`);
  const pageSize = 1000;
  for (let offset = 0; ; ) {
    // The upstream loader holds an immutable snapshot. Read it in bounded pages.
    const page = await ava.query(`SELECT * FROM data LIMIT ${pageSize} OFFSET ${offset}`, { maxRows: pageSize, maxResultBytes: 4 * 1024 * 1024 });
    for (const row of page.data) insert.run(...columns.map(c => sqliteValue(row[c.name], c.type)));
    if (!page.truncated && page.data.length < pageSize) break;
    if (!page.data.length) throw new UserError('多维表格中有单行数据过大，无法完整导入。', 'BITABLE_ROW_TOO_LARGE', 'source');
    offset += page.data.length;
  }
}

/** Compose the Base from AVA's native single-table loader and its existing SQLite source. */
export async function loadBitable(ava: AVA, source: BitableSource, directory?: string): Promise<number> {
  const url = new URL(bitableUrl(source.url));
  const credentials = { appId: source.appId, appSecret: source.appSecret };
  if (url.searchParams.has('table')) {
    await ava.source({ type: 'feishu-bitable', options: { ...credentials, url: url.toString() } });
    return 1;
  }

  const { appToken, tables } = await listTables(source, url);
  const tableSource = (tableId: string): DataSourceConfig => ({ type: 'feishu-bitable', options: { ...credentials, appToken, tableId } });
  if (tables.size === 1) {
    await ava.source(tableSource(tables.keys().next().value!));
    return 1;
  }

  if (!directory) throw new Error('A session directory is required to load multiple Bitable tables');
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(directory, 'bitable.sqlite');
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');
    const names = new Set<string>();
    for (const [id, title] of tables) {
      const candidate = title.trim().replaceAll('\0', '') || id;
      const base = /^sqlite_/i.test(candidate) ? `表_${candidate}` : candidate;
      let name = base;
      for (let suffix = 2; names.has(name.toLowerCase()); suffix++) name = `${base} (${suffix})`;
      names.add(name.toLowerCase());
      await ava.source(tableSource(id));
      await copyTable(ava, db, name);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  await ava.source({ type: 'sqlite', options: { path } });
  return tables.size;
}
