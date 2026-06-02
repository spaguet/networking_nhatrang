import type { Env } from '../env';
import { verifyTelegramContactForOwner } from './telegram-contact';

const VERIFY_RATE_LIMIT_MAX = 10;
const VERIFY_RATE_LIMIT_TTL_SEC = 3600;

export const TELEGRAM_VERIFY_ERROR_MESSAGES: Record<string, string> = {
  invalid_telegram_username:
    'Укажите ник латиницей: буквы, цифры, подчёркивание. От 5 до 32 символов, например @ivan_spec.',
  telegram_contact_not_found:
    'Такой @ник в Telegram не найден. Проверьте написание.',
  telegram_username_mismatch:
    'Этот @ник принадлежит другому аккаунту. Введите свой ник из профиля Telegram.',
  telegram_verify_required:
    'Нажмите «Проверить Telegram-ник» перед отправкой анкеты.',
  telegram_verify_rate_limit:
    'Слишком много проверок. Попробуйте через час.',
};

function verifyRateLimitKey(tgId: number): string {
  const hourUtc = new Date().toISOString().slice(0, 13);
  return `tg_verify_rl:${tgId}:${hourUtc}`;
}

export async function checkTelegramVerifyRateLimit(
  tgId: number,
  env: Env,
): Promise<{ allowed: boolean }> {
  const key = verifyRateLimitKey(tgId);
  const raw = await env.CACHE.get(key);
  const count = raw ? Number(raw) : 0;
  return { allowed: count < VERIFY_RATE_LIMIT_MAX };
}

export async function incrementTelegramVerifyRateLimit(
  tgId: number,
  env: Env,
): Promise<void> {
  const key = verifyRateLimitKey(tgId);
  const raw = await env.CACHE.get(key);
  const count = raw ? Number(raw) : 0;
  await env.CACHE.put(key, String(count + 1), {
    expirationTtl: VERIFY_RATE_LIMIT_TTL_SEC,
  });
}

export type TelegramListingVerifyFields = {
  telegram_username_verified: string | null;
  telegram_verified_at: string | null;
};

export type EnsureTelegramListingContactResult =
  | ({ ok: true } & TelegramListingVerifyFields)
  | { ok: false; error: string; message: string };

/** Verify Telegram contact for listing submit; returns DB fields or error. */
export async function ensureTelegramListingContact(
  env: Env,
  tgId: number,
  contactType: string,
  contacts: string,
  initData?: string,
): Promise<EnsureTelegramListingContactResult> {
  if (contactType !== 'Telegram') {
    return {
      ok: true,
      telegram_username_verified: null,
      telegram_verified_at: null,
    };
  }

  const result = await verifyTelegramContactForOwner(env, tgId, contacts, initData);
  if (!result.ok) {
    return {
      ok: false,
      error: result.error,
      message: TELEGRAM_VERIFY_ERROR_MESSAGES[result.error] ?? result.error,
    };
  }

  return {
    ok: true,
    telegram_username_verified: result.username,
    telegram_verified_at: new Date().toISOString(),
  };
}
