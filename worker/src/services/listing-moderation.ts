import type { Env } from '../env';
import { purgeFavoritesForListing } from '../handlers/favorites';
import { sendMessage } from './telegram-api';
import {
  cleanupPortfolioOnReject,
  deleteMediaByListing,
  getPortfolioCount,
  purgeListing,
} from './portfolio-db';
import { logAction, setUserFreeUsed } from '../utils/helpers';

type ListingStatusRow = {
  tg_id: number;
  payment_status: string;
  status: string;
};

type EditDraftRow = {
  listing_id: string;
  tg_id: number;
  replaces_listing_id: string;
  display_name: string;
  category: string;
  description: string;
  experience: string | null;
  contact_type: string;
  contacts: string;
  avatar_emoji: string;
  keywords: string;
  status: string;
};

export type ModerationActionResult =
  | {
      ok: true;
      kind: 'approved' | 'approved_edit' | 'rejected' | 'rejected_edit' | 'deleted' | 'deleted_edit';
    }
  | { ok: false; error: 'not_found' | 'invalid_status' };

export async function approveListingModeration(
  listingId: string,
  env: Env,
): Promise<ModerationActionResult> {
  const listing = await env.DB.prepare(
    'SELECT tg_id, payment_status, status FROM listings WHERE listing_id = ?',
  )
    .bind(listingId)
    .first<ListingStatusRow>();

  if (!listing) {
    return { ok: false, error: 'not_found' };
  }

  if (listing.status === 'edit_pending') {
    return approveListingEditModeration(listingId, env);
  }

  if (listing.status !== 'on_moderation') {
    return { ok: false, error: 'invalid_status' };
  }

  const today = new Date();
  const expires = new Date(today);
  expires.setDate(expires.getDate() + 30);

  await env.DB.prepare(
    `UPDATE listings
     SET status = 'active', created_at = ?, expires_at = ?,
         edits_remaining = COALESCE(edits_remaining, 3)
     WHERE listing_id = ?`,
  )
    .bind(today.toISOString(), expires.toISOString(), listingId)
    .run();

  const portfolioCount = await getPortfolioCount(listingId, env.DB, {
    includePending: true,
  });

  await env.DB.prepare(
    `UPDATE listing_media SET status = 'active' WHERE listing_id = ? AND status = 'pending'`,
  )
    .bind(listingId)
    .run();

  if (listing.payment_status === 'free') {
    await setUserFreeUsed(listing.tg_id, true, env.DB);
  }

  let approveText =
    '🎉 Ваше размещение успешно опубликовано в каталоге!\n' +
    'Оно будет активно 30 дней.\n\n' +
    '📦 После окончания срока анкета перейдёт в архив. В архиве данные хранятся 3 месяца, затем удаляются безвозвратно.';
  if (portfolioCount > 0) {
    approveText +=
      '\n\n🖼 Фото портфолио также будут удалены. Для повторной публикации загрузите анкету и фото заново.';
  }

  await sendMessage(listing.tg_id, approveText, null, env);
  await logAction(listing.tg_id, 'approve', listingId, env.DB);
  return { ok: true, kind: 'approved' };
}

async function approveListingEditModeration(
  draftId: string,
  env: Env,
): Promise<ModerationActionResult> {
  const draft = await env.DB.prepare(
    `SELECT listing_id, tg_id, replaces_listing_id, display_name, category, description,
            experience, contact_type, contacts, avatar_emoji, keywords, status
     FROM listings WHERE listing_id = ?`,
  )
    .bind(draftId)
    .first<EditDraftRow>();

  if (!draft || draft.status !== 'edit_pending') {
    return { ok: false, error: 'not_found' };
  }

  const parentId = String(draft.replaces_listing_id || '');
  const parent = await env.DB.prepare(
    'SELECT listing_id, tg_id, status FROM listings WHERE listing_id = ?',
  )
    .bind(parentId)
    .first<{ listing_id: string; tg_id: number; status: string }>();

  if (!parent || parent.status !== 'active' || parent.tg_id !== draft.tg_id) {
    return { ok: false, error: 'invalid_status' };
  }

  await env.DB.prepare(
    `UPDATE listings SET
       display_name = ?, category = ?, description = ?, experience = ?,
       contact_type = ?, contacts = ?, avatar_emoji = ?, keywords = ?
     WHERE listing_id = ?`,
  )
    .bind(
      draft.display_name,
      draft.category,
      draft.description,
      draft.experience || '',
      draft.contact_type,
      draft.contacts,
      draft.avatar_emoji,
      draft.keywords,
      parentId,
    )
    .run();

  const draftHasMedia = await env.DB.prepare(
    'SELECT 1 AS ok FROM listing_media WHERE listing_id = ? LIMIT 1',
  )
    .bind(draftId)
    .first<{ ok: number }>();

  if (draftHasMedia) {
    await deleteMediaByListing(parentId, env.DB, env.PORTFOLIO);
    await env.DB.prepare(
      'UPDATE listing_media SET listing_id = ? WHERE listing_id = ?',
    )
      .bind(parentId, draftId)
      .run();
    await env.DB.prepare(
      `UPDATE listing_media SET status = 'active'
       WHERE listing_id = ? AND status = 'pending'`,
    )
      .bind(parentId)
      .run();
  }

  await env.DB.prepare('DELETE FROM listings WHERE listing_id = ?')
    .bind(draftId)
    .run();

  await sendMessage(
    draft.tg_id,
    '✅ Изменения одобрены и опубликованы в каталоге. Срок размещения не изменился.',
    null,
    env,
  );
  await logAction(draft.tg_id, 'approve_edit', `${draftId} → ${parentId}`, env.DB);
  return { ok: true, kind: 'approved_edit' };
}

