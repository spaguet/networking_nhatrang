import { getConfigWithSettings } from '../config';
import type { Env } from '../env';
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  sendMessage,
  sendPhoto,
} from '../services/telegram-api';
import { getUserIdFromInitData, validateInitData, authenticateMiniAppUser } from '../utils/auth';
import {
  findQrMethodByKey,
  formatDateRu,
  getPinDurationLabel,
  getPinDurationShortLabel,
  getPinExpiresDate,
  getPinPriceByDuration,
  logAction,
  paymentMethodLabel,
  rejectIfBanned,
} from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import { upsertSession } from './sessions';

/** Worker: BOT_TOKEN + D1 only (not GAS SHEET_ID). */
function checkServerConfig(env: Env): Response | null {
  if (!env.BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'server_config' });
  }
  return null;
}

export async function handleGetPinPrices(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const configErr = checkServerConfig(env);
    if (configErr) {
      return configErr;
    }

    const initData = String(body.initData ?? '');
    if (initData && !(await validateInitData(initData, env.BOT_TOKEN))) {
      return jsonResponse({ ok: false, error: 'Invalid_initData' });
    }

    const config = await getConfigWithSettings(env);
    return jsonResponse({
      ok: true,
      week: {
        vnd: config.pinPriceWeekVnd,
        crypto: config.pinPriceWeekCrypto,
      },
      month: {
        vnd: config.pinPriceMonthVnd,
        crypto: config.pinPriceMonthCrypto,
      },
      lifetime: {
        vnd: config.pinPriceLifetimeVnd,
        crypto: config.pinPriceLifetimeCrypto,
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(
      getUserIdFromInitData(String(body.initData ?? '')) || 0,
      'error',
      `handleGetPinPrices: ${msg}`,
      env.DB,
    );
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleSelectPinPaymentMethod(
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
    const listingId = String(body.listing_id ?? '').trim();
    const pinDuration = String(body.pin_duration ?? '').trim().toLowerCase();
    const methodKey = String(body.payment_method ?? '').trim().toLowerCase();

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    if (!listingId) {
      return jsonResponse({ ok: false, error: 'missing_listing_id' });
    }

    if (
      pinDuration !== 'week' &&
      pinDuration !== 'month' &&
      pinDuration !== 'lifetime'
    ) {
      return jsonResponse({ ok: false, error: 'invalid_pin_duration' });
    }

    const listing = await env.DB.prepare(
      'SELECT tg_id, status, pin_status FROM listings WHERE listing_id = ?',
    )
      .bind(listingId)
      .first<{ tg_id: number; status: string; pin_status: string | null }>();

    if (!listing) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }

    const pinStatus = String(listing.pin_status ?? '').trim() || 'regular';

    if (listing.status !== 'active') {
      return jsonResponse({ ok: false, error: 'not_active' });
    }

    if (listing.tg_id !== tgId) {
      return jsonResponse({ ok: false, error: 'forbidden' });
    }

    if (pinStatus === 'pinned') {
      return jsonResponse({
        ok: false,
        error: 'already_pinned',
        message: 'Эта карточка уже закреплена',
      });
    }

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

    const price = getPinPriceByDuration(config, pinDuration, methodKey);
    const label = getPinDurationShortLabel(pinDuration);
    const draft = JSON.stringify({
      listing_id: listingId,
      pin_duration: pinDuration,
      payment_method: methodKey,
      price_label: price,
    });

    await upsertSession(tgId, 'await_pin_proof', draft, env, 'pin');

    const qrCaption =
      '📌 Оплата закрепления\n' +
      'Срок: ' +
      label +
      '\n' +
      'Способ: ' +
      paymentMethodLabel(methodKey) +
      '\n' +
      'Сумма: ' +
      price +
      '\n\n' +
      'После оплаты пришлите скриншот чека в ответ боту.';

    await sendPhoto(tgId, fileId, qrCaption, null, env);
    await sendMessage(
      tgId,
      '⏳ Ожидаем скриншот оплаты. В течение 24 часов ваша карточка будет закреплена.',
      null,
      env,
    );

    await logAction(tgId, 'select_pin_payment', `${pinDuration}|${listingId}`, env.DB);

    return jsonResponse({
      ok: true,
      message: 'QR отправлен в чат с ботом',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(
      getUserIdFromInitData(String(body.initData ?? '')) || 0,
      'error',
      `handleSelectPinPaymentMethod: ${msg}`,
      env.DB,
    );
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function pinApproveListing(
  listingId: string,
  pinDuration: string,
  adminChatId: number | string,
  messageId: number,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  try {
    const listing = await env.DB.prepare(
      'SELECT tg_id FROM listings WHERE listing_id = ?',
    )
      .bind(listingId)
      .first<{ tg_id: number }>();

    if (!listing) {
      await answerCallbackQuery(callbackQueryId, 'Анкета не найдена', env);
      return;
    }

    const today = new Date().toISOString();
    const pinExpiresAt = getPinExpiresDate(pinDuration);

    if (pinDuration === 'lifetime') {
      await env.DB.prepare(
        `UPDATE listings
         SET pin_status = 'pinned', pinned_at = ?, pin_expires_at = ?, expires_at = 'lifetime'
         WHERE listing_id = ?`,
      )
        .bind(today, pinExpiresAt, listingId)
        .run();
    } else {
      await env.DB.prepare(
        `UPDATE listings
         SET pin_status = 'pinned', pinned_at = ?, pin_expires_at = ?
         WHERE listing_id = ?`,
      )
        .bind(today, pinExpiresAt, listingId)
        .run();
    }

    const label = getPinDurationLabel(pinDuration);
    let userText = '📌 Ваша карточка закреплена в каталоге!\nСрок: ' + label;
    if (pinDuration === 'lifetime') {
      userText += '\nРазмещение бессрочное — анкета не будет снята через 30 дней.';
    } else {
      userText += '\nДействует до: ' + formatDateRu(pinExpiresAt);
    }

    await sendMessage(listing.tg_id, userText, null, env);
    await editMessageReplyMarkup(adminChatId, messageId, null, env);
    await answerCallbackQuery(callbackQueryId, 'Закреплено 📌', env);
    await logAction(
      listing.tg_id,
      'pin_approved',
      `${listingId}_${pinDuration}`,
      env.DB,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `pinApproveListing: ${msg}`, env.DB);
    await answerCallbackQuery(callbackQueryId, 'Ошибка сервера', env);
  }
}

export async function pinRejectListing(
  listingId: string,
  adminChatId: number | string,
  messageId: number,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  try {
    const listing = await env.DB.prepare(
      'SELECT tg_id FROM listings WHERE listing_id = ?',
    )
      .bind(listingId)
      .first<{ tg_id: number }>();

    if (!listing) {
      await answerCallbackQuery(callbackQueryId, 'Анкета не найдена', env);
      return;
    }

    await sendMessage(
      listing.tg_id,
      '❌ Запрос на закрепление отклонён.\n' +
        'Если вы совершили оплату — свяжитесь с администратором для возврата.',
      null,
      env,
    );
    await editMessageReplyMarkup(adminChatId, messageId, null, env);
    await answerCallbackQuery(callbackQueryId, 'Отклонено ❌', env);
    await logAction(listing.tg_id, 'pin_rejected', listingId, env.DB);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `pinRejectListing: ${msg}`, env.DB);
    await answerCallbackQuery(callbackQueryId, 'Ошибка сервера', env);
  }
}
