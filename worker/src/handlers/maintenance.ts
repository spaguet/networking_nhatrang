import type { Env } from '../env';
import { cleanupEditPendingForParent } from '../handlers/listings';
import { purgeFavoritesForListing } from '../handlers/favorites';
import {
  cleanupPortfolioOnReject,
  cleanupStaleStaging,
  purgeListing,
} from '../services/portfolio-db';
import { sendMessage } from '../services/telegram-api';
import { purgeBannedListingsAfterRetention } from '../utils/ban-listings';
import { formatDateRu, logAction } from '../utils/helpers';

interface MaintenanceListingRow {
  listing_id: string;
  tg_id: number;
  display_name: string;
  category: string;
  status: string;
  expires_at: string | null;
  pin_status: string;
  pin_expires_at: string | null;
}

interface ArchiveNotification {
  key: string;
  tgId: number;
  text: string;
}

function parseStoredDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === 'lifetime') {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function fetchMaintenanceListings(env: Env): Promise<MaintenanceListingRow[]> {
  const result = await env.DB.prepare(
    `SELECT listing_id, tg_id, display_name, category, status, expires_at, pin_status, pin_expires_at
     FROM listings
     WHERE status = 'active' OR pin_status = 'pinned'`,
  ).all<MaintenanceListingRow>();

  return result.results ?? [];
}

function changedRows(result: D1Result<unknown>): number {
  return typeof result.meta?.changes === 'number' ? result.meta.changes : 0;
}

function buildArchiveNotification(row: MaintenanceListingRow): ArchiveNotification {
  const tgId = Number(row.tg_id);
  const displayName = String(row.display_name || '');
  const category = String(row.category || '');

  return {
    key: `${tgId}\u0000${displayName}\u0000${category}`,
    tgId,
    text:
      '📦 Срок публикации вашей анкеты [' +
      displayName +
      ' — ' +
      category +
      '] истёк (30 дней). Анкета перемещена в архив.',
  };
}

async function archiveExpiredListing(
  row: MaintenanceListingRow,
  now: Date,
  env: Env,
): Promise<ArchiveNotification | null> {
  const listingId = String(row.listing_id || '');
  const tgId = Number(row.tg_id);
  const status = String(row.status || '');
  const expiresRaw = String(row.expires_at || '').trim();

  if (!listingId || !Number.isFinite(tgId) || status !== 'active' || expiresRaw === 'lifetime') {
    return null;
  }

  const expiresAt = parseStoredDate(row.expires_at);
  if (!expiresAt || expiresAt > now) {
    return null;
  }

  const result = await env.DB.prepare(
    `UPDATE listings
     SET status = 'archived', archived_at = datetime('now')
     WHERE listing_id = ? AND status = 'active' AND COALESCE(expires_at, '') = ?`,
  )
    .bind(listingId, expiresRaw)
    .run();

  if (changedRows(result) !== 1) {
    return null;
  }

  await purgeFavoritesForListing(listingId, env);
  await cleanupEditPendingForParent(listingId, tgId, env);
  await logAction(tgId, 'archive', listingId, env.DB);

  return buildArchiveNotification(row);
}

async function expirePinIfNeeded(
  row: MaintenanceListingRow,
  now: Date,
  env: Env,
): Promise<boolean> {
  const listingId = String(row.listing_id || '');
  const tgId = Number(row.tg_id);
  const displayName = String(row.display_name || '');
  const pinStatus = String(row.pin_status || 'regular');
  const pinExpiresStr = String(row.pin_expires_at || '').trim();

  if (
    !listingId ||
    !Number.isFinite(tgId) ||
    pinStatus !== 'pinned' ||
    !pinExpiresStr ||
    pinExpiresStr === 'lifetime'
  ) {
    return false;
  }

  const pinExpiresAt = parseStoredDate(pinExpiresStr);
  if (!pinExpiresAt || pinExpiresAt > now) {
    return false;
  }

  const result = await env.DB.prepare(
    `UPDATE listings
     SET pin_status = 'regular', pinned_at = NULL, pin_expires_at = NULL
     WHERE listing_id = ? AND pin_status = 'pinned' AND COALESCE(pin_expires_at, '') = ?`,
  )
    .bind(listingId, pinExpiresStr)
    .run();

  if (changedRows(result) !== 1) {
    return false;
  }

  await sendMessage(
    tgId,
    '📌 Срок закрепления вашей карточки [' +
      displayName +
      '] истёк. Карточка переведена в обычный режим.',
    undefined,
    env,
  );
  await logAction(tgId, 'pin_expired', listingId, env.DB);

  return true;
}

async function hasRecentPinExpiryWarning(listingId: string, env: Env): Promise<boolean> {
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000).toISOString();
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM logs
     WHERE action = 'pin_expiry_warning' AND details = ? AND timestamp >= ?
     LIMIT 1`,
  )
    .bind(listingId, since)
    .first<{ ok: number }>();

  return !!row;
}

async function warnPinExpiryIfNeeded(
  row: MaintenanceListingRow,
  now: Date,
  env: Env,
): Promise<boolean> {
  const listingId = String(row.listing_id || '');
  const tgId = Number(row.tg_id);
  const displayName = String(row.display_name || '');
  const pinStatus = String(row.pin_status || 'regular');
  const pinExpiresStr = String(row.pin_expires_at || '').trim();

  if (
    !listingId ||
    !Number.isFinite(tgId) ||
    pinStatus !== 'pinned' ||
    !pinExpiresStr ||
    pinExpiresStr === 'lifetime'
  ) {
    return false;
  }

  const pinExpiresAt = parseStoredDate(pinExpiresStr);
  if (!pinExpiresAt) {
    return false;
  }

  const hoursLeft = (pinExpiresAt.getTime() - now.getTime()) / 3600000;
  if (hoursLeft < 20 || hoursLeft >= 28) {
    return false;
  }

  if (await hasRecentPinExpiryWarning(listingId, env)) {
    return false;
  }

  await sendMessage(
    tgId,
    '⚠️ Завтра, ' +
      formatDateRu(pinExpiresAt) +
      ', истекает срок закрепления вашей карточки [' +
      displayName +
      ']. Обратитесь к администратору для продления.',
    undefined,
    env,
  );
  await logAction(tgId, 'pin_expiry_warning', listingId, env.DB);

  return true;
}

/** Port of dailyListingsMaintenance from Code.gs — cron 0 0 * * * UTC (= 07:00 Nha Trang). */
export async function dailyMaintenance(env: Env): Promise<void> {
  const now = new Date();
  let archived = 0;
  let pinsRemoved = 0;
  let warningsSent = 0;
  const archiveNotifications = new Map<string, ArchiveNotification>();

  let rows: MaintenanceListingRow[];
  try {
    rows = await fetchMaintenanceListings(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `dailyListingsMaintenance fetch: ${msg}`, env.DB);
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const archiveNotification = await archiveExpiredListing(row, now, env);
      if (archiveNotification) {
        if (!archiveNotifications.has(archiveNotification.key)) {
          archiveNotifications.set(archiveNotification.key, archiveNotification);
        }
        archived++;
        continue;
      }

      if (await expirePinIfNeeded(row, now, env)) {
        pinsRemoved++;
        continue;
      }

      if (await warnPinExpiryIfNeeded(row, now, env)) {
        warningsSent++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAction(
        0,
        'error',
        `dailyListingsMaintenance row ${i + 1}: ${msg}`,
        env.DB,
      );
    }
  }

  for (const notification of archiveNotifications.values()) {
    try {
      await sendMessage(notification.tgId, notification.text, undefined, env);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await logAction(
        notification.tgId,
        'error',
        `dailyListingsMaintenance archive notification: ${msg}`,
        env.DB,
      );
    }
  }

  const summary =
    '{ archived: ' +
    archived +
    ', pins_removed: ' +
    pinsRemoved +
    ', warnings_sent: ' +
    warningsSent +
    ' }';
  await logAction(0, 'daily_maintenance', summary, env.DB);

  await cleanupStaleEditPending(env);
  await purgeBannedListingsAfterRetention(env);
  await purgeArchivedListings(env);
  await cleanupStaleStaging(env, 7);
  await purgeExpiredConversations(env);
}

interface StaleEditRow {
  listing_id: string;
  tg_id: number;
}

/** Remove edit_pending drafts older than 7 days (listing_edit_TZ §5.8). */
async function cleanupStaleEditPending(env: Env): Promise<void> {
  let cleaned = 0;

  try {
    const result = await env.DB.prepare(
      `SELECT listing_id, tg_id FROM listings
       WHERE status = 'edit_pending'
         AND submitted_at < datetime('now', '-7 days')`,
    ).all<StaleEditRow>();

    for (const row of result.results ?? []) {
      try {
        const draftId = String(row.listing_id);
        const tgId = Number(row.tg_id);
        await cleanupPortfolioOnReject(draftId, tgId, env);
        await env.DB.prepare('DELETE FROM listings WHERE listing_id = ?').bind(draftId).run();
        await sendMessage(
          tgId,
          'Срок ожидания правок истёк. Отправьте редактирование снова, если остались попытки.',
          undefined,
          env,
        );
        await logAction(tgId, 'stale_edit_cleanup', draftId, env.DB);
        cleaned++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logAction(
          0,
          'error',
          `cleanupStaleEditPending ${row.listing_id}: ${msg}`,
          env.DB,
        );
      }
    }

    if (cleaned > 0) {
      await logAction(0, 'stale_edit_cleanup', `{ cleaned: ${cleaned} }`, env.DB);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `cleanupStaleEditPending fetch: ${msg}`, env.DB);
  }
}

interface ArchivedListingRow {
  listing_id: string;
}

interface EligibleConversationRow {
  conversation_id: string;
}

/** Purge in-app conversations past TTL or empty >7d; skip open complaints (user_messaging_TZ.md §4.6). */
async function purgeExpiredConversations(env: Env): Promise<void> {
  let purged = 0;

  try {
    const now = new Date().toISOString();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const result = await env.DB.prepare(
      `SELECT c.conversation_id
       FROM conversations c
       WHERE (
         (c.expires_at IS NOT NULL AND c.expires_at < ?)
         OR (c.first_message_at IS NULL AND c.created_at < ?)
       )
       AND NOT EXISTS (
         SELECT 1 FROM message_complaints mc
         WHERE mc.conversation_id = c.conversation_id AND mc.status = 'open'
       )`,
    )
      .bind(now, sevenDaysAgo)
      .all<EligibleConversationRow>();

    const rows = result.results ?? [];
    if (rows.length === 0) {
      return;
    }

    const ids = rows.map((row) => String(row.conversation_id));
    const placeholders = ids.map(() => '?').join(', ');

    await env.DB.prepare(`DELETE FROM conversations WHERE conversation_id IN (${placeholders})`)
      .bind(...ids)
      .run();

    await env.DB.prepare(
      `UPDATE message_complaints
       SET status = 'expired'
       WHERE conversation_id IN (${placeholders}) AND status = 'open'`,
    )
      .bind(...ids)
      .run();

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await env.DB.prepare(
      `DELETE FROM message_complaints
       WHERE status = 'expired' AND created_at < ?`,
    )
      .bind(thirtyDaysAgo)
      .run();

    purged = ids.length;
    if (purged > 0) {
      await logAction(0, 'purge_conversations', `{ purged: ${purged} }`, env.DB);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `purgeExpiredConversations: ${msg}`, env.DB);
  }
}

async function purgeArchivedListings(env: Env): Promise<void> {
  let purged = 0;

  try {
    const result = await env.DB.prepare(
      `SELECT listing_id FROM listings
       WHERE status = 'archived'
         AND archived_at IS NOT NULL
         AND archived_at <= datetime('now', '-90 days')`,
    ).all<ArchivedListingRow>();

    const rows = result.results ?? [];
    for (const row of rows) {
      try {
        await purgeListing(String(row.listing_id), env);
        purged++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logAction(
          0,
          'error',
          `purgeArchivedListings ${row.listing_id}: ${msg}`,
          env.DB,
        );
      }
    }

    if (purged > 0) {
      await logAction(0, 'purge_archived', `{ purged: ${purged} }`, env.DB);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `purgeArchivedListings fetch: ${msg}`, env.DB);
  }
}