export async function rejectListingModeration(
  listingId: string,
  env: Env,
): Promise<ModerationActionResult> {
  const listing = await env.DB.prepare(
    'SELECT tg_id, payment_status, status FROM listings WHERE listing_id = ?',
  )
    .bind(listingId)
    .first<ListingStatusRow>();

  if (!listing) {
    return { ok: false, error: 'not_found' };
  }

  if (listing.status === 'edit_pending') {
    return rejectListingEditModeration(listingId, env);
  }

  if (listing.status !== 'on_moderation') {
    return { ok: false, error: 'invalid_status' };
  }

  await cleanupPortfolioOnReject(listingId, listing.tg_id, env);

  await env.DB.prepare(
    `UPDATE listings SET status = 'rejected' WHERE listing_id = ?`,
  )
    .bind(listingId)
    .run();

  await purgeFavoritesForListing(listingId, env);

  const rejectText =
    listing.payment_status === 'paid'
      ? '❌ Размещение отклонено.\nАдминистратор свяжется с вами в течение 24 часов для возврата средств.'
      : '❌ Размещение отклонено.\nАдминистратор свяжется с вами в течение 24 часов.';

  await sendMessage(listing.tg_id, rejectText, null, env);
  await logAction(listing.tg_id, 'reject', listingId, env.DB);
  return { ok: true, kind: 'rejected' };
}

async function rejectListingEditModeration(
  draftId: string,
  env: Env,
): Promise<ModerationActionResult> {
  const draft = await env.DB.prepare(
    `SELECT listing_id, tg_id, replaces_listing_id, status
     FROM listings WHERE listing_id = ?`,
  )
    .bind(draftId)
    .first<{
      listing_id: string;
      tg_id: number;
      replaces_listing_id: string;
      status: string;
    }>();

  if (!draft || draft.status !== 'edit_pending') {
    return { ok: false, error: 'not_found' };
  }

  const parent = await env.DB.prepare(
    'SELECT edits_remaining FROM listings WHERE listing_id = ?',
  )
    .bind(draft.replaces_listing_id)
    .first<{ edits_remaining: number | null }>();

  await cleanupPortfolioOnReject(draftId, draft.tg_id, env);
  await env.DB.prepare('DELETE FROM listings WHERE listing_id = ?')
    .bind(draftId)
    .run();

  const remaining = parent?.edits_remaining ?? 0;
  await sendMessage(
    draft.tg_id,
    '❌ Редактирование отклонено. В каталоге по-прежнему прежняя версия. ' +
      `Попытка редактирования использована. Осталось правок: ${remaining}.`,
    null,
    env,
  );
  await logAction(draft.tg_id, 'reject_edit', draftId, env.DB);
  return { ok: true, kind: 'rejected_edit' };
}

export async function deleteListingModeration(
  listingId: string,
  env: Env,
): Promise<ModerationActionResult> {
  const listing = await env.DB.prepare(
    'SELECT tg_id, payment_status, status FROM listings WHERE listing_id = ?',
  )
    .bind(listingId)
    .first<ListingStatusRow>();

  if (!listing) {
    return { ok: false, error: 'not_found' };
  }

  if (listing.status === 'edit_pending') {
    await cleanupPortfolioOnReject(listingId, listing.tg_id, env);
    await env.DB.prepare('DELETE FROM listings WHERE listing_id = ?')
      .bind(listingId)
      .run();
    await sendMessage(
      listing.tg_id,
      '❌ Черновик редактирования удалён администратором. В каталоге остаётся прежняя версия.',
      null,
      env,
    );
    await logAction(listing.tg_id, 'admin_delete_edit', listingId, env.DB);
    return { ok: true, kind: 'deleted_edit' };
  }

  if (listing.status !== 'on_moderation') {
    return { ok: false, error: 'invalid_status' };
  }

  const tgId = listing.tg_id;
  const paymentStatus = listing.payment_status;
  await purgeListing(listingId, env);

  const deleteText =
    paymentStatus === 'paid'
      ? '❌ Размещение удалено администратором.\nАдминистратор свяжется с вами в течение 24 часов для возврата средств.'
      : '❌ Размещение удалено администратором.';

  await sendMessage(tgId, deleteText, null, env);
  await logAction(tgId, 'admin_delete_listing', listingId, env.DB);
  return { ok: true, kind: 'deleted' };
}
