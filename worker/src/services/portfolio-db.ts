import type { Env } from '../env';
import { logAction } from '../utils/helpers';
import { deleteR2Keys, putR2 } from './media';

export type ListingMediaStatus = 'pending' | 'active' | 'deleted';

export interface ListingMediaRow {
  id: number;
  listing_id: string;
  position: number;
  r2_key: string;
  thumb_r2_key: string | null;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  status: ListingMediaStatus;
  created_at: string;
}

export interface InsertMediaParams {
  listingId: string;
  position: number;
  r2Key: string;
  thumbR2Key?: string | null;
  mimeType?: string;
  byteSize: number;
  width?: number | null;
  height?: number | null;
  status?: ListingMediaStatus;
}

const STAGING_PREFIX = 'portfolio/staging/';
const PORTFOLIO_PREFIX = 'portfolio/';

export function stagingObjectKey(tgId: number, position: number): string {
  return `${STAGING_PREFIX}${tgId}/${position}.webp`;
}

export function portfolioObjectKey(listingId: string, position: number): string {
  return `${PORTFOLIO_PREFIX}${listingId}/${position}.webp`;
}

export async function getPortfolioCount(
  listingId: string,
  db: D1Database,
  options?: { includePending?: boolean },
): Promise<number> {
  const sql = options?.includePending
    ? `SELECT COUNT(*) AS cnt FROM listing_media
       WHERE listing_id = ? AND status IN ('pending', 'active')`
    : `SELECT COUNT(*) AS cnt FROM listing_media
       WHERE listing_id = ? AND status = 'active'`;

  const row = await db.prepare(sql).bind(listingId).first<{ cnt: number }>();
  return Number(row?.cnt ?? 0);
}

export async function insertMedia(
  params: InsertMediaParams,
  db: D1Database,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO listing_media (
         listing_id, position, r2_key, thumb_r2_key, mime_type, byte_size,
         width, height, status, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(listing_id, position) DO UPDATE SET
         r2_key = excluded.r2_key,
         thumb_r2_key = excluded.thumb_r2_key,
         mime_type = excluded.mime_type,
         byte_size = excluded.byte_size,
         width = excluded.width,
         height = excluded.height,
         status = excluded.status,
         created_at = excluded.created_at`,
    )
    .bind(
      params.listingId,
      params.position,
      params.r2Key,
      params.thumbR2Key ?? null,
      params.mimeType ?? 'image/webp',
      params.byteSize,
      params.width ?? null,
      params.height ?? null,
      params.status ?? 'pending',
      now,
    )
    .run();
}

export async function listMediaByListing(
  listingId: string,
  db: D1Database,
): Promise<ListingMediaRow[]> {
  const result = await db
    .prepare(
      `SELECT id, listing_id, position, r2_key, thumb_r2_key, mime_type, byte_size,
              width, height, status, created_at
       FROM listing_media
       WHERE listing_id = ?
       ORDER BY position ASC`,
    )
    .bind(listingId)
    .all<ListingMediaRow>();

  return result.results ?? [];
}

function collectR2Keys(rows: ListingMediaRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    keys.push(row.r2_key);
    if (row.thumb_r2_key) {
      keys.push(row.thumb_r2_key);
    }
  }
  return keys;
}

export async function deleteMediaByListing(
  listingId: string,
  db: D1Database,
  bucket?: R2Bucket,
): Promise<string[]> {
  const rows = await listMediaByListing(listingId, db);
  const keys = collectR2Keys(rows);

  await db
    .prepare('DELETE FROM listing_media WHERE listing_id = ?')
    .bind(listingId)
    .run();

  if (bucket && keys.length > 0) {
    await deleteR2Keys(bucket, keys);
  }

  return keys;
}

async function deleteStagingForTgId(bucket: R2Bucket, tgId: number): Promise<void> {
  const prefix = `${STAGING_PREFIX}${tgId}/`;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix, cursor });
    const keys = listed.objects.map((o) => o.key);
    if (keys.length > 0) {
      await deleteR2Keys(bucket, keys);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

function parseStagingPosition(key: string, tgId: number): number | null {
  const prefix = `${STAGING_PREFIX}${tgId}/`;
  if (!key.startsWith(prefix) || !key.endsWith('.webp')) {
    return null;
  }
  const base = key.slice(prefix.length, -'.webp'.length);
  const position = parseInt(base, 10);
  if (!Number.isFinite(position) || position < 1 || position > 5) {
    return null;
  }
  return position;
}

/**
 * Paid flow: copy portfolio/staging/{tg_id}/* → portfolio/{listing_id}/* and INSERT listing_media (pending).
 * Internal only — not a public API action.
 */
export async function promoteStaging(
  tgId: number,
  listingId: string,
  env: Env,
): Promise<number> {
  const bucket = env.PORTFOLIO;
  const prefix = `${STAGING_PREFIX}${tgId}/`;
  let cursor: string | undefined;
  let promoted = 0;

  do {
    const listed = await bucket.list({ prefix, cursor });

    for (const obj of listed.objects) {
      const position = parseStagingPosition(obj.key, tgId);
      if (position === null) {
        continue;
      }

      const body = await bucket.get(obj.key);
      if (!body) {
        continue;
      }

      const data = new Uint8Array(await body.arrayBuffer());
      const destKey = portfolioObjectKey(listingId, position);
      await putR2(bucket, destKey, data);

      await insertMedia(
        {
          listingId,
          position,
          r2Key: destKey,
          byteSize: data.byteLength,
          status: 'pending',
        },
        env.DB,
      );

      await bucket.delete(obj.key);
      promoted++;
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return promoted;
}

/** §5.2 — full listing removal: R2 (media + staging) then D1 cascade tables. */
export async function purgeListing(listingId: string, env: Env): Promise<void> {
  const listing = await env.DB.prepare(
    'SELECT tg_id FROM listings WHERE listing_id = ?',
  )
    .bind(listingId)
    .first<{ tg_id: number }>();

  const mediaRows = await listMediaByListing(listingId, env.DB);
  const mediaKeys = collectR2Keys(mediaRows);

  if (mediaKeys.length > 0) {
    await deleteR2Keys(env.PORTFOLIO, mediaKeys);
  }

  if (listing?.tg_id != null) {
    await deleteStagingForTgId(env.PORTFOLIO, Number(listing.tg_id));
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM likes WHERE listing_id = ?').bind(listingId),
    env.DB.prepare('DELETE FROM listing_media WHERE listing_id = ?').bind(listingId),
    env.DB.prepare('DELETE FROM admin_links WHERE listing_id = ?').bind(listingId),
    env.DB.prepare('DELETE FROM listings WHERE listing_id = ?').bind(listingId),
  ]);

  await logAction(0, 'purge_listing', listingId, env.DB);
}

/** Remove portfolio/staging/* objects older than `days` (default 7). */
export async function cleanupStaleStaging(env: Env, days = 7): Promise<number> {
  const bucket = env.PORTFOLIO;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let removed = 0;
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({ prefix: STAGING_PREFIX, cursor });

    for (const obj of listed.objects) {
      const uploadedAt = obj.uploaded?.getTime();
      if (uploadedAt != null && uploadedAt < cutoffMs) {
        await bucket.delete(obj.key);
        removed++;
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return removed;
}
