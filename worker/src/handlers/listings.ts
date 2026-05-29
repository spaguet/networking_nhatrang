import { CATEGORIES, DEFAULT_AVATAR_EMOJI } from '../config';
import type { Env } from '../env';
import {
  moderationKeyboard,
  sendMessage,
} from '../services/telegram-api';
import {
  validateInitData,
  validateMiniAppRequest,
} from '../utils/auth';
import { decodeDescriptionNewlines } from '../utils/description';
import {
  generateId,
  getUserListingMode,
  logAction,
} from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import { validateListingForm } from '../utils/validation';
import { saveAdminLink } from './telegram';

/** Worker: BOT_TOKEN + D1 only (not GAS SHEET_ID). */
function checkServerConfig(env: Env): Response | null {
  if (!env.BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'server_config' });
  }
  return null;
}

function checkSecret(body: Record<string, unknown>, env: Env): Response | null {
  if (env.WEBAPP_SECRET && body.secret !== env.WEBAPP_SECRET) {
    return jsonResponse({ ok: false, error: 'invalid_secret' });
  }
  return null;
}

function toIsoOrEmpty(value: string | null | undefined): string {
  if (!value) {
    return '';
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

interface CatalogListingRow {
  listing_id: string;
  display_name: string;
  category: string;
  description: string;
  experience: string | null;
  contact_type: string | null;
  contacts: string;
  avatar_emoji: string | null;
  created_at: string | null;
  expires_at: string | null;
  pin_status: string | null;
  pinned_at: string | null;
  pin_expires_at: string | null;
  has_portfolio: number;
  portfolio_count: number;
}

function mapCatalogListing(row: CatalogListingRow) {
  const portfolioCount = Number(row.portfolio_count ?? 0);
  return {
    listing_id: row.listing_id,
    display_name: row.display_name,
    category: row.category,
    description: decodeDescriptionNewlines(row.description),
    experience: row.experience != null ? String(row.experience) : '',
    contact_type: row.contact_type != null ? String(row.contact_type) : '',
    contacts: row.contacts,
    avatar_emoji: row.avatar_emoji ? String(row.avatar_emoji) : DEFAULT_AVATAR_EMOJI,
    created_at: toIsoOrEmpty(row.created_at),
    expires_at: toIsoOrEmpty(row.expires_at),
    pin_status: row.pin_status ? String(row.pin_status) : 'regular',
    pinned_at: row.pinned_at ? String(row.pinned_at) : '',
    pin_expires_at: row.pin_expires_at ? String(row.pin_expires_at) : '',
    has_portfolio: portfolioCount > 0,
    portfolio_count: portfolioCount,
  };
}

interface MyListingRow extends CatalogListingRow {
  status: string;
  payment_status: string;
  submitted_at: string;
}

function mapMyListing(row: MyListingRow) {
  return {
    ...mapCatalogListing(row),
    status: row.status,
    payment_status: row.payment_status,
    submitted_at: toIsoOrEmpty(row.submitted_at),
  };
}

export async function handleGetListings(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const secretErr = checkSecret(body, env);
    if (secretErr) {
      return secretErr;
    }

    const initData = String(body.initData ?? '');
    if (initData && !(await validateInitData(initData, env.BOT_TOKEN))) {
      return jsonResponse({ ok: false, error: 'Invalid_initData' });
    }

    const category = String(body.category ?? '').trim();
    if (!category || !(CATEGORIES as readonly string[]).includes(category)) {
      return jsonResponse({ ok: false, error: 'invalid_category' });
    }

    const { results } = await env.DB.prepare(
      `SELECT l.listing_id, l.display_name, l.category, l.description, l.experience, l.contact_type, l.contacts,
              l.avatar_emoji, l.created_at, l.expires_at, l.pin_status, l.pinned_at, l.pin_expires_at,
              EXISTS(
                SELECT 1 FROM listing_media lm
                WHERE lm.listing_id = l.listing_id AND lm.status = 'active'
              ) AS has_portfolio,
              (SELECT COUNT(*) FROM listing_media lm
               WHERE lm.listing_id = l.listing_id AND lm.status = 'active') AS portfolio_count
       FROM listings l
       WHERE l.status = 'active' AND l.category = ?
       ORDER BY CASE WHEN l.pin_status = 'pinned' THEN 1 ELSE 0 END DESC,
                l.pinned_at DESC,
                l.created_at DESC`,
    )
      .bind(category)
      .all<CatalogListingRow>();

    const listings = (results ?? []).map(mapCatalogListing);

    const tgId = Number(body.tg_id) || 0;
    await logAction(
      tgId,
      'get_listings',
      `${category} → ${listings.length} found`,
      env.DB,
    );

    return jsonResponse({ ok: true, listings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleGetListings: ${msg}`, env.DB);
    return jsonResponse({
      ok: false,
      error: 'server_error',
      message: 'Ошибка сервера',
    });
  }
}

export async function handleGetMyListings(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await validateMiniAppRequest(body, env, 'Invalid_initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const tgId = Number(body.tg_id);
    if (!tgId) {
      return jsonResponse({ ok: false, error: 'invalid_tg_id' });
    }

    const { results } = await env.DB.prepare(
      `SELECT l.listing_id, l.display_name, l.category, l.description, l.experience, l.contact_type, l.contacts,
              l.avatar_emoji, l.created_at, l.expires_at, l.pin_status, l.pinned_at, l.pin_expires_at,
              l.status, l.payment_status, l.submitted_at,
              EXISTS(
                SELECT 1 FROM listing_media lm
                WHERE lm.listing_id = l.listing_id AND lm.status IN ('pending', 'active')
              ) AS has_portfolio,
              (SELECT COUNT(*) FROM listing_media lm
               WHERE lm.listing_id = l.listing_id AND lm.status IN ('pending', 'active')) AS portfolio_count
       FROM listings l
       WHERE l.tg_id = ?
       ORDER BY CASE l.status
         WHEN 'active' THEN 0
         WHEN 'on_moderation' THEN 1
         WHEN 'archived' THEN 2
         WHEN 'rejected' THEN 3
         ELSE 9
       END,
       l.submitted_at DESC`,
    )
      .bind(tgId)
      .all<MyListingRow>();

    const listings = (results ?? []).map(mapMyListing);

    return jsonResponse({ ok: true, listings });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleGetMyListings: ${msg}`, env.DB);
    return jsonResponse({
      ok: false,
      error: 'server_error',
      message: 'Ошибка сервера',
    });
  }
}

export async function handleSubmitListing(
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
    const username = String(body.username ?? '');
    const firstName = String(body.first_name ?? '');

    const formResult = validateListingForm(body);
    if (formResult.error !== null) {
      return jsonResponse({
        ok: false,
        error: formResult.error,
        message: formResult.message,
      });
    }
    const form = formResult;

    const mode = await getUserListingMode(tgId, username, firstName, env);
    if (mode.paid_mode) {
      return jsonResponse({
        ok: false,
        error: 'use_paid_flow',
        message: mode.banner,
        paid_mode: true,
      });
    }

    const listingId = generateId(tgId);
    const now = new Date().toISOString();
    const portfolioEnabled = body.portfolio_enabled === true;

    await env.DB.prepare(
      `INSERT INTO listings (
        listing_id, tg_id, display_name, category, description, experience,
        contact_type, contacts, status, payment_status, created_at, expires_at,
        submitted_at, avatar_emoji, pin_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'on_moderation', 'free', NULL, NULL, ?, ?, 'regular')`,
    )
      .bind(
        listingId,
        tgId,
        form.display_name,
        form.category,
        form.description,
        form.experience,
        form.contact_type,
        form.contacts,
        now,
        form.avatar_emoji,
      )
      .run();

    if (!portfolioEnabled) {
      const adminText =
        '📋 МОДЕРАЦИЯ АНКЕТЫ\n' +
        `listing_id: ${listingId}\n` +
        `Пользователь ID: ${tgId}\n` +
        'Оплата: Бесплатное (первое)\n\n' +
        `Имя: ${form.display_name}\n` +
        `Категория: ${form.category}\n` +
        `Опыт/стаж: ${form.experience}\n` +
        `Описание: ${decodeDescriptionNewlines(form.description)}\n` +
        `Тип контакта: ${form.contact_type}\n` +
        `Контакты: ${form.contacts}\n\n` +
        '↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.';

      const adminMsgId = await sendMessage(
        env.ADMIN_TG_ID,
        adminText,
        moderationKeyboard(listingId),
        env,
      );
      if (adminMsgId) {
        await saveAdminLink(adminMsgId, tgId, 'listing', listingId, env);
      }

      await sendMessage(
        tgId,
        'Ваше мини-резюме будет размещено после проверки модератором.',
        null,
        env,
      );
    }

    await logAction(tgId, 'submit_form', listingId, env.DB);

    if (portfolioEnabled) {
      return jsonResponse({
        ok: true,
        listing_id: listingId,
        message: 'Загрузка фото…',
        deferred_notify: true,
      });
    }

    return jsonResponse({
      ok: true,
      listing_id: listingId,
      message: 'Анкета отправлена на модерацию',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(Number(body.tg_id) || 0, 'error', `handleSubmitListing: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleArchiveListing(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await validateMiniAppRequest(body, env, 'Invalid_initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const tgId = Number(body.tg_id);
    const listingId = String(body.listing_id ?? '').trim();

    if (!tgId || !listingId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const existing = await env.DB.prepare(
      'SELECT tg_id, status FROM listings WHERE listing_id = ?',
    )
      .bind(listingId)
      .first<{ tg_id: number; status: string }>();

    if (!existing) {
      return jsonResponse({
        ok: false,
        error: 'not_found',
        message: 'Анкета не найдена',
      });
    }

    if (existing.tg_id !== tgId) {
      return jsonResponse({
        ok: false,
        error: 'forbidden',
        message: 'Нет доступа',
      });
    }

    if (existing.status !== 'active') {
      return jsonResponse({
        ok: false,
        error: 'wrong_status',
        message: 'Можно архивировать только активное объявление',
      });
    }

    await env.DB.prepare(
      `UPDATE listings SET status = 'archived' WHERE listing_id = ? AND tg_id = ? AND status = 'active'`,
    )
      .bind(listingId, tgId)
      .run();

    await logAction(tgId, 'archive_manual', listingId, env.DB);

    return jsonResponse({
      ok: true,
      message: 'Анкета перемещена в архив',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleArchiveListing: ${msg}`, env.DB);
    return jsonResponse({
      ok: false,
      error: 'server_error',
      message: 'Ошибка сервера',
    });
  }
}
