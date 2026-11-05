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

test('飞书训练指令读取当前 AVA 数据并评估分类和回归，拦截泰坦尼克号示例标签', { timeout: 60_000 }, async t => {
  const python = process.env.ML_PYTHON || (existsSync('.venv/bin/python') ? resolve('.venv/bin/python') : 'python3');
  if (spawnSync(python, ['-c', "import importlib.util; raise SystemExit(importlib.util.find_spec('sklearn') is None)"], { stdio: 'ignore' }).status !== 0) {
    t.skip('需要安装 ml/requirements.txt');
    return;
  }
  const config = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', LLM_API_KEY: 'test', LLM_MODEL: 'test', ML_PYTHON: python });
  const logs: { event: string; request_id: string; input_text?: string; target?: string; task?: string; runtime?: string; scores?: unknown[] }[] = [];
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
  const housing = ['RM,LSTAT,MEDV'];
  for (let i = 0; i < 120; i++) {
    const rooms = 4 + i % 60 / 20;
    const share = 5 + (i % 60 * 13) % 23;
    const price = i % 19 === 0 ? '' : (4.5 * rooms - 0.35 * share + i % 4 / 10).toFixed(2);
    housing.push(`${rooms},${share},${price}`);
  }
  const messenger: Messenger = {
    text: async (m, content) => { sent.push({ id: m.id, kind: 'text', content }); },
    card: async (m, content) => { sent.push({ id: m.id, kind: 'card', content: JSON.stringify(content) }); },
    file: async () => { assert.fail('训练结果应直接在卡片里显示'); },
    download: async (m, path) => {
      if (m.file?.name === 'titanic.csv') await copyFile(resolve('examples/titanic.csv'), path);
      else if (m.file?.name === 'housing.csv') await writeFile(path, housing.join('\n'));
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
    bot.accept(event('invalid-regression', '/训练 渠道 --回归'));
    upload('unverified', 'titanic.csv', '/训练 Survived');
    upload('housing', 'housing.csv', '');
    await waitFor(() => sent.some(item => item.id === 'housing' && item.kind === 'card'));
    const regressionRequest = '请帮我训练一个机器学习模型。目标字段是 MEDV（自住房屋中位数价值）。这是一个回归任务。';
    const richText = event('regression', '');
    const [beforeTarget, afterTarget] = regressionRequest.split('MEDV');
    richText.message.message_type = 'post';
    richText.message.content = JSON.stringify({
      content: [[{ tag: 'text', text: beforeTarget }, { tag: 'text', text: 'MEDV', style: ['bold'] }, { tag: 'text', text: afterTarget }]],
    });
    bot.accept(richText);
    bot.accept(event('regression-command', '/训练 "medv" --回归 --表 "data"'));
    bot.accept(event('regression-model', '/模型'));
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
    const regression = sent.find(item => item.id === 'regression' && item.kind === 'card');
    assert.ok(regression, JSON.stringify(sent.filter(item => item.id === 'regression')));
    assert.match(regression.content, /回归模型评估/);
    assert.match(regression.content, /预测「MEDV」/);
    assert.match(regression.content, /中位数基线 · MAE [\d.]+ · RMSE [\d.]+ · R² -?[\d.]+/);
    assert.match(regression.content, /排除了 7 条缺少目标标签/);
    assert.match(regression.content, /相同特征的记录留在同一折/);
    const regressionChart = JSON.parse(regression.content).body.elements.find((element: { tag: string }) => element.tag === 'chart');
    assert.equal(regressionChart.chart_spec.data.values.length, 3);
    const regressionLog = logs.find(log => log.event === 'message_received' && log.input_text === regressionRequest);
    assert.ok(regressionLog);
    assert.ok(logs.some(log => log.request_id === regressionLog.request_id && log.event === 'training_started'
      && log.task === 'regression' && log.target === 'MEDV' && log.runtime === 'local_python'));
    assert.ok(sent.some(item => item.id === 'regression-command' && item.kind === 'card' && item.content.includes('回归模型评估')));
    assert.ok(sent.some(item => item.id === 'regression-model' && item.kind === 'text'
      && /选定模型：(?:岭回归（Ridge）|随机森林（RandomForestRegressor）)/.test(item.content)
      && item.content.includes('这轮只做了交叉验证评估')));
    assert.ok(sent.some(item => item.id === 'invalid-regression' && item.kind === 'text'
      && item.content.includes('回归目标列需要是数值') && item.content.includes('ML_LABELS')));
  } finally {
    await bot.close();
    await rm(runtime, { recursive: true, force: true });
  }
});

test('ZIP 上传后询问用途，按 ID 生成和对比预测，拒绝越界路径', { timeout: 60_000 }, async t => {
  const python = process.env.ML_PYTHON || (existsSync('.venv/bin/python') ? resolve('.venv/bin/python') : 'python3');
  if (spawnSync(python, ['-c', "import importlib.util; raise SystemExit(importlib.util.find_spec('sklearn') is None)"], { stdio: 'ignore' }).status !== 0) {
    t.skip('需要安装 ml/requirements.txt');
    return;
  }
  const config = loadConfig({ FEISHU_APP_ID: 'test', FEISHU_APP_SECRET: 'test', LLM_API_KEY: 'test', LLM_MODEL: 'test', ML_PYTHON: python });
  const runtime = await mkdtemp(join(tmpdir(), 'ava-zip-e2e-'));
  const files = new Map<string, { name: string; content: string }>();
  const sent: { id: string; content: string }[] = [];
  const bot = new Bot(config, runtime, {
    text: async (m, content) => { sent.push({ id: m.id, content }); },
    card: async (m, card) => { sent.push({ id: m.id, content: JSON.stringify(card) }); },
    file: async (m, name, data) => { files.set(m.id, { name, content: data.toString('utf8') }); },
    download: async (m, path) => { await copyFile(join(runtime, m.file!.name), path); },
  }, new Sessions(config));
  try {
    const generated = spawnSync(python, ['-c', `
from pathlib import Path
import sys, zipfile
root = Path(sys.argv[1])
with zipfile.ZipFile(root / "challenge.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("challenge/train.csv", "Id,Age,Survived\\n" + "".join(f"{i},{i},{int(i >= 60)}\\n" for i in range(120)))
    archive.writestr("challenge/test.csv", "Id,Age\\n00123,3\\n00124,117\\n")
    archive.writestr("challenge/gender_submission.csv", "Survived,Id\\n0,00124\\n1,00123\\n")
    archive.writestr("__MACOSX/._train.csv", "ignore")
with zipfile.ZipFile(root / "unsafe.zip", "w") as archive:
    archive.writestr("../outside.csv", "a,b\\n1,2\\n")
`, runtime], { encoding: 'utf8' });
    assert.equal(generated.status, 0, generated.stderr);
    const upload = (id: string, file: string, question = '') => {
      const message = event(id, '');
      message.message.message_type = question ? 'post' : 'file';
      const attachment = { file_key: 'fixture', file_name: file };
      message.message.content = JSON.stringify(question ? { content: [[{ tag: 'text', text: question }]], files: [attachment] } : attachment);
      bot.accept(message);
    };
    upload('zip', 'challenge.zip');
    await waitFor(() => sent.some(item => item.id === 'zip' && item.content.includes('你想分析哪个文件')));
    const guide = sent.find(item => item.id === 'zip' && item.content.includes('你想分析哪个文件'))!.content;
    assert.match(guide, /challenge\/train.csv[\s\S]*challenge\/test.csv[\s\S]*gender_submission.csv/);
    assert.doesNotMatch(guide, /__MACOSX/);
    assert.equal(files.size, 0);
    bot.accept(event('select', '/选文件 1'));
    upload('unsafe', 'unsafe.zip');
    bot.accept(event('predict', '请用机器学习预测'));
    bot.accept(event('prediction-chart', '请你对生成的预测数据进行可视化'));
    await waitFor(() => sent.some(item => item.id === 'prediction-chart' && item.content.includes('预测类别分布')));
    bot.accept(event('prediction-followup', '画个图'));
    await waitFor(() => sent.some(item => item.id === 'prediction-followup' && item.content.includes('预测类别分布')));
    bot.accept(event('prediction-export', '/导出 CSV'));
    await waitFor(() => files.has('prediction-export'));
    upload('with-prompt', 'challenge.zip', '/预测 --目标 Survived --分类');
    await waitFor(() => files.has('with-prompt'));
    bot.accept(event('model-question', '你刚才用什么模型训练的？'));
    await waitFor(() => sent.some(item => item.id === 'model-question'));
    bot.accept(event('compare-template', '请你检验一下你预测的正确率。答案在gender_submission.csv'));
    bot.accept(event('compare-unlabeled', '/对比 test.csv'));
    await writeFile(join(runtime, 'labels.csv'), 'Id,Survived\n00123,0\n00124,0\n');
    upload('compare-labels', 'labels.csv', '/对比');
    await writeFile(join(runtime, 'wrong-ids.csv'), 'Id,Survived\n00123,0\n00125,0\n');
    upload('compare-wrong-ids', 'wrong-ids.csv', '/对比');
    await bot.close();
    assert.ok(sent.some(item => item.id === 'select' && item.content.includes('train.csv')));
    assert.ok(sent.some(item => item.id === 'unsafe' && item.content.includes('ZIP_INVALID')));
    assert.ok(sent.some(item => item.id === 'predict' && /训练集 \d+ 折交叉验证结果：宏平均 F1/.test(item.content)));
    const predictionReply = sent.find(item => item.id === 'with-prompt' && item.content.includes('本轮在本机训练'));
    assert.ok(predictionReply);
    const estimator = /选定 ((?:逻辑回归（LogisticRegression）|随机森林（RandomForestClassifier）))/.exec(predictionReply.content)?.[1];
    assert.ok(estimator);
    assert.deepEqual(sent.filter(item => item.id === 'model-question').map(item => item.content.includes(`选定模型：${estimator}`)), [true]);
    assert.ok(sent.some(item => item.id === 'model-question' && item.content.includes('用全部 120 条有标签记录重新拟合，为 2 条测试记录')));
    for (const id of ['predict', 'with-prompt']) {
      assert.deepEqual(files.get(id), { name: 'submission.csv', content: 'Survived,Id\r\n1,00124\r\n0,00123\r\n' }, JSON.stringify(sent.filter(item => item.id === id)));
    }
    assert.equal([...files.values()].filter(file => file.name === 'submission.csv').length, 2);
    for (const id of ['prediction-chart', 'prediction-followup']) {
      const reply = JSON.parse(sent.find(item => item.id === id && item.content.includes('预测类别分布'))!.content);
      assert.match(JSON.stringify(reply), /上一轮 submission.csv 的「Survived」预测共 2 条/);
      const chart = reply.body.elements.find((element: { tag: string }) => element.tag === 'chart');
      assert.deepEqual(chart.chart_spec.data.values, [{ label: '0', value: 1 }, { label: '1', value: 1 }]);
    }
    assert.match(files.get('prediction-export')!.content, /预测类别.*预测条数/);
    assert.ok(sent.some(item => item.id === 'compare-template' && item.content.includes('一致率 0.00%') && item.content.includes('提交示例')));
    assert.ok(sent.some(item => item.id === 'compare-labels' && item.content.includes('按所提供标签计算的准确率 50.00%')));
    assert.ok(sent.some(item => item.id === 'compare-unlabeled' && item.content.includes('缺少目标列「Survived」')));
    assert.ok(sent.some(item => item.id === 'compare-wrong-ids' && item.content.includes('匹配 1 条')));
  } finally {
    await bot.close();
    await rm(runtime, { recursive: true, force: true });
  }
});

test('真实 AVA + 受控模型接口：文件上传、SQL计算、追问、图表、去重及不同用户隔离', { timeout: 60_000 }, async t => {
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
    download: async (m, destination) => {
      await copyFile(m.file?.name === 'eda.zip' ? join(runtime, 'eda.zip') : resolve('examples/sales.csv'), destination);
    },
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
    await t.test('在自然语言中指定 ZIP 文件并做探索性分析', async t => {
      const python = process.env.ML_PYTHON || (existsSync('.venv/bin/python') ? resolve('.venv/bin/python') : 'python3');
      const generated = spawnSync(python, ['-c', `
from zipfile import ZipFile
import sys
with ZipFile(sys.argv[1], 'w') as archive:
    archive.write('examples/sales.csv', 'data/train.csv')
    archive.writestr('test.csv', 'Id,Age\\n1,24\\n')
`, join(runtime, 'eda.zip')], { encoding: 'utf8' });
      if ((generated.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        t.skip('ZIP 解压需要 Python 3');
        return;
      }
      assert.equal(generated.status, 0, generated.stderr);
      const user = 'ou_zip';
      const upload = event('upload-eda', '', user);
      upload.message.message_type = 'file';
      upload.message.content = JSON.stringify({ file_key: 'zip_eda', file_name: 'eda.zip' });
      bot.accept(upload);
      const question = '请你帮我对train.csv进行数据探索性分析？';
      bot.accept(event('zip-eda', question, user));
      await waitFor(() => sent.some(reply => reply.id === 'zip-eda' && reply.kind === 'card'));
      const result = sent.find(reply => reply.id === 'zip-eda' && reply.kind === 'card');
      assert.match(JSON.stringify(result?.data), /华东.*45000/);
      assert.ok(prompts.some(prompt => prompt.includes(`当前问题：${question}`) && prompt.includes('关键字段的缺失')));
      bot.accept(event('zip-compare-groups', '请对比train.csv中各地区的销售额', user));
      await waitFor(() => sent.some(reply => reply.id === 'zip-compare-groups' && reply.kind === 'card'));
      bot.accept(event('zip-ambiguous', '对train.csv和test.csv进行探索性分析', user));
      await waitFor(() => sent.some(reply => reply.id === 'zip-ambiguous' && String(reply.data).includes('匹配到多个文件')));
      assert.equal(sent.some(reply => reply.id === 'zip-ambiguous' && reply.kind === 'card'), false);
    });
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
