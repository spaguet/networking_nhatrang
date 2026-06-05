import { getConfig } from '../config';
import type { Env } from '../env';
import { ensureGrandAdmin } from '../utils/admin-bootstrap';
import { isAdmin } from '../utils/admin-auth';
import { createAdminPortfolioToken, getMiniAppPortfolioUrl } from '../utils/portfolio-auth';
import { logAction } from '../utils/helpers';

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  web_app?: { url: string };
}

export interface ReplyKeyboardButton {
  text: string;
  web_app?: { url: string };
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface ReplyKeyboardMarkup {
  keyboard: ReplyKeyboardButton[][];
  resize_keyboard?: boolean;
  is_persistent?: boolean;
  one_time_keyboard?: boolean;
}

/** Inline (под сообщением) или reply (у поля ввода). */
export type TelegramReplyMarkup = InlineKeyboardMarkup | ReplyKeyboardMarkup;

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

async function telegramRequest(
  method: string,
  payload: Record<string, unknown>,
  env: Env,
): Promise<TelegramApiResponse> {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    try {
      return JSON.parse(text) as TelegramApiResponse;
    } catch {
      await logAction(
        0,
        'error',
        `telegram ${method} parse: ${text.slice(0, 500)}`,
        env.DB,
      );
      return { ok: false, description: text };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `telegram ${method}: ${msg}`, env.DB);
    return { ok: false, description: msg };
  }
}

async function notifyAdminDebug(text: string, env: Env): Promise<void> {
  const adminId = env.ADMIN_TG_ID;
  if (!adminId || !env.BOT_TOKEN) {
    return;
  }
  try {
    await telegramRequest(
      'sendMessage',
      {
        chat_id: adminId,
        text: String(text).substring(0, 4000),
      },
      env,
    );
  } catch {
    // как notifyAdminDebug в Code.gs
  }
}

export async function moderationKeyboard(
  listingId: string,
  portfolioCount: number,
  userTgId: number,
  env: Env,
): Promise<InlineKeyboardMarkup> {
  const rows: InlineKeyboardButton[][] = [
    [
      { text: '✅ Разместить', callback_data: `approve_${listingId}` },
      { text: '❌ Отклонить', callback_data: `reject_${listingId}` },
    ],
    [
      { text: '🚫 Забанить пользователя', callback_data: `ban_user_${userTgId}` },
    ],
  ];

  if (portfolioCount > 0) {
    const config = getConfig(env);
    const { token, exp } = await createAdminPortfolioToken(listingId, env);
    const url = getMiniAppPortfolioUrl(config.miniAppUrl, listingId, token, exp);
    rows.push([
      {
        text: '🖼 Просмотреть портфолио',
        web_app: { url },
      },
    ]);
  }

  return { inline_keyboard: rows };
}

export function contactBanKeyboard(userTgId: number): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: '🚫 Забанить пользователя', callback_data: `ban_user_${userTgId}` }],
    ],
  };
}

export function banConfirmKeyboard(
  userTgId: number,
  sourceMessageId: number,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: 'Забанить', callback_data: `ban_ok_${userTgId}_${sourceMessageId}` },
        { text: 'Простить', callback_data: `ban_no_${sourceMessageId}` },
      ],
    ],
  };
}

export function pinModerationKeyboard(
  listingId: string,
  pinDuration: string,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        {
          text: '📌 Закрепить',
          callback_data: `pin_approve_${listingId}_${pinDuration}`,
        },
        { text: '❌ Отклонить', callback_data: `pin_reject_${listingId}` },
      ],
    ],
  };
}

async function sendMessageRaw(
  chatId: number | string,
  text: string,
  replyMarkup: TelegramReplyMarkup | null | undefined,
  env: Env,
): Promise<TelegramApiResponse> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  return telegramRequest('sendMessage', payload, env);
}

export async function sendMessage(
  chatId: number | string,
  text: string,
  replyMarkup: TelegramReplyMarkup | null | undefined,
  env: Env,
): Promise<number | null> {
  if (replyMarkup) {
    const withKb = await sendMessageRaw(chatId, text, replyMarkup, env);
    if (withKb.ok && withKb.result?.message_id != null) {
      return withKb.result.message_id;
    }
    const errText = withKb.description ?? 'unknown';
    await logAction(0, 'error', `sendMessage keyboard failed: ${errText}`, env.DB);
    await notifyAdminDebug(`sendMessage keyboard error: ${errText}`, env);

    const plain = await sendMessageRaw(chatId, text, null, env);
    if (plain.ok && plain.result?.message_id != null) {
      return plain.result.message_id;
    }
    return null;
  }

  const result = await sendMessageRaw(chatId, text, null, env);
  return result.ok && result.result?.message_id != null
    ? result.result.message_id
    : null;
}

