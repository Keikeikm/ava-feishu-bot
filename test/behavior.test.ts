import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { loadConfig } from '../src/config.js';
import { Deduplicator, normalizeMessage } from '../src/messages.js';
import { JobQueue } from '../src/queue.js';
import { resultCsv } from '../src/cards.js';
import { writeBoundedFile } from '../src/feishu.js';
import { bitableRequest, bitableUrl } from '../src/sources.js';
import type { MessageEvent } from '../src/types.js';
import { analysisPrompt } from '../src/analysis-prompt.js';
import { resultCard } from '../src/cards.js';
import type { DatasetInfo } from '../src/types.js';
import { inputLogFields } from '../src/logging.js';
import type { InlineChart } from '../src/charts.js';
import { mentionedArchiveFiles } from '../src/archive.js';

test('ZIP 自然语言选文件支持路径、重名提示和文件名边界', () => {
  const files = ['data/train.csv', 'other/train.csv', 'test.csv'].map(entry => ({
    entry, name: entry.split('/').at(-1)!, path: '',
  }));
  assert.deepEqual(mentionedArchiveFiles(files, '请分析「DATA/TRAIN.CSV」的分布。'), [0]);
  assert.deepEqual(mentionedArchiveFiles(files, '分析train.csv的数据'), [0, 1]);
  assert.deepEqual(mentionedArchiveFiles(files, '分析data/train.csv和test.csv。'), [0, 2]);
  assert.deepEqual(mentionedArchiveFiles(files, '分析test.csv. 然后检查缺失值'), [2]);
  assert.deepEqual(mentionedArchiveFiles(files, '分析pretest.csv、test.csv.bak 和 unknown/test.csv'), []);
});

test('分析卡用普通文字展示标题，图中去掉浮点尾数并保留小量级数值', () => {
  const forecast: InlineChart = {
    kind: 'column', title: '未来3干线性回归预测数量（条）', limited: false,
    points: [{ label: '2022', value: 1422.6000000000058 }, { label: '2023', value: 1538.6000000000058 }],
  };
  const smallValues: InlineChart = {
    kind: 'bar', title: '近10干货类别占比', limited: false,
    points: [{ label: '商品', value: 0.000021234567 }, { label: '服务', value: 237 }],
  };
  const card = resultCard({
    result: { query: '分析趋势', text: '预测与分布', data: [], schema: [] },
    visualization: null, charts: [forecast, smallValues],
  });
  assert.ok('body' in card);
  const elements = card.body.elements;
  assert.deepEqual(elements[1], { tag: 'div', text: { tag: 'plain_text', content: '未来3年线性回归预测数量（条）' } });
  assert.deepEqual(elements[3], { tag: 'div', text: { tag: 'plain_text', content: '近10干货类别占比' } });
  const charts = elements.flatMap(element => 'chart_spec' in element ? [element.chart_spec] : []);
  assert.deepEqual(charts.map(chart => chart.data.values.map(point => point.value)), [[1422.6, 1538.6], [0.0000212, 237]]);
  assert.equal(forecast.points[0]?.value, 1422.6000000000058);
});

test('输入日志隐藏链接和凭证，可关闭正文并截断长消息', () => {
  const input = '分析一下 https://demo.feishu.cn/base/private?table=tbl123\nBearer token123 secret-value sk-abcdefgh12345678';
  assert.equal(inputLogFields(input, true, ['secret-value']).input_text, '分析一下 [链接已隐藏]\nBearer [已隐藏] [已隐藏] [已隐藏]');
  assert.deepEqual(inputLogFields(input, false, []), { input_chars: input.length });
  assert.deepEqual(inputLogFields('字'.repeat(1001), true, []), {
    input_text: '字'.repeat(1000), input_chars: 1001, input_truncated: true,
  });
});

