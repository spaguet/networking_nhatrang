import { STOP_WORDS } from '../config';
import type { Env } from '../env';
import { containsLink } from './links';

export const MESSAGE_MAX_LEN = 500;
export const MESSAGE_PREVIEW_LEN = 80;
export const MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MESSAGE_RATE_LIMIT_MAX = 50;
export const MESSAGE_RATE_LIMIT_TTL_SEC = 25 * 3600;

export interface ConversationRow {
  conversation_id: string;
  listing_id: string;
  owner_tg_id: number;
  peer_tg_id: number;
  created_at: string;
  first_message_at: string | null;
  expires_at: string | null;
  last_message_at: string | null;
  last_message_id: string | null;
  last_message_preview: string | null;
  status: string;
}

export interface MessageRow {
  message_id: string;
  conversation_id: string;
  sender_tg_id: number;
  body: string;
  created_at: string;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** conversation_id = sha256(listing_id:min:max) hex — user_messaging_TZ.md §4.2 */
export async function computeConversationId(
  listingId: string,
  ownerTgId: number,
  peerTgId: number,
): Promise<string> {
  const a = Math.min(ownerTgId, peerTgId);
  const b = Math.max(ownerTgId, peerTgId);
  const input = `${listingId}:${a}:${b}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(digest);
}

export function isConversationExpired(expiresAt: string | null | undefined): boolean {
  if (!expiresAt) {
    return false;
  }
  const parsed = new Date(expiresAt);
  return !Number.isNaN(parsed.getTime()) && parsed.getTime() <= Date.now();
}

export function messagePreview(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MESSAGE_PREVIEW_LEN) {
    return trimmed;
  }
  return trimmed.slice(0, MESSAGE_PREVIEW_LEN);
}

export function generateMessageId(): string {
  return crypto.randomUUID();
}

export function validateMessageBody(
  raw: unknown,
): { ok: true; body: string } | { ok: false; error: string } {
  const body = String(raw ?? '').trim();
  if (!body) {
    return { ok: false, error: 'validation' };
  }
  if (body.length > MESSAGE_MAX_LEN) {
    return { ok: false, error: 'message_too_long' };
  }
  if (containsLink(body)) {
    return { ok: false, error: 'links_forbidden' };
  }
  const lower = body.toLowerCase();
  for (let i = 0; i < STOP_WORDS.length; i++) {
    if (lower.includes(STOP_WORDS[i])) {
      return { ok: false, error: 'stop_words' };
    }
  }
  return { ok: true, body };
}

function messageRateLimitKey(tgId: number): string {
  const dateUtc = new Date().toISOString().slice(0, 10);
  return `msg_rate:${tgId}:${dateUtc}`;
}

export async function checkMessageRateLimit(
  tgId: number,
  env: Env,
): Promise<{ allowed: boolean }> {
  const key = messageRateLimitKey(tgId);
  const raw = await env.CACHE.get(key);
  const count = raw ? Number(raw) : 0;
  return { allowed: count < MESSAGE_RATE_LIMIT_MAX };
}

export async function incrementMessageRateLimit(tgId: number, env: Env): Promise<void> {
  const key = messageRateLimitKey(tgId);
  const raw = await env.CACHE.get(key);
  const count = raw ? Number(raw) : 0;
  await env.CACHE.put(key, String(count + 1), {
    expirationTtl: MESSAGE_RATE_LIMIT_TTL_SEC,
  });
}

export function isConversationParticipant(conversation: ConversationRow, tgId: number): boolean {
  return conversation.owner_tg_id === tgId || conversation.peer_tg_id === tgId;
}

export async function loadConversationForParticipant(
  conversationId: string,
  tgId: number,
  db: D1Database,
): Promise<ConversationRow | null> {
  const row = await db
    .prepare('SELECT * FROM conversations WHERE conversation_id = ?')
    .bind(conversationId)
    .first<ConversationRow>();
  if (!row || !isConversationParticipant(row, tgId)) {
    return null;
  }
  return row;
}

export async function fetchMessagesForConversation(
  db: D1Database,
  conversationId: string,
  limit: number,
  beforeId?: string,
): Promise<MessageRow[]> {
  const safeLimit = Math.min(Math.max(1, limit), 50);

  if (beforeId) {
    const anchor = await db
      .prepare('SELECT created_at FROM messages WHERE message_id = ? AND conversation_id = ?')
      .bind(beforeId, conversationId)
      .first<{ created_at: string }>();
    if (!anchor) {
      return [];
    }
    const result = await db
      .prepare(
        `SELECT message_id, conversation_id, sender_tg_id, body, created_at
         FROM messages
         WHERE conversation_id = ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .bind(conversationId, anchor.created_at, safeLimit)
      .all<MessageRow>();
    return (result.results ?? []).reverse();
  }

  const result = await db
    .prepare(
      `SELECT message_id, conversation_id, sender_tg_id, body, created_at
       FROM (
         SELECT message_id, conversation_id, sender_tg_id, body, created_at
         FROM messages
         WHERE conversation_id = ?
         ORDER BY created_at DESC
         LIMIT ?
       ) recent
       ORDER BY created_at ASC`,
    )
    .bind(conversationId, safeLimit)
    .all<MessageRow>();

  return result.results ?? [];
}

export async function countUnreadConversations(tgId: number, db: D1Database): Promise<number> {
  const result = await db
    .prepare(
      `SELECT COUNT(*) AS cnt
       FROM conversations c
       INNER JOIN messages lm ON lm.message_id = c.last_message_id
       LEFT JOIN conversation_reads cr
         ON cr.conversation_id = c.conversation_id AND cr.reader_tg_id = ?
       WHERE (c.owner_tg_id = ? OR c.peer_tg_id = ?)
         AND c.last_message_id IS NOT NULL
         AND lm.sender_tg_id != ?
         AND (cr.last_read_at IS NULL OR cr.last_read_at < c.last_message_at)`,
    )
    .bind(tgId, tgId, tgId, tgId)
    .first<{ cnt: number }>();

  return Number(result?.cnt ?? 0);
}

export async function isConversationUnread(
  conversation: ConversationRow,
  tgId: number,
  db: D1Database,
): Promise<boolean> {
  if (!conversation.last_message_id || !conversation.last_message_at) {
    return false;
  }

  const lastMsg = await db
    .prepare('SELECT sender_tg_id FROM messages WHERE message_id = ?')
    .bind(conversation.last_message_id)
    .first<{ sender_tg_id: number }>();

  if (!lastMsg || lastMsg.sender_tg_id === tgId) {
    return false;
  }

  const read = await db
    .prepare(
      `SELECT last_read_at FROM conversation_reads
       WHERE conversation_id = ? AND reader_tg_id = ?`,
    )
    .bind(conversation.conversation_id, tgId)
    .first<{ last_read_at: string }>();

  if (!read?.last_read_at) {
    return true;
  }

  return read.last_read_at < conversation.last_message_at;
}
