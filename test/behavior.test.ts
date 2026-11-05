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
import { bitableUrl } from '../src/sources.js';
import type { MessageEvent } from '../src/types.js';

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
  assert.equal(normalizeMessage(post, { botOpenId: '', allowedUsers: new Set() })?.text, '/导入 https://demo.feishu.cn/base/ABC?table=tbl123');
  assert.throws(() => bitableUrl('https://evil.example/base/ABC'));
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
