import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { once } from 'node:events';
import * as lark from '@larksuiteoapi/node-sdk';
import { AVA } from '@antv/ava';
import { createFeishu } from '../src/feishu.js';
import { loadConfig } from '../src/config.js';
import { helpCard } from '../src/cards.js';
import type { IncomingMessage } from '../src/types.js';
import { EngineClient } from '../src/engine.js';
import type { DatasetInfo } from '../src/types.js';
import { bitableReadError, publicFailure } from '../src/errors.js';
import { avaSource } from '../src/sources.js';
import { loadBitable } from '../src/bitable.js';

test('AVA 读飞书多维表格：区分 API 权限和文档权限，授权后读出记录', async t => {
  let deniedCode = 99991672;
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const { pathname } = new URL(input);
    if (pathname.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fake-token' });
    if (pathname.endsWith('/apps/bascnFixture/tables')) {
      if (deniedCode === 99991672) return Response.json({ code: deniedCode, msg: 'Access denied. One of the following scopes is required: [bitable:app:readonly]' }, { status: 400 });
      return Response.json({ code: 0, data: { items: [{ table_id: 'tblFixture', name: '示例表' }] } });
    }
    if (pathname.endsWith('/tables/tblFixture/fields')) {
      if (deniedCode) return Response.json({ code: deniedCode, msg: 'Permission denied' }, { status: 403 });
      return Response.json({ code: 0, data: { items: [{ field_name: '类别', type: 3 }, { field_name: '金额', type: 2 }] } });
    }
    assert.ok(pathname.endsWith('/tables/tblFixture/records'));
    return Response.json({ code: 0, data: { items: [{ fields: { 类别: '茶', 金额: 8 } }, { fields: { 类别: '茶', 金额: 12 } }] } });
  });
  const ava = new AVA({ engine: { type: 'duckdb' }, llm: { model: 'test', apiKey: 'fake-key' } });
  const source = await avaSource({ kind: 'bitable', name: '示例表', url: 'https://demo.feishu.cn/base/bascnFixture', appId: 'fake-id', appSecret: 'fake-secret' });
  const load = () => ava.source(source).catch(error => { throw bitableReadError(error); });
  try {
    await assert.rejects(load, { code: 'BITABLE_API_SCOPE', diagnostic: { errorType: 'Error', feishuCode: 99991672 } });
    deniedCode = 91403;
    await assert.rejects(load, { code: 'BITABLE_ACCESS_DENIED', diagnostic: { errorType: 'Error', feishuCode: 91403 } });
    deniedCode = 0;
    await load();
    const result = await ava.query('SELECT "类别", SUM("金额") AS "合计" FROM data GROUP BY "类别"');
    assert.deepEqual(result.data, [{ 类别: '茶', 合计: 20 }]);
  } finally {
    await ava.dispose();
  }
});

