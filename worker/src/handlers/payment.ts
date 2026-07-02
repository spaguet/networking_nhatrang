import { getConfigWithSettings } from '../config';
import type { Env } from '../env';
import { sendPhoto } from '../services/telegram-api';
import { getUserIdFromInitData, authenticateMiniAppUser } from '../utils/auth';
import {
  findQrMethodByKey,
  formatDateRu,
  generateId,
  getUserListingMode,
  isUserBanned,
  logAction,
  rejectIfBanned,
} from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import { validateListingForm } from '../utils/validation';
import { upsertSession } from './sessions';

/** Worker: BOT_TOKEN + D1 only (not GAS SHEET_ID). */
function checkServerConfig(env: Env): Response | null {
  if (!env.BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'server_config' });
  }
  return null;
}

export async function handleCheckListingStatus(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const configErr = checkServerConfig(env);
    if (configErr) {
      return configErr;
    }

    const auth = await authenticateMiniAppUser(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }
    const tgId = auth.tgId;
    const username = String(body.username || '');
    const firstName = String(body.first_name || '');

    if (await isUserBanned(tgId, env.DB)) {
      return jsonResponse({
        ok: true,
        banned: true,
        has_listing: false,
        paid_mode: false,
        can_submit_free: false,
        banner: '',
      });
    }

    const mode = await getUserListingMode(tgId, username, firstName, env);

    const response: Record<string, unknown> = {
      ok: true,
      has_listing: !!mode.blocking,
      paid_mode: mode.paid_mode,
      can_submit_free: mode.can_submit_free,
      banner: mode.banner,
      banned: false,
    };

    if (mode.blocking) {
      response.listing = {
        status: mode.blocking.status,
        payment_status: mode.blocking.payment_status,
        display_name: mode.blocking.display_name,
        category: mode.blocking.category,
        expires_at: mode.blocking.expires_at
          ? formatDateRu(mode.blocking.expires_at)
          : '',
      };
    }

    return jsonResponse(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(
      getUserIdFromInitData(String(body.initData ?? '')) || 0,
      'error',
      `handleCheckListingStatus: ${msg}`,
      env.DB,
    );
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleSelectPaymentMethod(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const configErr = checkServerConfig(env);
    if (configErr) {
      return configErr;
    }

    const auth = await authenticateMiniAppUser(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const config = await getConfigWithSettings(env);
    const tgId = auth.tgId;
    const username = String(body.username || '');
    const firstName = String(body.first_name || '');

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const formResult = validateListingForm(body);
    if (formResult.error !== null) {
      return jsonResponse({
        ok: false,
        error: formResult.error,
        message: formResult.message,
        ...(formResult.stop_word ? { stop_word: formResult.stop_word } : {}),
      });
    }
    const form = formResult;

    const mode = await getUserListingMode(tgId, username, firstName, env);
    if (!mode.paid_mode) {
      return jsonResponse({
        ok: false,
        error: 'free_listing_available',
        message:
          'Доступно бесплатное размещение — отправьте анкету без оплаты.',
      });
    }

    const methodKey = String(body.payment_method || '').trim().toLowerCase();
    const method = findQrMethodByKey(methodKey);
    if (!method) {
      return jsonResponse({ ok: false, error: 'invalid_payment_method' });
    }

    const fileId = config.qr[method.methodKey];
    if (!fileId) {
      return jsonResponse({
        ok: false,
        error: 'qr_not_configured',
        message:
          'QR для этого способа оплаты ещё не настроен. Напишите администратору через /start.',
      });
    }

    const listingId = generateId(tgId);
    const draft = {
      type: 'paid_listing',
      listing_id: listingId,
      display_name: form.display_name,
      category: form.category,
      description: form.description,
      experience: form.experience,
      contact_type: form.contact_type,
      contacts: form.contacts,
      avatar_emoji: form.avatar_emoji,
      payment_method: methodKey,
      username,
      first_name: firstName,
      keywords: form.keywords,
    };

    await upsertSession(tgId, 'await_payment_proof', JSON.stringify(draft), env);

    const amountText =
      methodKey === 'vnd'
        ? `Стоимость размещения ${config.paymentAmountVnd}. После оплаты по QR отправьте, пожалуйста, чек об оплате в сообщении боту.`
        : `Стоимость размещения ${config.paymentAmountCrypto}. После оплаты по QR отправьте, пожалуйста, чек об оплате в сообщении боту.`;

    await sendPhoto(tgId, fileId, amountText, null, env);

    await logAction(tgId, 'select_payment', `${methodKey}|${listingId}`, env.DB);

    return jsonResponse({
      ok: true,
      message:
        'QR-код отправлен в чат с ботом. После оплаты пришлите скриншот чека в ответ боту.',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(
      getUserIdFromInitData(String(body.initData ?? '')) || 0,
      'error',
      `handleSelectPaymentMethod: ${msg}`,
      env.DB,
    );
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}