test('宽泛分析主动生成聚合分析目标，结论卡不展示明细、SQL 或附件清单', () => {
  const info = { profile: { models: [] } } as unknown as DatasetInfo;
  const prompt = analysisPrompt('分析一下', info);
  assert.match(prompt, /整体判断/);
  assert.match(prompt, /变化率/);
  assert.match(prompt, /总利润\/总收入/);
  const specific = analysisPrompt('分析一下华东销售下降的原因', info);
  assert.match(specific, /聚焦用户当前问题/);
  const card = resultCard({ result: { query: '分析一下', text: '【结论】销售增长集中在华东。\n【关键依据】销售额增长17.1%。\n【下一步】要比较各地区的增长贡献吗？', data: [{ private: 'RAW_DATA' }], schema: [], sql: 'SELECT secret FROM data' }, visualization: null });
  const rendered = JSON.stringify(card);
  assert.match(rendered, /销售增长集中在华东/);
  assert.ok(!/RAW_DATA|SELECT|结果预览|报告 JSON/.test(rendered));
});

export function config() { return loadConfig({ FEISHU_APP_ID: 'test-app', FEISHU_APP_SECRET: 'test-secret', LLM_MODEL: 'test-model', LLM_API_KEY: 'test-key', ENABLE_CHARTS: 'false' }); }
export function message(id: string, text: string, user = 'ou_user'): MessageEvent {
  return { sender: { sender_type: 'user', sender_id: { open_id: user } }, message: { message_id: id, chat_id: 'oc_chat', chat_type: 'p2p', message_type: 'text', content: JSON.stringify({ text }) } };
}

test('群聊只接受当前机器人 @；用户和会话隔离；机器人消息被忽略', () => {
  const c = { botOpenId: 'ou_bot', allowedUsers: new Set<string>() };
  const event = message('m1', '@_user_1 分析销售额');
  event.message.chat_type = 'group';
  event.message.mentions = [{ key: '@_user_1', id: { open_id: 'ou_other_bot' } }];
  assert.equal(normalizeMessage(event, c), null);
  event.message.mentions[0]!.id.open_id = 'ou_bot';
  const a = normalizeMessage(event, c)!;
  assert.equal(a.text, '分析销售额');
  const b = normalizeMessage(message('m2', '分析', 'ou_user2'), c)!;
  assert.notEqual(a.sessionKey, b.sessionKey);
  event.sender.sender_type = 'app';
  assert.equal(normalizeMessage(event, c), null);
  assert.equal(normalizeMessage(message('m3', '分析'), { ...c, allowedUsers: new Set(['ou_allowed']) }), null);
});

test('群聊文件无需 @，路径不能从上传名称穿越，富文本链接能导入', () => {
  const event = message('m', '');
  event.message.chat_type = 'group';
  event.message.message_type = 'file';
  event.message.content = JSON.stringify({ file_name: '../../secret/sales.csv', file_key: 'file_1' });
  assert.equal(normalizeMessage(event, { botOpenId: '', allowedUsers: new Set() })?.file?.name, 'sales.csv');
  const post = message('post', '');
  post.message.message_type = 'post';
  post.message.content = JSON.stringify({ title: '', content: [[{ tag: 'text', text: '/导入 ' }, { tag: 'a', href: 'https://demo.feishu.cn/base/ABC?table=tbl123', text: '表格' }]] });
  const text = normalizeMessage(post, { botOpenId: '', allowedUsers: new Set() })!.text!;
  assert.deepEqual(bitableRequest(text), { url: 'https://demo.feishu.cn/base/ABC?table=tbl123', question: '' });
  assert.throws(() => bitableUrl('https://evil.example/base/ABC'));
});

test('多维表格链接与问题可同条发送，并保留子表选择', () => {
  const url = 'https://demo.feishu.cn/wiki/ABC?table=tbl123';
  for (const text of [`${url}分析一下`, `分析一下\n${url}&view=vew123`, `/导入 ${url} 分析一下`]) {
    assert.deepEqual(bitableRequest(text), { url, question: '分析一下' });
  }
  assert.throws(() => bitableRequest(`${url}\nhttps://demo.feishu.cn/base/XYZ 分析一下`), /一张/);
  assert.throws(() => bitableRequest('/导入 https://demo.feishu.cn.evil.example/base/ABC'));
  assert.throws(() => bitableRequest('https://demo.feishu.cn/share/base/view/shrcn123 分析一下'), { code: 'BITABLE_SHARE_LINK' });
});