test('整份飞书 Base 枚举所有子表，复用 AVA 读取并支持跨表聚合', async t => {
  const readTables: string[] = [];
  const success = (data: object) => Response.json({ code: 0, data });
  t.mock.method(globalThis, 'fetch', async (input: string) => {
    const { pathname, searchParams } = new URL(input);
    if (pathname.endsWith('/tenant_access_token/internal')) return Response.json({ code: 0, tenant_access_token: 'fake-token' });
    if (pathname.endsWith('/spaces/get_node')) return success({ node: { obj_type: 'bitable', obj_token: 'bascnFixture' } });
    if (pathname.endsWith('/apps/bascnFixture/tables')) {
      return searchParams.get('page_token') === 'next'
        ? success({ items: [{ table_id: 'tblProducts', name: '产品' }] })
        : success({ items: [{ table_id: 'tblOrders', name: '订单' }], has_more: true, page_token: 'next' });
    }
    const [, tableId, resource] = /\/tables\/(tblOrders|tblProducts)\/(fields|records)$/.exec(pathname) ?? [];
    assert.ok(tableId && resource, pathname);
    if (resource === 'fields') return success({ items: [
      { field_name: '产品编号', type: 1 }, tableId === 'tblOrders' ? { field_name: '金额', type: 2 } : { field_name: '类别', type: 3 },
    ] });
    readTables.push(tableId);
    return success({ items: tableId === 'tblOrders'
      ? [{ fields: { 产品编号: '001', 金额: 8.5 } }, { fields: { 产品编号: '002', 金额: 30 } }]
      : [{ fields: { 产品编号: '001', 类别: '茶' } }, { fields: { 产品编号: '002', 类别: '咖啡' } }] });
  });
  const directory = await mkdtemp(join(tmpdir(), 'ava-bitable-base-'));
  const ava = new AVA({ engine: { type: 'duckdb' }, llm: { model: 'test' } });
  const source = { kind: 'bitable' as const, name: '示例 Base', url: 'https://demo.feishu.cn/wiki/Example', appId: 'fake-id', appSecret: 'fake-secret' };
  try {
    assert.equal(await loadBitable(ava, source, directory), 2);
    assert.deepEqual(readTables, ['tblOrders', 'tblProducts']);
    assert.deepEqual((await ava.schema()).models.map(m => m.name).sort(), ['产品', '订单']);
    const result = await ava.query('SELECT p."类别", SUM(o."金额") AS "合计" FROM "订单" o JOIN "产品" p USING ("产品编号") GROUP BY 1 ORDER BY 2');
    assert.deepEqual(result.data, [{ 类别: '茶', 合计: 8.5 }, { 类别: '咖啡', 合计: 30 }]);
    assert.equal(await loadBitable(ava, { ...source, url: 'https://demo.feishu.cn/base/bascnFixture?table=tblOrders' }), 1);
    assert.deepEqual((await ava.schema()).models.map(m => m.name), ['data']);
    assert.deepEqual(readTables, ['tblOrders', 'tblProducts', 'tblOrders']);
  } finally {
    await ava.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test('飞书真实 SDK 合约：消息资源流下载、multipart 文件上传和卡片回复', async () => {
  const config = loadConfig({ FEISHU_APP_ID: 'contract-test-app', FEISHU_APP_SECRET: 'fake-secret', LLM_MODEL: 'test', LLM_API_KEY: 'fake-key' });
  const requests: lark.HttpRequestOptions<unknown>[] = [];
  const transport = new Proxy({} as lark.HttpInstance, {
    get(_target, method) {
      if (method === 'post') return async (url: string) => {
        assert.ok(url.endsWith('/auth/v3/tenant_access_token/internal'));
        return { code: 0, tenant_access_token: 'fake-token', expire: 7200 };
      };
      if (method === 'request') return async (options: lark.HttpRequestOptions<unknown>) => {
        requests.push(options);
        if (options.url?.includes('/resources/')) return { headers: { 'content-length': '7' }, data: Readable.from(['a,b\n1,2']) };
        if (options.url?.endsWith('/files')) return { code: 0, data: { file_key: 'file_uploaded' } };
        assert.ok(options.url?.endsWith('/messages/om_input/reply'));
        return { code: 0, data: { message_id: 'om_reply' } };
      };
      throw new Error(`Unexpected HTTP method ${String(method)}`);
    },
  });
  const { messenger, ws } = createFeishu(config, transport);
  const directory = await mkdtemp(join(tmpdir(), 'feishu-contract-'));
  const message: IncomingMessage = { id: 'om_input', chatId: 'oc_chat', userId: 'ou_user', sessionKey: 'test', file: { key: 'file_input', name: 'data.csv' } };
  try {
    await messenger.download(message, join(directory, 'input.csv'));
    assert.equal(await readFile(join(directory, 'input.csv'), 'utf8'), 'a,b\n1,2');
    await messenger.card(message, helpCard());
    await messenger.file(message, 'report.json', Buffer.from('{"total":30}'));
    const download = requests.find(r => r.url?.includes('/resources/'))!;
    assert.equal(download.params?.type, 'file');
    assert.equal(download.responseType, 'stream');
    assert.equal(download.headers?.Authorization, 'Bearer fake-token');
    const upload = requests.find(r => r.url?.endsWith('/files'))!;
    assert.equal(upload.headers?.['Content-Type'], 'multipart/form-data');
    const filePayload = upload.data as { file: Buffer; file_name: string };
    assert.equal(filePayload.file.toString('utf8'), '{"total":30}');
    const replies = requests.filter(r => r.url?.endsWith('/reply')).map(r => r.data as { msg_type: string; content: string });
    assert.equal(replies[0]?.msg_type, 'interactive');
    assert.equal(replies[1]?.msg_type, 'file');
    assert.equal(JSON.parse(replies[1]!.content).file_key, 'file_uploaded');
  } finally { ws.close({ force: true }); await rm(directory, { recursive: true, force: true }); }
});

test('真实 HTTP + SDK 下载 CSV 后，真实 AVA 可读取八行；权限错误不会被当成 CSV', { timeout: 30_000 }, async () => {
  const csv = await readFile('examples/sales.csv');
  let denied: 'http' | 'envelope' | undefined;
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* consume the small token request */ }
    if (req.url?.endsWith('/tenant_access_token/internal')) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 0, tenant_access_token: 'wire-test-token', expire: 7200 }));
    } else if (denied) {
      res.statusCode = denied === 'http' ? 400 : 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ code: 99991672, msg: 'permission denied, secret should not be exposed', error: { permission_violations: [
        { subject: 'im:message.history:readonly', type: 'action_scope_required' },
        { subject: 'im:message:readonly', type: 'action_scope_required' },
        { subject: 'im:message', type: 'action_scope_required' },
      ] } }));
    } else {
      res.setHeader('content-type', 'text/csv');
      res.setHeader('content-disposition', 'attachment;filename=sales.csv');
      res.setHeader('content-length', String(csv.length));
      res.end(csv);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const url = (original: string) => base + new URL(original).pathname;
  const transport = new Proxy(lark.defaultHttpInstance, {
    get(target, method) {
      if (method === 'post') return (original: string, data: unknown) => target.post(url(original), data, { proxy: false });
      if (method === 'request') return (options: lark.HttpRequestOptions<unknown>) => target.request({ ...options, url: url(options.url!), proxy: false });
      const value = Reflect.get(target, method);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as lark.HttpInstance;
  const config = loadConfig({ FEISHU_APP_ID: 'wire-contract-test', FEISHU_APP_SECRET: 'fake-secret', LLM_MODEL: 'unused', LLM_API_KEY: 'unused' });
  const { messenger, ws } = createFeishu(config, transport);
  const directory = await mkdtemp(join(tmpdir(), 'feishu-wire-'));
  let engine: EngineClient | undefined;
  try {
    const message: IncomingMessage = { id: 'om_input', chatId: 'oc_chat', userId: 'ou_user', sessionKey: 'test', file: { key: 'file_input', name: 'sales.csv' } };
    const file = join(directory, 'input.csv');
    await messenger.download(message, file);
    assert.deepEqual(await readFile(file), csv);
    engine = new EngineClient({ kind: 'file', name: 'sales.csv', path: file }, config);
    const info = await engine.request<DatasetInfo>('load');
    assert.equal(info.profile.models[0]?.metrics.row_count, 8);
    for (const mode of ['http', 'envelope'] as const) {
      denied = mode;
      await assert.rejects(messenger.download(message, join(directory, `denied-${mode}.csv`)), error => {
        const failure = publicFailure(error);
        assert.equal(failure.code, 'FEISHU_DOWNLOAD_PERMISSION');
        assert.equal(failure.stage, 'download');
        assert.ok(failure.message.includes('im:message:readonly'));
        assert.deepEqual(failure.diagnostic?.requiredScopes, ['im:message.history:readonly', 'im:message:readonly', 'im:message']);
        assert.ok(!failure.message.includes('secret'));
        return true;
      });
    }
  } finally {
    await engine?.close(); ws.close({ force: true });
    await rm(directory, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
