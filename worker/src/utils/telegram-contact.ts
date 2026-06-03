import type { Env } from '../env';
import { getUserIdFromInitData, getUsernameFromInitData } from './auth';
import { containsLink } from './links';

const USERNAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{4,31}$/;

export class InvalidTelegramUsernameError extends Error {
  readonly code = 'invalid_telegram_username';

  constructor(message?: string) {
    super(message ?? 'invalid_telegram_username');
    this.name = 'InvalidTelegramUsernameError';
  }
}

export type VerifyTelegramContactError =
  | 'invalid_telegram_username'
  | 'telegram_contact_not_found'
  | 'telegram_username_mismatch';

export type VerifyTelegramContactResult =
  | { ok: true; username: string }
  | { ok: false; error: VerifyTelegramContactError };

interface TelegramGetChatResult {
  ok: boolean;
  result?: { id?: number; type?: string; username?: string };
  description?: string;
  error_code?: number;
}

/** Normalize contacts input to a Telegram username (without @). Throws on invalid format. */
export function parseTelegramUsername(contacts: string): string {
  const rawInput = String(contacts ?? '').trim();
  if (!rawInput) {
    throw new InvalidTelegramUsernameError('empty');
  }

  if (containsLink(rawInput)) {
    const tMeMatch = rawInput.match(
      /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-zA-Z][a-zA-Z0-9_]{0,31})/i,
    );
    if (!tMeMatch?.[1]) {
      throw new InvalidTelegramUsernameError('link_not_username');
    }
    const fromUrl = tMeMatch[1];
    if (!USERNAME_RE.test(fromUrl)) {
      throw new InvalidTelegramUsernameError('format');
    }
    return fromUrl;
  }

  let username = rawInput;
  if (username.startsWith('@')) {
    username = username.slice(1);
  }
  username = username.split(/[/?#]/)[0]?.trim() ?? '';

  if (!USERNAME_RE.test(username)) {
    throw new InvalidTelegramUsernameError('format');
  }

  return username;
}

export function buildTelegramChatUrl(params: {
  username?: string | null;
  ownerTgId?: number | null;
}): string {
  const username = params.username?.trim();
  if (username) {
    const normalized = username.startsWith('@') ? username.slice(1) : username;
    if (USERNAME_RE.test(normalized)) {
      return `https://t.me/${normalized}`;
    }
  }

  const ownerTgId = params.ownerTgId;
  if (ownerTgId != null && Number.isFinite(ownerTgId)) {
    return `tg://user?id=${ownerTgId}`;
  }

  throw new InvalidTelegramUsernameError('no_chat_target');
}

function telegramIdsEqual(a: unknown, b: unknown): boolean {
  return a != null && b != null && String(a) === String(b);
}

async function telegramGetChat(
  env: Env,
  chatId: string | number,
): Promise<TelegramGetChatResult> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/getChat`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as TelegramGetChatResult;
    } catch {
      return { ok: false, description: text.slice(0, 500) };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, description: msg };
  }
}

async function getChatByUsername(
  env: Env,
  username: string,
): Promise<TelegramGetChatResult> {
  return telegramGetChat(env, `@${username}`);
}

/** Bot API getChat by numeric user id (private chat the bot has seen). */
export async function getTelegramUsernameForUserId(
  env: Env,
  tgId: number,
): Promise<string | null> {
  if (!env.BOT_TOKEN || !Number.isFinite(tgId) || tgId <= 0) {
    return null;
  }

  const chat = await telegramGetChat(env, tgId);
  const username = chat.result?.username?.trim();
  return username || null;
}

/** Verify that contacts resolve to a public @username owned by tgId (Bot API getChat). */
export async function verifyTelegramContactForOwner(
  env: Env,
  tgId: number,
  contacts: string,
  initData?: string,
): Promise<VerifyTelegramContactResult> {
  let username: string;
  try {
    username = parseTelegramUsername(contacts);
  } catch {
    return { ok: false, error: 'invalid_telegram_username' };
  }

  if (initData) {
    const initUsername = getUsernameFromInitData(initData);
    const initUserId = getUserIdFromInitData(initData);
    if (
      initUsername &&
      initUserId != null &&
      initUsername.toLowerCase() === username.toLowerCase() &&
      telegramIdsEqual(initUserId, tgId)
    ) {
      return { ok: true, username: initUsername };
    }
  }

  if (!env.BOT_TOKEN) {
    return { ok: false, error: 'telegram_contact_not_found' };
  }

  const chat = await getChatByUsername(env, username);
  if (!chat.ok || chat.result?.id == null) {
    return { ok: false, error: 'telegram_contact_not_found' };
  }

  if (!telegramIdsEqual(chat.result.id, tgId)) {
    return { ok: false, error: 'telegram_username_mismatch' };
  }

  return { ok: true, username };
}