test('文字与附件一起发送：识别顶层 files、本地化正文及内联文件，文件不重复', () => {
  const config = { botOpenId: '', allowedUsers: new Set<string>() };
  const variants = [
    { title: '分析一下这个数据', content: [], files: [{ file_key: 'file_csv', file_name: 'sales.csv' }] },
    { content: [[{ tag: 'text', text: '按地区汇总' }]], files: [{ file_key: 'file_csv', file_name: 'sales.csv' }] },
    { zh_cn: { content: [[{ tag: 'text', text: '按地区汇总' }]], files: [{ file_key: 'file_csv', file_name: 'sales.csv' }] } },
    { content: [[{ tag: 'text', text: '按地区汇总' }], [{ tag: 'file', file_key: 'file_csv', file_name: 'sales.csv' }]], files: [{ file_key: 'file_csv', file_name: 'sales.csv' }] },
    { content: [[{ tag: 'text', text: '按地区汇总' }], [{ tag: 'file', file_key: 'file_csv' }]], files: [{ file_key: 'file_csv', file_name: 'sales.csv' }] },
    { content: [], files: [{ file_key: 'file_csv', name: 'sales.csv' }] },
  ];
  for (const content of variants) {
    const post = message('post-with-file', '');
    post.message.message_type = 'post';
    post.message.content = JSON.stringify(content);
    const normalized = normalizeMessage(post, config)!;
    assert.equal(normalized.file?.key, 'file_csv');
    assert.equal(normalized.file?.name, 'sales.csv');
    assert.equal(normalized.attachmentCount, 1);
    if (content.content?.length || content.zh_cn) assert.equal(normalized.text, '按地区汇总');
  }
});

test('重复 message_id 只处理一次，去重缓存到期后释放', () => {
  const seen = new Deduplicator(100, 2);
  assert.equal(seen.accept('one', 100), true);
  assert.equal(seen.accept('one', 120), false);
  assert.equal(seen.accept('one', 201), true);
  seen.accept('two', 210); seen.accept('three', 220);
  assert.equal(seen.accept('one', 230), true);
});

test('任务队列按用户顺序处理，失败后继续执行，并限制积压', async () => {
  const queue = new JobQueue(2, 4, 2);
  let release!: () => void;
  const block = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  assert.equal(queue.enqueue('a', async () => { calls.push('a1'); await block; throw new Error('test'); }), true);
  assert.equal(queue.enqueue('a', async () => { calls.push('a2'); }), true);
  assert.equal(queue.enqueue('a', async () => {}), false);
  assert.equal(queue.enqueue('b', async () => { calls.push('b'); release(); }), true);
  await queue.drain();
  assert.ok(calls.indexOf('a2') > calls.indexOf('a1'));
  assert.ok(calls.indexOf('b') < calls.indexOf('a2'));
  assert.equal(queue.enqueue('c', async () => {}), false);
});

test('下载按实际字节数限制，保留正常内容，拒绝空文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ava-stream-test-'));
  try {
    const file = join(directory, 'file.csv');
    await writeBoundedFile(Readable.from(['a,b\n1,2']), file, 100);
    assert.equal(await readFile(file, 'utf8'), 'a,b\n1,2');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    await assert.rejects(writeBoundedFile(Readable.from(['0123', '4567']), join(directory, 'big'), 5), /超过/);
    await assert.rejects(writeBoundedFile(Readable.from([]), join(directory, 'empty'), 100), /为空/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('CSV 导出保留逗号换行与负数，字符串公式不会执行', () => {
  const csv = resultCsv([{ '分类': '=1+1', '值': -12, '备注': 'a,"b"\nc' }]);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"-12"'));
  assert.ok(csv.includes('"a,""b""\nc"'));
});
