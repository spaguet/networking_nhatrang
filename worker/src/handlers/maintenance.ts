import type { Env } from '../env';
import { sendMessage } from '../services/telegram-api';
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

/** Port of dailyListingsMaintenance from Code.gs — cron 0 0 * * * UTC (= 07:00 Nha Trang). */
export async function dailyMaintenance(env: Env): Promise<void> {
  const now = new Date();
  let archived = 0;
  let pinsRemoved = 0;
  let warningsSent = 0;

  let rows: MaintenanceListingRow[];
  try {
    rows = await fetchMaintenanceListings(env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `dailyListingsMaintenance fetch: ${msg}`, env.DB);
    return;
  }

  if (rows.length === 0) {
    const summary = '{ archived: 0, pins_removed: 0, warnings_sent: 0 }';
    await logAction(0, 'daily_maintenance', summary, env.DB);
    return;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const listingId = String(row.listing_id || '');
      const tgId = Number(row.tg_id);
      const displayName = String(row.display_name || '');
      const status = String(row.status || '');

      if (status === 'active') {
        const expiresRaw = String(row.expires_at || '').trim();
        if (expiresRaw === 'lifetime') {
          continue;
        }
        const expiresAt = parseStoredDate(row.expires_at);
        if (expiresAt && expiresAt <= now) {
          await env.DB.prepare(
            "UPDATE listings SET status = 'archived' WHERE listing_id = ?",
          )
            .bind(listingId)
            .run();

          const category = String(row.category || '');
          await sendMessage(
            tgId,
            '📦 Срок публикации вашей анкеты [' +
              displayName +
              ' — ' +
              category +
              '] истёк (30 дней). Анкета перемещена в архив.',
            undefined,
            env,
          );
          await logAction(tgId, 'archive', listingId, env.DB);
          archived++;
          continue;
        }
      }

      const pinStatus = String(row.pin_status || 'regular');
      if (pinStatus !== 'pinned') {
        continue;
      }

      const pinExpiresStr = String(row.pin_expires_at || '').trim();
      if (!pinExpiresStr || pinExpiresStr === 'lifetime') {
        continue;
      }

      const pinExpiresAt = parseStoredDate(pinExpiresStr);
      if (!pinExpiresAt) {
        continue;
      }

      if (pinExpiresAt <= now) {
        await env.DB.prepare(
          `UPDATE listings
           SET pin_status = 'regular', pinned_at = NULL, pin_expires_at = NULL
           WHERE listing_id = ?`,
        )
          .bind(listingId)
          .run();

        await sendMessage(
          tgId,
          '📌 Срок закрепления вашей карточки [' +
            displayName +
            '] истёк. Карточка переведена в обычный режим.',
          undefined,
          env,
        );
        await logAction(tgId, 'pin_expired', listingId, env.DB);
        pinsRemoved++;
        continue;
      }

      const hoursLeft = (pinExpiresAt.getTime() - now.getTime()) / 3600000;
      if (hoursLeft >= 20 && hoursLeft < 28) {
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

  const summary =
    '{ archived: ' +
    archived +
    ', pins_removed: ' +
    pinsRemoved +
    ', warnings_sent: ' +
    warningsSent +
    ' }';
  await logAction(0, 'daily_maintenance', summary, env.DB);
}
