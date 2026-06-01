import type { Env } from '../env';
import { validateMiniAppRequest } from '../utils/auth';
import { rejectIfBanned } from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import {
  checkTelegramVerifyRateLimit,
  incrementTelegramVerifyRateLimit,
  TELEGRAM_VERIFY_ERROR_MESSAGES,
} from '../utils/telegram-listing-verify';
import { verifyTelegramContactForOwner } from '../utils/telegram-contact';

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
