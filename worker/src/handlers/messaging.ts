import type { Env } from '../env';
import { validateMiniAppRequest } from '../utils/auth';
import { rejectIfBanned } from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import {
  checkTelegramVerifyRateLimit,
  incrementTelegramVerifyRateLimit,
  TELEGRAM_VERIFY_ERROR_MESSAGES,
} from '../utils/telegram-listing-verify';
import {
  buildTelegramChatUrl,
  parseTelegramUsername,
  verifyTelegramContactForOwner,
} from '../utils/telegram-contact';

function checkServerConfig(env: Env): Response | null {
  if (!env.BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'server_config' });
  }
  return null;
}

export async function handleVerifyTelegramContact(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const tgId = Number(body.tg_id);
    if (!tgId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const contacts = String(body.contacts ?? '').trim();
    if (!contacts) {
      return jsonResponse({
        ok: false,
        error: 'invalid_telegram_username',
        message: TELEGRAM_VERIFY_ERROR_MESSAGES.invalid_telegram_username,
      });
    }

    const rate = await checkTelegramVerifyRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({
        ok: false,
        error: 'telegram_verify_rate_limit',
        message: TELEGRAM_VERIFY_ERROR_MESSAGES.telegram_verify_rate_limit,
      });
    }

    const result = await verifyTelegramContactForOwner(env, tgId, contacts);
    await incrementTelegramVerifyRateLimit(tgId, env);

    if (!result.ok) {
      return jsonResponse({
        ok: false,
        error: result.error,
        message: TELEGRAM_VERIFY_ERROR_MESSAGES[result.error] ?? result.error,
      });
    }

    return jsonResponse({ ok: true, username: result.username });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleVerifyTelegramContact:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

interface ResolveListingRow {
  listing_id: string;
  tg_id: number;
  status: string;
  contact_type: string;
  contacts: string;
  telegram_username_verified: string | null;
  owner_username: string | null;
}

export async function handleResolveTelegramChat(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const tgId = Number(body.tg_id);
    if (!tgId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const listingId = String(body.listing_id ?? '').trim();
    if (!listingId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const row = await env.DB.prepare(
      `SELECT l.listing_id, l.tg_id, l.status, l.contact_type, l.contacts,
              l.telegram_username_verified, u.username AS owner_username
       FROM listings l
       LEFT JOIN users u ON u.tg_id = l.tg_id
       WHERE l.listing_id = ?`,
    )
      .bind(listingId)
      .first<ResolveListingRow>();

    if (!row) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }

    if (row.status !== 'active') {
      return jsonResponse({ ok: false, error: 'listing_not_active' });
    }

    if (row.contact_type !== 'Telegram') {
      return jsonResponse({ ok: false, error: 'messaging_not_available' });
    }

    if (row.tg_id === tgId) {
      return jsonResponse({ ok: false, error: 'forbidden' });
    }

    let url: string;
    try {
      const verified = row.telegram_username_verified?.trim();
      if (verified) {
        url = buildTelegramChatUrl({ username: verified, ownerTgId: row.tg_id });
      } else if (row.owner_username?.trim()) {
        url = buildTelegramChatUrl({
          username: row.owner_username,
          ownerTgId: row.tg_id,
        });
      } else {
        try {
          const parsed = parseTelegramUsername(row.contacts);
          url = buildTelegramChatUrl({ username: parsed, ownerTgId: row.tg_id });
        } catch {
          url = buildTelegramChatUrl({ ownerTgId: row.tg_id });
        }
      }
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_telegram_username' });
    }

    return jsonResponse({ ok: true, url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleResolveTelegramChat:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}
