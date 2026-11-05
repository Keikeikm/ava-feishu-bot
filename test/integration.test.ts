import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { copyFile, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AVA } from '@antv/ava';
import { Bot } from '../src/bot.js';
import { EngineClient } from '../src/engine.js';
import { Sessions } from '../src/sessions.js';
import { loadConfig } from '../src/config.js';
import { avaSource } from '../src/sources.js';
import type { Messenger } from '../src/feishu.js';
import type { AnalysisOutput, DatasetInfo, MessageEvent } from '../src/types.js';

const grouped = 'SELECT "地区", SUM("销售额") AS "总销售额" FROM data GROUP BY "地区" ORDER BY "总销售额" DESC';
function event(id: string, text: string, user = 'ou_user'): MessageEvent {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: { message_id: id, chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } };
}

test('真实 AVA + 受控模型接口：文件上传、SQL计算、追问、图表、去重及不同用户隔离', { timeout: 60_000 }, async () => {
  const prompts: string[] = [];
  let breakChart = false;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body) as { messages: { content: string }[] };
    assert.equal(req.url, '/v1/chat/completions');
    const prompt = request.messages.map(m => m.content).join('\n');
    prompts.push(prompt);
    let content: string;
    if (prompt.includes('Generate ONLY the SQL')) {
      content = /当前问题：只看华东/.test(prompt) ? 'SELECT SUM("销售额") AS "总销售额" FROM data WHERE "地区" = \'华东\'' : grouped;
    } else if (prompt.includes('queryExplanation')) {
      content = JSON.stringify({ queryExplanation: '按地区求和', conclusion: '华东销售额为 45000。' });
    } else if (prompt.includes('图表推荐专家')) content = 'column';
    else if (prompt.includes('GPT-Vis 可视化专家')) {
      content = breakChart ? 'invalid JSON' : JSON.stringify({ type: 'column', data: [{ category: '华东', value: 45000 }, { category: '华南', value: 20000 }, { category: '华北', value: 11000 }] });
    } else content = '[]';
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: 'test', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 20, completion_tokens: 20, total_tokens: 40 } }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const config = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', LLM_API_KEY: 'test', LLM_MODEL: 'test', LLM_BASE_URL: `http://127.0.0.1:${port}/v1`, ENABLE_CHARTS: 'true' });
  const runtime = await mkdtemp(join(tmpdir(), 'ava-e2e-'));
  const sessions = new Sessions(config);
  const sent: { id: string; kind: string; data: unknown }[] = [];
  const messenger: Messenger = {
    text: async (m, text) => { sent.push({ id: m.id, kind: 'text', data: text }); },
    card: async (m, card) => { sent.push({ id: m.id, kind: 'card', data: card }); },
    file: async (m, name, data) => { sent.push({ id: m.id, kind: name, data: data.toString('utf8') }); },
    download: async (_m, destination) => { await copyFile(resolve('examples/sales.csv'), destination); },
  };
  const bot = new Bot(config, runtime, messenger, sessions);
  try {
    bot.accept(event('hello', '你好'));
    const upload = event('upload', '');
    upload.message.message_type = 'file';
    upload.message.content = JSON.stringify({ file_key: 'file_test', file_name: 'sales.csv' });
    bot.accept(upload);
    const question = event('question', '按地区汇总销售额并画柱状图');
    bot.accept(question); bot.accept(question);
    bot.accept(event('followup', '只看华东'));
    bot.accept(event('other-user', '汇总销售额', 'ou_user2'));
    const mixed = event('mixed', '');
    mixed.message.message_type = 'post';
    mixed.message.content = JSON.stringify({ content: [[{ tag: 'text', text: '按地区汇总销售额并画柱状图' }]], files: [{ file_key: 'file_mixed', file_name: 'sales.csv' }] });
    bot.accept(mixed);
    await bot.close();
    assert.ok(sent.some(s => s.id === 'hello' && s.kind === 'card'));
    assert.ok(!sent.some(s => s.id === 'hello' && typeof s.data === 'string' && s.data.includes('错误编号')));
    const report = sent.find(s => s.id === 'question' && s.kind === 'analysis-report.json');
    assert.ok(report, JSON.stringify(sent));
    const parsed = JSON.parse(report.data as string);
    assert.deepEqual(parsed.data, [{ 地区: '华东', 总销售额: 45000 }, { 地区: '华南', 总销售额: 20000 }, { 地区: '华北', 总销售额: 11000 }]);
    assert.equal(parsed.sql, grouped);
    assert.equal(sent.filter(s => s.id === 'question' && s.kind === 'analysis-report.json').length, 1);
    const csv = sent.find(s => s.id === 'question' && s.kind === 'analysis-result.csv');
    assert.match(csv?.data as string, /45000/);
    const chart = sent.find(s => s.id === 'question' && s.kind === 'analysis-chart.html');
    assert.match(chart?.data as string, /GPTVis/);
    const followup = JSON.parse(sent.find(s => s.id === 'followup' && s.kind === 'analysis-report.json')!.data as string);
    assert.deepEqual(followup.data, [{ 总销售额: 45000 }]);
    assert.ok(prompts.some(p => p.includes('历史问题与查询')));
    assert.ok(sent.some(s => s.id === 'other-user' && typeof s.data === 'string' && s.data.includes('请先发送表格')));
    const mixedReport = sent.find(s => s.id === 'mixed' && s.kind === 'analysis-report.json');
    assert.ok(mixedReport, JSON.stringify(sent));
    assert.equal(JSON.parse(mixedReport.data as string).data[0].总销售额, 45000);

    // A visualization error must not discard a completed analysis.
    const engine = new EngineClient({ kind: 'file', path: resolve('examples/sales.csv'), name: 'sales.csv' }, config);
    try {
      await engine.request('load'); breakChart = true;
      const output = await engine.analyze('按地区汇总并画图', true);
      assert.equal(output.result.data[0]?.总销售额, 45000);
      assert.equal(output.visualization, null);
      assert.ok(output.chartWarning);
    } finally { await engine.close(); }
  } finally {
    await sessions.close();
    await rm(runtime, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('真实 AVA 读取 CSV/TSV/JSON/JSONL，数值精确，拒绝写操作及额外文件读取', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ava-loaders-'));
  const ava = new AVA({ llm: { model: 'unused', apiKey: 'unused' } });
  try {
    const fixtures = [
      ['sales.csv', 'region,amount\neast,10\nwest,20'],
      ['sales.tsv', 'region\tamount\neast\t10\nwest\t20'],
      ['sales.json', JSON.stringify([{ region: 'east', amount: 10 }, { region: 'west', amount: 20 }])],
      ['sales.jsonl', '{"region":"east","amount":10}\n{"region":"west","amount":20}\n'],
    ];
    for (const [name, content] of fixtures) {
      const path = join(directory, name!);
      await writeFile(path, content!);
      await ava.source(await avaSource({ kind: 'file', name: name!, path }));
      assert.deepEqual((await ava.query('SELECT SUM(amount) AS total FROM data')).data, [{ total: 30 }], name);
    }
    const outside = await mkdtemp(join(tmpdir(), 'ava-private-'));
    try {
      await writeFile(join(outside, 'secret.csv'), 'secret\n123');
      await assert.rejects(ava.query(`SELECT * FROM read_csv('${join(outside, 'secret.csv')}')`));
      await assert.rejects(ava.query('DROP VIEW data'));
      await assert.rejects(ava.query('SELECT 1; SELECT 2'));
    } finally { await rm(outside, { recursive: true, force: true }); }
  } finally { await ava.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test('新文件导入失败保留旧会话，替换成功后删除旧文件；超时终止 worker', { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ava-sessions-'));
  const config = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', LLM_MODEL: 'test', LLM_API_KEY: 'test' });
  const sessions = new Sessions(config);
  try {
    const firstDir = await mkdtemp(join(directory, 'one-'));
    const firstPath = join(firstDir, 'input.csv');
    await copyFile(resolve('examples/sales.csv'), firstPath);
    await sessions.replace('owner', { kind: 'file', name: 'first.csv', path: firstPath }, firstDir);
    const badDir = await mkdtemp(join(directory, 'bad-'));
    await writeFile(join(badDir, 'input.json'), 'not json');
    await assert.rejects(sessions.replace('owner', { kind: 'file', name: 'bad.json', path: join(badDir, 'input.json') }, badDir));
    assert.equal((await sessions.info('owner')).name, 'first.csv');
    await access(firstPath);
    const nextDir = await mkdtemp(join(directory, 'two-'));
    await copyFile(firstPath, join(nextDir, 'input.csv'));
    await sessions.replace('owner', { kind: 'file', name: 'next.csv', path: join(nextDir, 'input.csv') }, nextDir);
    await assert.rejects(access(firstPath));
    const engine = new EngineClient({ kind: 'file', name: 'sales.csv', path: resolve('examples/sales.csv') }, config);
    try {
      await assert.rejects(engine.request('load', {}, 1), /超过处理时限/);
      assert.equal(engine.closed, true);
      await assert.rejects(engine.request('info'), /释放/);
    } finally { await engine.close(); }
  } finally { await sessions.close(); await rm(directory, { recursive: true, force: true }); }
});
