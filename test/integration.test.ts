import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
import type { AnalysisOutput, DatasetInfo, DatasetSource, MessageEvent } from '../src/types.js';

async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 20000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Timed out waiting for reply'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

const grouped = 'SELECT "地区", SUM("销售额") AS "总销售额" FROM data GROUP BY "地区" ORDER BY "总销售额" DESC';
const overview = `
  SELECT 'line' AS chart_kind, '月度销售额' AS chart_title, "月份" AS chart_label, SUM("销售额") AS chart_value
  FROM data GROUP BY "月份"
  UNION ALL
  SELECT 'bar', '各地区利润率（%）', "地区", 100.0 * SUM("利润") / SUM("销售额")
  FROM data GROUP BY "地区"
  ORDER BY chart_title, chart_label DESC`;
function event(id: string, text: string, user = 'ou_user'): MessageEvent {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: { message_id: id, chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } };
}

test('飞书训练指令读取当前 AVA 数据并生成评估卡，拦截泰坦尼克号示例标签', { timeout: 60_000 }, async t => {
  const python = process.env.ML_PYTHON || (existsSync('.venv/bin/python') ? resolve('.venv/bin/python') : 'python3');
  if (spawnSync(python, ['-c', "import importlib.util; raise SystemExit(importlib.util.find_spec('sklearn') is None)"], { stdio: 'ignore' }).status !== 0) {
    t.skip('需要安装 ml/requirements.txt');
    return;
  }
  const config = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', LLM_API_KEY: 'test', LLM_MODEL: 'test', ML_PYTHON: python });
  const logs: { event: string; request_id: string; input_text?: string; target?: string; runtime?: string; scores?: unknown[] }[] = [];
  t.mock.method(console, 'info', (entry: string) => {
    if (typeof entry === 'string' && entry.startsWith('{')) logs.push(JSON.parse(entry));
  });
  const runtime = await mkdtemp(join(tmpdir(), 'ava-ml-e2e-'));
  const sent: { id: string; kind: 'text' | 'card'; content: string }[] = [];
  const fixture = ['客户编号,使用量,渠道,流失'];
  for (let i = 0; i < 160; i++) {
    const usage = i % 80;
    const channel = i < 80 ? '线上' : '线下';
    const label = i % 17 === 0 ? '' : Number(usage < (channel === '线上' ? 32 : 48));
    fixture.push(`${i},${usage},${channel},${label}`);
  }
  const messenger: Messenger = {
    text: async (m, content) => { sent.push({ id: m.id, kind: 'text', content }); },
    card: async (m, content) => { sent.push({ id: m.id, kind: 'card', content: JSON.stringify(content) }); },
    file: async () => { assert.fail('训练结果应直接在卡片里显示'); },
    download: async (m, path) => {
      if (m.file?.name === 'titanic.csv') await copyFile(resolve('examples/titanic.csv'), path);
      else await writeFile(path, fixture.join('\n'));
    },
  };
  const bot = new Bot(config, runtime, messenger, new Sessions(config));
  try {
    const upload = (id: string, filename: string, question: string) => {
      const message = event(id, '');
      message.message.message_type = 'post';
      message.message.content = JSON.stringify({
        content: [[{ tag: 'text', text: question }]],
        files: [{ file_key: 'file_fixture', file_name: filename }],
      });
      bot.accept(message);
    };
    upload('train', 'customers.csv', '用这张表预测流失，试试随机森林');
    upload('unverified', 'titanic.csv', '/训练 Survived');
    await bot.close();
    const trained = sent.find(item => item.id === 'train' && item.kind === 'card');
    assert.ok(trained, JSON.stringify(sent));
    assert.match(trained.content, /随机森林.*平衡准确率/);
    assert.match(trained.content, /排除了 10 条缺少目标标签/);
    assert.match(trained.content, /跳过字段：客户编号/);
    const chart = JSON.parse(trained.content).body.elements.find((element: { tag: string }) => element.tag === 'chart');
    assert.equal(chart.chart_spec.data.values.length, 2);
    const received = logs.find(log => log.event === 'message_received' && log.input_text === '用这张表预测流失，试试随机森林');
    assert.ok(received);
    const trainingLogs = logs.filter(log => log.request_id === received.request_id);
    assert.ok(trainingLogs.some(log => log.event === 'training_started' && log.target === '流失' && log.runtime === 'local_python'));
    assert.equal(trainingLogs.find(log => log.event === 'training_finished')?.scores?.length, 3);
    assert.ok(sent.some(item => item.id === 'unverified' && item.content.includes('ML_UNVERIFIED_LABEL')));
    assert.ok(!sent.some(item => item.id === 'unverified' && item.kind === 'card'));
  } finally {
    await bot.close();
    await rm(runtime, { recursive: true, force: true });
  }
});

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
      content = /当前问题：只看华东/.test(prompt) ? 'SELECT SUM("销售额") AS "总销售额" FROM data WHERE "地区" = \'华东\''
        : /当前问题：分析一下\n/.test(prompt) && prompt.includes('chart_value') ? overview : grouped;
    } else if (prompt.includes('queryExplanation')) {
      content = /当前问题：比较地区销售额\n/.test(prompt) ? 'invalid JSON' : JSON.stringify({ queryExplanation: '按地区求和', conclusion: '华东销售额为 45000。' });
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
  const bitableImports: string[] = [];
  const sessions = new class extends Sessions {
    override async replace(key: string, source: DatasetSource, directory: string) {
      if (source.kind !== 'bitable') return super.replace(key, source, directory);
      // Substitute a local snapshot for the private Feishu API while keeping the real AVA analysis flow.
      bitableImports.push(source.url);
      const path = join(directory, 'bitable-snapshot.csv');
      await copyFile(resolve('examples/sales.csv'), path);
      return super.replace(key, { kind: 'file', path, name: '多维表格.csv' }, directory);
    }
  }(config);
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
    await waitFor(() => sent.some(s => s.id === 'upload' && s.kind === 'card'));
    const priorModelCalls = prompts.length;
    bot.accept(event('fields', '介绍一下数据字段分别是什么？'));
    await waitFor(() => sent.some(s => s.id === 'fields' && s.kind === 'card'));
    const fieldReplies = sent.filter(s => s.id === 'fields');
    assert.deepEqual(fieldReplies.map(reply => reply.kind), ['card']);
    assert.match(JSON.stringify(fieldReplies[0]?.data), /字段与数据类型.*销售额/);
    assert.equal(prompts.length, priorModelCalls);
    const question = event('question', '按地区汇总销售额并画柱状图');
    bot.accept(question); bot.accept(question);
    bot.accept(event('report1', '/导出 JSON'));
    bot.accept(event('csv1', '/导出 CSV'));
    bot.accept(event('chart1', '/导出 图表'));
    await waitFor(() => sent.some(s => s.id === 'chart1' && s.kind === 'analysis-chart.html'));
    bot.accept(event('followup', '只看华东'));
    bot.accept(event('followup-export', '/导出 JSON'));
    bot.accept(event('no-chart', '/分析 不画图 按地区汇总销售额'));
    bot.accept(event('other-user', '汇总销售额', 'ou_user2'));
    const mixed = event('mixed', '');
    mixed.message.message_type = 'post';
    mixed.message.content = JSON.stringify({ content: [[{ tag: 'text', text: '分析一下' }]], files: [{ file_key: 'file_mixed', file_name: 'sales.csv' }] });
    bot.accept(mixed);
    bot.accept(event('mixed-export', '/导出 JSON'));
    await waitFor(() => sent.some(s => s.id === 'mixed-export' && s.kind === 'analysis-report.json'));
    bot.accept(event('summary-failure', '比较地区销售额'));
    const shared = event('bitable-with-question', '', 'ou_user2');
    shared.message.message_type = 'post';
    shared.message.content = JSON.stringify({ content: [[
      { tag: 'a', text: 'Untitled', href: 'https://demo.feishu.cn/base/ABC?table=tbl123&view=vew123' },
      { tag: 'text', text: '分析一下' },
    ]] });
    bot.accept(shared);
    await bot.close();
    assert.deepEqual(bitableImports, ['https://demo.feishu.cn/base/ABC?table=tbl123']);
    const bitableReplies = sent.filter(s => s.id === shared.message.message_id);
    assert.deepEqual(bitableReplies.map(s => s.kind), ['text', 'card']);
    assert.match(JSON.stringify(bitableReplies[1]?.data), /"tag":"chart"/);
    assert.ok(sent.some(s => s.id === 'hello' && s.kind === 'card'));
    assert.ok(!sent.some(s => s.id === 'hello' && typeof s.data === 'string' && s.data.includes('错误编号')));
    const report = sent.find(s => s.id === 'report1' && s.kind === 'analysis-report.json');
    assert.ok(report, JSON.stringify(sent));
    const parsed = JSON.parse(report.data as string);
    assert.deepEqual(parsed.data, [{ 地区: '华东', 总销售额: 45000 }, { 地区: '华南', 总销售额: 20000 }, { 地区: '华北', 总销售额: 11000 }]);
    assert.equal(parsed.sql, undefined);
    const answer = sent.find(s => s.id === 'question' && s.kind === 'card');
    assert.ok(answer);
    assert.ok(!JSON.stringify(answer.data).includes('结果预览'));
    assert.ok(!JSON.stringify(answer.data).includes('计算 SQL'));
    assert.ok(!JSON.stringify(answer.data).includes('SELECT'));
    const regionalCard = answer.data as { schema: string; body: { elements: { tag: string; chart_spec?: { type: string; data: { values: unknown[] } } }[] } };
    assert.equal(regionalCard.schema, '2.0');
    const regionalChart = regionalCard.body.elements.find(e => e.tag === 'chart')?.chart_spec;
    assert.equal(regionalChart?.type, 'bar');
    assert.deepEqual(regionalChart?.data.values, [{ label: '华东', value: 45000 }, { label: '华南', value: 20000 }, { label: '华北', value: 11000 }]);
    const recovered = sent.find(s => s.id === 'summary-failure' && s.kind === 'card');
    assert.ok(recovered);
    assert.match(JSON.stringify(recovered.data), /最高为 华东（45,000）/);
    assert.equal((recovered.data as typeof regionalCard).body.elements.filter(e => e.tag === 'chart').length, 1);
    for (const id of ['followup', 'no-chart']) {
      const reply = sent.find(s => s.id === id && s.kind === 'card');
      assert.ok(reply);
      assert.doesNotMatch(JSON.stringify(reply.data), /"tag":"chart"/);
    }
    assert.equal(sent.filter(s => ['question', 'followup', 'mixed', 'no-chart'].includes(s.id) && /\.(json|csv|html)$/.test(s.kind)).length, 0);
    assert.equal(sent.filter(s => s.id === 'mixed' && s.kind === 'card').length, 1);
    assert.equal(sent.filter(s => s.id === 'report1' && s.kind === 'analysis-report.json').length, 1);
    const csv = sent.find(s => s.id === 'csv1' && s.kind === 'analysis-result.csv');
    assert.match(csv?.data as string, /45000/);
    const chart = sent.find(s => s.id === 'chart1' && s.kind === 'analysis-chart.html');
    assert.match(chart?.data as string, /GPTVis/);
    const followup = JSON.parse(sent.find(s => s.id === 'followup-export' && s.kind === 'analysis-report.json')!.data as string);
    assert.deepEqual(followup.data, [{ 总销售额: 45000 }]);
    assert.ok(prompts.some(p => p.includes('历史问题与查询')));
    assert.ok(sent.some(s => s.id === 'other-user' && typeof s.data === 'string' && s.data.includes('请先发送表格')));
    const mixedReport = sent.find(s => s.id === 'mixed-export' && s.kind === 'analysis-report.json');
    assert.ok(mixedReport, JSON.stringify(sent));
    const overviewCard = sent.find(s => s.id === 'mixed' && s.kind === 'card')!.data as typeof regionalCard;
    const overviewCharts = overviewCard.body.elements.flatMap(e => e.chart_spec ? [e.chart_spec] : []);
    assert.equal(overviewCharts.length, 2);
    assert.deepEqual(overviewCharts.find(c => c.type === 'line')?.data.values, [{ label: '2026-01', value: 35000 }, { label: '2026-02', value: 41000 }]);
    const margins = overviewCharts.find(c => c.type === 'bar')?.data.values as { label: string; value: number }[];
    assert.deepEqual(Object.fromEntries(margins.map(p => [p.label, p.value])), { 华东: 20, 华南: 15, 华北: 10 });
    assert.equal(JSON.parse(mixedReport.data as string).query, '分析一下');
    assert.ok(prompts.some(p => p.includes('当前问题：分析一下') && p.includes('整体判断')));

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
