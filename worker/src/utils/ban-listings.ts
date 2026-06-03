import type { Env } from '../env';
import { purgeFavoritesForListing } from '../handlers/favorites';
import { cleanupEditPendingForParent } from '../handlers/listings';
import { purgeListing } from '../services/portfolio-db';
import { logAction } from './helpers';

type BanListingsEnv = Pick<Env, 'DB' | 'CACHE'>;

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

/** After unban: active if placement not expired; otherwise archived (not deleted). */
export function listingStatusAfterUnban(
  expiresAt: string | null | undefined,
  now: Date,
): 'active' | 'archived' {
  const raw = String(expiresAt ?? '').trim();
  if (!raw || raw === 'lifetime') {
    return 'active';
  }
  const expires = parseStoredDate(raw);
  if (!expires) {
    return 'active';
  }
  return expires > now ? 'active' : 'archived';
}

interface ListingIdRow {
  listing_id: string;
}

/** Hide catalog cards on ban; keep rows and media for 30-day retention. */
export async function banUserListings(tgId: number, env: BanListingsEnv): Promise<number> {
  const { results } = await env.DB
    .prepare(
      `SELECT listing_id FROM listings
       WHERE tg_id = ? AND status = 'active'`,
    )
    .bind(tgId)
    .all<ListingIdRow>();

  const rows = results ?? [];
  if (rows.length === 0) {
    return 0;
  }

  for (const row of rows) {
    const listingId = String(row.listing_id);
    await env.DB
      .prepare("UPDATE listings SET status = 'banned' WHERE listing_id = ?")
      .bind(listingId)
      .run();
    await purgeFavoritesForListing(listingId, env);
  }

  return rows.length;
}

interface BannedListingRestoreRow {
  listing_id: string;
  expires_at: string | null;
}

export async function restoreUserListingsOnUnban(
  tgId: number,
  env: BanListingsEnv,
): Promise<{ restored: number; archived: number }> {
  const now = new Date();
  const { results } = await env.DB
    .prepare(
      `SELECT listing_id, expires_at FROM listings
       WHERE tg_id = ? AND status = 'banned'`,
    )
    .bind(tgId)
    .all<BannedListingRestoreRow>();

  let restored = 0;
  let archived = 0;

  for (const row of results ?? []) {
    const listingId = String(row.listing_id);
    const nextStatus = listingStatusAfterUnban(row.expires_at, now);

    if (nextStatus === 'active') {
      await env.DB
        .prepare("UPDATE listings SET status = 'active' WHERE listing_id = ?")
        .bind(listingId)
        .run();
      restored++;
    } else {
      await env.DB
        .prepare(
          `UPDATE listings SET status = 'archived', archived_at = datetime('now')
           WHERE listing_id = ?`,
        )
        .bind(listingId)
        .run();
      await purgeFavoritesForListing(listingId, env);
      archived++;
    }
  }

  return { restored, archived };
}

interface BannedListingPurgeRow {
  listing_id: string;
  tg_id: number;
}

/** Delete banned listings and portfolio 30 days after the user was banned. */
export async function purgeBannedListingsAfterRetention(env: Env): Promise<number> {
  let purged = 0;

  try {
    const { results } = await env.DB.prepare(
      `SELECT l.listing_id, l.tg_id
       FROM listings l
       INNER JOIN users u ON u.tg_id = l.tg_id
       WHERE l.status = 'banned'
         AND u.banned = 1
         AND u.banned_at IS NOT NULL
         AND u.banned_at <= datetime('now', '-30 days')`,
    ).all<BannedListingPurgeRow>();

    for (const row of results ?? []) {
      try {
        const listingId = String(row.listing_id);
        const tgId = Number(row.tg_id);
        await cleanupEditPendingForParent(listingId, tgId, env);
        await purgeListing(listingId, env);
        purged++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await logAction(
          0,
          'error',
          `purgeBannedListings ${row.listing_id}: ${msg}`,
          env.DB,
        );
      }
    }

    if (purged > 0) {
      await logAction(0, 'purge_banned_listings', `{ purged: ${purged} }`, env.DB);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `purgeBannedListings fetch: ${msg}`, env.DB);
  }

  return purged;
}