export async function sendPhoto(
  chatId: number | string,
  fileId: string,
  caption: string,
  replyMarkup: TelegramReplyMarkup | null | undefined,
  env: Env,
): Promise<number | null> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    photo: fileId,
    caption,
  };
  if (replyMarkup) {
    payload.reply_markup = replyMarkup;
  }
  const result = await telegramRequest('sendPhoto', payload, env);
  if (!result.ok) {
    await logAction(
      0,
      'error',
      `sendPhoto failed: ${result.description ?? 'unknown'}`,
      env.DB,
    );
  }
  return result.ok && result.result?.message_id != null
    ? result.result.message_id
    : null;
}

export async function editMessageReplyMarkup(
  chatId: number | string,
  messageId: number,
  replyMarkup: InlineKeyboardMarkup | null | undefined,
  env: Env,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  };
  const result = await telegramRequest('editMessageReplyMarkup', payload, env);
  if (!result.ok) {
    await logAction(
      0,
      'error',
      `editMessageReplyMarkup failed: ${result.description ?? 'unknown'}`,
      env.DB,
    );
  }
}

export async function editMessageText(
  chatId: number | string,
  messageId: number,
  text: string,
  replyMarkup: InlineKeyboardMarkup | null | undefined,
  env: Env,
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    message_id: messageId,
    text,
    reply_markup: replyMarkup ?? { inline_keyboard: [] },
  };
  const result = await telegramRequest('editMessageText', payload, env);
  if (!result.ok) {
    await logAction(
      0,
      'error',
      `editMessageText failed: ${result.description ?? 'unknown'}`,
      env.DB,
    );
  }
}

/** Active admins (in `admins`, not banned in `users`). Falls back to env ADMIN_TG_ID. */
export async function getAdminIds(db: D1Database, env: Env): Promise<number[]> {
  const fallbackId = Number(env.ADMIN_TG_ID);
  if (fallbackId > 0) {
    await ensureGrandAdmin(db, fallbackId);
  }

  const { results } = await db
    .prepare('SELECT tg_id FROM admins')
    .all<{ tg_id: number }>();

  const ids: number[] = [];
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const tgId = results[i].tg_id;
      if (await isAdmin(db, tgId)) {
        ids.push(tgId);
      }
    }
  }

  if (ids.length === 0 && fallbackId > 0) {
    ids.push(fallbackId);
  }

  return ids;
}

export async function sendModerationToAdmins(
  db: D1Database,
  env: Env,
  text: string,
  replyMarkup?: TelegramReplyMarkup | null,
): Promise<number[]> {
  const adminIds = await getAdminIds(db, env);
  const messageIds: number[] = [];
  for (let i = 0; i < adminIds.length; i++) {
    const msgId = await sendMessage(adminIds[i], text, replyMarkup ?? null, env);
    if (msgId != null) {
      messageIds.push(msgId);
    }
  }
  return messageIds;
}

export async function sendModerationPhotoToAdmins(
  db: D1Database,
  env: Env,
  fileId: string,
  caption: string,
  replyMarkup?: TelegramReplyMarkup | null,
): Promise<number[]> {
  const adminIds = await getAdminIds(db, env);
  const messageIds: number[] = [];
  for (let i = 0; i < adminIds.length; i++) {
    const msgId = await sendPhoto(
      adminIds[i],
      fileId,
      caption,
      replyMarkup ?? null,
      env,
    );
    if (msgId != null) {
      messageIds.push(msgId);
    }
  }
  return messageIds;
}

/** Plain text to every active admin (e.g. ban confirmation). */
export async function sendToAllAdmins(
  db: D1Database,
  env: Env,
  text: string,
): Promise<void> {
  await sendModerationToAdmins(db, env, text, null);
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text: string | undefined,
  env: Env,
): Promise<void> {
  const payload: Record<string, unknown> = {
    callback_query_id: callbackQueryId,
  };
  if (text != null && text !== '') {
    payload.text = text;
  }
  const result = await telegramRequest('answerCallbackQuery', payload, env);
  if (!result.ok) {
    await logAction(
      0,
      'error',
      `answerCallbackQuery failed: ${result.description ?? 'unknown'}`,
      env.DB,
    );
  }
}
