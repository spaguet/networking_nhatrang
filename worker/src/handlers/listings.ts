import { CATEGORIES } from '../config';
import type { Env } from '../env';
import {
  moderationKeyboard,
  sendMessage,
  sendModerationToAdmins,
} from '../services/telegram-api';
import {
  authenticateMiniAppUser,
  getUserIdFromInitData,
  validateInitData,
} from '../utils/auth';
import { decodeDescriptionNewlines } from '../utils/description';
import {
  type CatalogListingRow,
  mapCatalogListing,
  toIsoOrEmpty,
} from '../utils/catalog-listing';
import {
  formatKeywordsModerationLine,
  serializeKeywords,
} from '../utils/keywords';
import {
  generateId,
  getUserListingMode,
  logAction,
  rejectIfBanned,
} from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import { ensureTelegramListingContact } from '../utils/telegram-listing-verify';
import { type ListingFormFields, validateListingForm } from '../utils/validation';
import { cleanupPortfolioOnReject } from '../services/portfolio-db';
import { purgeFavoritesForListing } from './favorites';
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

export { mapCatalogListing } from '../utils/catalog-listing';

interface MyListingRow extends CatalogListingRow {
  status: string;
  payment_status: string;
  submitted_at: string;
  edits_remaining?: number | null;
  has_edit_pending?: number;
  edit_draft_id?: string | null;
  edit_draft_needs_portfolio?: number;
}

interface ActiveParentRow {
  listing_id: string;
  tg_id: number;
  payment_status: string;
  edits_remaining: number | null;
}

function mapMyListing(row: MyListingRow) {
  const base = {
    ...mapCatalogListing(row),
    status: row.status,
    payment_status: row.payment_status,
    submitted_at: toIsoOrEmpty(row.submitted_at),
  };

  if (row.status !== 'active') {
    return base;
  }

  return {
    ...base,
    edits_remaining: row.edits_remaining ?? 3,
    has_edit_pending: Boolean(row.has_edit_pending),
    edit_draft_id: row.edit_draft_id ?? null,
    edit_draft_needs_portfolio: Boolean(row.edit_draft_needs_portfolio),
  };
}

function formatEditPaymentLabel(paymentStatus: string): string {
  return paymentStatus === 'paid' ? 'Платное' : 'Бесплатное';
}

export function buildEditModerationAdminText(
  draftId: string,
  parentId: string,
  tgId: number,
  paymentStatus: string,
  form: ListingFormFields,
): string {
  return (
    '✏️ РЕДАКТИРОВАНИЕ АНКЕТЫ\n' +
    `draft_id: ${draftId}\n` +
    `parent_id (в каталоге): ${parentId}\n` +
    `Пользователь ID: ${tgId}\n` +
    `Оплата: ${formatEditPaymentLabel(paymentStatus)}\n\n` +
    `Имя: ${form.display_name}\n` +
    `Категория: ${form.category}\n` +
    `Опыт/стаж: ${form.experience}\n` +
    `Описание: ${decodeDescriptionNewlines(form.description)}\n` +
    `Тип контакта: ${form.contact_type}\n` +
    `Контакты: ${form.contacts}\n` +
    `${formatKeywordsModerationLine(form.keywords)}\n\n` +
    `⚠️ До одобрения в каталоге показывается старая версия (${parentId}).\n\n` +
    '↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.'
  );
}

