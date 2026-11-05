import type { Config } from './config.js';
import type { IncomingMessage, MessageEvent } from './types.js';
import { isBitableLink } from './sources.js';

type PostPart = { tag?: string; text?: string; href?: string; file_key?: string; file_name?: string; name?: string };
type Post = { title?: string; content?: PostPart[][]; files?: PostPart[]; zh_cn?: Post; en_us?: Post };

function attachment(value: PostPart): IncomingMessage['file'] {
  if (typeof value.file_key !== 'string' || !value.file_key) return undefined;
  const name = value.file_name || value.name;
  return { key: value.file_key, name: typeof name === 'string' && name ? name.split(/[/\\]/).pop()!.slice(-200) : '未命名文件' };
}

function parsePost(post: Post): { text: string; files: NonNullable<IncomingMessage['file']>[] } {
  const value = Array.isArray(post.content) ? post : post.zh_cn || post.en_us || post;
  const lines = Array.isArray(value.content) ? value.content.filter(Array.isArray) : [];
  const files = new Map<string, NonNullable<IncomingMessage['file']>>();
  for (const part of [...(Array.isArray(post.files) ? post.files : []), ...(value !== post && Array.isArray(value.files) ? value.files : []), ...lines.flat().filter(part => part?.tag === 'file')]) {
    if (!part || typeof part !== 'object') continue;
    const file = attachment(part);
    if (file && (!files.has(file.key) || files.get(file.key)?.name === '未命名文件')) files.set(file.key, file);
  }
  const text = [typeof value.title === 'string' ? value.title : '', ...lines.map(line => line.map(part => {
    if (!part || typeof part !== 'object') return '';
    if (part.tag === 'a' && typeof part.href === 'string' && isBitableLink(part.href)) return `\n${part.href}\n`;
    const text = part.tag === 'a' ? part.href || part.text : part.tag === 'text' ? part.text : '';
    return typeof text === 'string' ? text : '';
  }).join(''))].join('\n').trim();
  return { text, files: [...files.values()] };
}

export function normalizeMessage(event: MessageEvent, config: Pick<Config, 'botOpenId' | 'allowedUsers'>): IncomingMessage | null {
  const userId = event.sender?.sender_id?.open_id;
  const m = event.message;
  if (event.sender?.sender_type !== 'user' || !userId || !m?.message_id || !m.chat_id) return null;
  if (config.allowedUsers.size && !config.allowedUsers.has(userId)) return null;
  // Group file messages cannot @mention. Import only into the sender's own session.
  if (m.chat_type !== 'p2p' && m.message_type !== 'file' && (!config.botOpenId || !m.mentions?.some(mention => mention.id.open_id === config.botOpenId))) return null;
  let content: Post & { file_key?: string; file_name?: string; text?: string };
  try { content = JSON.parse(m.content); } catch { return null; }
  if (!content || typeof content !== 'object') return null;
  const incoming: IncomingMessage = { id: m.message_id, userId, chatId: m.chat_id, sessionKey: JSON.stringify([m.chat_id, userId]) };
  if (m.message_type === 'file' && typeof content.file_key === 'string' && typeof content.file_name === 'string') {
    incoming.file = { key: content.file_key, name: content.file_name.split(/[/\\]/).pop()!.slice(-200) };
    return incoming;
  }
  const post = m.message_type === 'post' ? parsePost(content) : undefined;
  if (post?.files.length) {
    incoming.file = post.files[0];
    incoming.attachmentCount = post.files.length;
  }
  let text = m.message_type === 'text' && typeof content.text === 'string' ? content.text : post?.text || '';
  for (const mention of m.mentions || []) text = text.replaceAll(mention.key, '');
  incoming.text = text.trim();
  return incoming.text || incoming.file ? incoming : null;
}

export class Deduplicator {
  private seen = new Map<string, number>();
  constructor(private ttlMs = 12 * 60 * 60_000, private capacity = 10_000) {}
  accept(id: string, now = Date.now()): boolean {
    for (const [key, time] of this.seen) {
      if (now - time < this.ttlMs) break;
      this.seen.delete(key);
    }
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.keys().next().value!);
    return true;
  }
}