/** Remove edit_pending drafts linked to an archived/deleted parent listing. */
export async function cleanupEditPendingForParent(
  parentListingId: string,
  tgId: number,
  env: Env,
): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT listing_id FROM listings
     WHERE status = 'edit_pending' AND replaces_listing_id = ?`,
  )
    .bind(parentListingId)
    .all<{ listing_id: string }>();

  for (const row of results ?? []) {
    const draftId = String(row.listing_id);
    await cleanupPortfolioOnReject(draftId, tgId, env);
    await env.DB.prepare('DELETE FROM listings WHERE listing_id = ?').bind(draftId).run();
  }
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
              l.avatar_emoji, l.created_at, l.expires_at, l.pin_status, l.pinned_at, l.pin_expires_at, l.keywords,
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

    const auth = await authenticateMiniAppUser(body, env, 'Invalid_initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }
    const tgId = auth.tgId;

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const { results } = await env.DB.prepare(
      `SELECT l.listing_id, l.display_name, l.category, l.description, l.experience, l.contact_type, l.contacts,
              l.avatar_emoji, l.created_at, l.expires_at, l.pin_status, l.pinned_at, l.pin_expires_at, l.keywords,
              l.status, l.payment_status, l.submitted_at,
              EXISTS(
                SELECT 1 FROM listing_media lm
                WHERE lm.listing_id = l.listing_id AND lm.status IN ('pending', 'active')
              ) AS has_portfolio,
              (SELECT COUNT(*) FROM listing_media lm
               WHERE lm.listing_id = l.listing_id AND lm.status IN ('pending', 'active')) AS portfolio_count,
              COALESCE(l.edits_remaining, 3) AS edits_remaining,
              EXISTS (
                SELECT 1 FROM listings d
                WHERE d.replaces_listing_id = l.listing_id AND d.status = 'edit_pending'
              ) AS has_edit_pending,
              (SELECT d.listing_id FROM listings d
               WHERE d.replaces_listing_id = l.listing_id AND d.status = 'edit_pending'
               LIMIT 1) AS edit_draft_id,
              CASE WHEN EXISTS (
                SELECT 1 FROM listings d
                WHERE d.replaces_listing_id = l.listing_id AND d.status = 'edit_pending'
              ) AND NOT EXISTS (
                SELECT 1 FROM listing_media lm
                INNER JOIN listings d ON d.listing_id = lm.listing_id
                WHERE d.replaces_listing_id = l.listing_id AND d.status = 'edit_pending'
              ) THEN 1 ELSE 0 END AS edit_draft_needs_portfolio
       FROM listings l
       WHERE l.tg_id = ? AND l.status != 'edit_pending'
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

    const auth = await authenticateMiniAppUser(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }
    const tgId = auth.tgId;
    const username = String(body.username ?? '');
    const firstName = String(body.first_name ?? '');

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

    const tgVerify = await ensureTelegramListingContact(
      env,
      tgId,
      form.contact_type,
      form.contacts,
      String(body.initData ?? ''),
    );
    if (!tgVerify.ok) {
      return jsonResponse({
        ok: false,
        error: tgVerify.error,
        message: tgVerify.message,
      });
    }

    const listingId = generateId(tgId);
    const now = new Date().toISOString();
    const portfolioEnabled = body.portfolio_enabled === true;

    await env.DB.prepare(
      `INSERT INTO listings (
        listing_id, tg_id, display_name, category, description, experience,
        contact_type, contacts, status, payment_status, created_at, expires_at,
        submitted_at, avatar_emoji, pin_status, keywords,
        telegram_username_verified, telegram_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'on_moderation', 'free', NULL, NULL, ?, ?, 'regular', ?, ?, ?)`,
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
        serializeKeywords(form.keywords),
        tgVerify.telegram_username_verified,
        tgVerify.telegram_verified_at,
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
        `Контакты: ${form.contacts}\n` +
        `${formatKeywordsModerationLine(form.keywords)}\n\n` +
        '↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.';

      const adminMsgIds = await sendModerationToAdmins(
        env.DB,
        env,
        adminText,
        await moderationKeyboard(listingId, 0, tgId, env),
      );
      for (let i = 0; i < adminMsgIds.length; i++) {
        await saveAdminLink(adminMsgIds[i], tgId, 'listing', listingId, env);
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
    await logAction(getUserIdFromInitData(String(body.initData ?? '')) || 0, 'error', `handleSubmitListing: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleSubmitListingEdit(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await authenticateMiniAppUser(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }
    const tgId = auth.tgId;
    const parentListingId = String(body.parent_listing_id ?? '').trim();

    if (!parentListingId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

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
      });
    }
    const form = formResult;

    const parent = await env.DB.prepare(
      `SELECT listing_id, tg_id, payment_status, edits_remaining
       FROM listings
       WHERE listing_id = ? AND tg_id = ? AND status = 'active'`,
    )
      .bind(parentListingId, tgId)
      .first<ActiveParentRow>();

    if (!parent) {
      return jsonResponse({
        ok: false,
        error: 'listing_not_active',
        message: 'Редактировать можно только активную анкету',
      });
    }

    const quota = parent.edits_remaining ?? 3;
    if (quota < 1) {
      return jsonResponse({
        ok: false,
        error: 'no_edits_remaining',
        message: 'Лимит редактирований исчерпан',
      });
    }

    const pendingDraft = await env.DB.prepare(
      `SELECT 1 AS ok FROM listings WHERE tg_id = ? AND status = 'edit_pending' LIMIT 1`,
    )
      .bind(tgId)
      .first<{ ok: number }>();

    if (pendingDraft) {
      return jsonResponse({
        ok: false,
        error: 'edit_already_pending',
        message: 'Дождитесь проверки предыдущих изменений',
      });
    }

    const parentContact = await env.DB.prepare(
      `SELECT contact_type, contacts FROM listings WHERE listing_id = ?`,
    )
      .bind(parentListingId)
      .first<{ contact_type: string | null; contacts: string }>();

    const contactChanged =
      !parentContact ||
      String(parentContact.contact_type || '') !== form.contact_type ||
      String(parentContact.contacts || '') !== form.contacts;

    const needsTelegramVerify =
      form.contact_type === 'Telegram' && contactChanged;

    let tgVerifyFields = {
      telegram_username_verified: null as string | null,
      telegram_verified_at: null as string | null,
    };

    if (needsTelegramVerify) {
      const tgVerify = await ensureTelegramListingContact(
        env,
        tgId,
        form.contact_type,
        form.contacts,
        String(body.initData ?? ''),
      );
      if (!tgVerify.ok) {
        return jsonResponse({
          ok: false,
          error: tgVerify.error,
          message: tgVerify.message,
        });
      }
      tgVerifyFields = {
        telegram_username_verified: tgVerify.telegram_username_verified,
        telegram_verified_at: tgVerify.telegram_verified_at,
      };
    } else if (form.contact_type === 'Telegram' && parentContact) {
      const prev = await env.DB.prepare(
        `SELECT telegram_username_verified, telegram_verified_at
         FROM listings WHERE listing_id = ?`,
      )
        .bind(parentListingId)
        .first<{
          telegram_username_verified: string | null;
          telegram_verified_at: string | null;
        }>();
      tgVerifyFields = {
        telegram_username_verified: prev?.telegram_username_verified ?? null,
        telegram_verified_at: prev?.telegram_verified_at ?? null,
      };
    }

    const draftId = generateId(tgId);
    const now = new Date().toISOString();
    const portfolioEnabled = body.portfolio_enabled === true;
    const paymentStatus = String(parent.payment_status || 'free');

    const insertStmt = env.DB.prepare(
      `INSERT INTO listings (
        listing_id, tg_id, display_name, category, description, experience,
        contact_type, contacts, status, payment_status, created_at, expires_at,
        submitted_at, avatar_emoji, pin_status, keywords, replaces_listing_id, edits_remaining,
        telegram_username_verified, telegram_verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edit_pending', ?, NULL, NULL, ?, ?, 'regular', ?, ?, NULL, ?, ?)`,
    ).bind(
      draftId,
      tgId,
      form.display_name,
      form.category,
      form.description,
      form.experience,
      form.contact_type,
      form.contacts,
      paymentStatus,
      now,
      form.avatar_emoji,
      serializeKeywords(form.keywords),
      parent.listing_id,
      tgVerifyFields.telegram_username_verified,
      tgVerifyFields.telegram_verified_at,
    );

    const updateStmt = env.DB.prepare(
      `UPDATE listings SET edits_remaining = COALESCE(edits_remaining, 3) - 1
       WHERE listing_id = ?
         AND COALESCE(edits_remaining, 3) >= 1`,
    ).bind(parent.listing_id);

    let batchResults;
    try {
      batchResults = await env.DB.batch([insertStmt, updateStmt]);
    } catch (batchErr) {
      const batchMsg = batchErr instanceof Error ? batchErr.message : String(batchErr);
      if (batchMsg.includes('UNIQUE constraint failed')) {
        return jsonResponse({
          ok: false,
          error: 'edit_already_pending',
          message: 'Дождитесь проверки предыдущих изменений',
        });
      }
      throw batchErr;
    }

    if ((batchResults[1]?.meta?.changes ?? 0) === 0) {
      await env.DB.prepare('DELETE FROM listings WHERE listing_id = ?').bind(draftId).run();
      return jsonResponse({
        ok: false,
        error: 'no_edits_remaining',
        message: 'Лимит редактирований исчерпан',
      });
    }

    if (!portfolioEnabled) {
      const adminText = buildEditModerationAdminText(
        draftId,
        parent.listing_id,
        tgId,
        paymentStatus,
        form,
      );

      const adminMsgIds = await sendModerationToAdmins(
        env.DB,
        env,
        adminText,
        await moderationKeyboard(draftId, 0, tgId, env),
      );
      for (let i = 0; i < adminMsgIds.length; i++) {
        await saveAdminLink(adminMsgIds[i], tgId, 'listing', draftId, env);
      }

      await sendMessage(
        tgId,
        'Изменения отправлены на модерацию. В каталоге пока отображается прежняя версия анкеты.',
        null,
        env,
      );
    }

    await logAction(tgId, 'submit_listing_edit', `${parent.listing_id} → ${draftId}`, env.DB);

    if (portfolioEnabled) {
      return jsonResponse({
        ok: true,
        listing_id: draftId,
        message: 'Загрузка фото…',
        deferred_notify: true,
      });
    }

    return jsonResponse({
      ok: true,
      listing_id: draftId,
      message: 'Изменения отправлены на модерацию',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(
      getUserIdFromInitData(String(body.initData ?? '')) || 0,
      'error',
      `handleSubmitListingEdit: ${msg}`,
      env.DB,
    );
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

    const auth = await authenticateMiniAppUser(body, env, 'Invalid_initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }
    const tgId = auth.tgId;
    const listingId = String(body.listing_id ?? '').trim();

    if (!listingId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
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
      `UPDATE listings SET status = 'archived', archived_at = datetime('now')
       WHERE listing_id = ? AND tg_id = ? AND status = 'active'`,
    )
      .bind(listingId, tgId)
      .run();

    await purgeFavoritesForListing(listingId, env);
    await cleanupEditPendingForParent(listingId, tgId, env);

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
