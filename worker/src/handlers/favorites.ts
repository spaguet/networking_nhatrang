import type { Env } from '../env';
import {
  authenticateMiniAppUser,
  validateTelegramInitData,
} from '../utils/auth';
import { ensureUser, rejectIfBanned } from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import { type CatalogListingRow, mapCatalogListing } from '../utils/catalog-listing';

export const FAVORITES_CACHE_KEY = 'favorites_all';
const FAVORITES_CACHE_TTL = 180;

type CachedFavoriteEntry = {
  listingId: string;
  total: number;
  userIds: string[];
};

function parseInitDataUser(initData: string): { username: string; firstName: string } {
  try {
    const params: Record<string, string> = {};
    initData.split('&').forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) {
        return;
      }
      const key = decodeURIComponent(pair.substring(0, eq));
      const value = decodeURIComponent(pair.substring(eq + 1).replace(/\+/g, ' '));
      params[key] = value;
    });
    if (params.user) {
      const user = JSON.parse(params.user) as {
        username?: string;
        first_name?: string;
      };
      return {
        username: user.username ?? '',
        firstName: user.first_name ?? '',
      };
    }
  } catch {
    // fall through
  }
  return { username: '', firstName: '' };
}

async function loadFavoritesFromDb(env: Env): Promise<CachedFavoriteEntry[]> {
  const { results } = await env.DB.prepare(
    'SELECT listing_id, tg_id FROM favorites ORDER BY listing_id',
  ).all<{ listing_id: string; tg_id: number }>();

  const byListing = new Map<string, string[]>();
  for (const row of results ?? []) {
    const listingId = String(row.listing_id ?? '').trim();
    if (!listingId) {
      continue;
    }
    const userIds = byListing.get(listingId) ?? [];
    userIds.push(String(row.tg_id));
    byListing.set(listingId, userIds);
  }

  return Array.from(byListing.entries()).map(([listingId, userIds]) => ({
    listingId,
    total: userIds.length,
    userIds,
  }));
}

async function getFavoritesCache(env: Env): Promise<CachedFavoriteEntry[]> {
  const cached = await env.CACHE.get(FAVORITES_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as CachedFavoriteEntry[];
      }
    } catch {
      // cache miss — reload from D1
    }
  }

  const favoritesArr = await loadFavoritesFromDb(env);
  await env.CACHE.put(FAVORITES_CACHE_KEY, JSON.stringify(favoritesArr), {
    expirationTtl: FAVORITES_CACHE_TTL,
  });
  return favoritesArr;
}

async function buildFavoriteCountsResponse(
  userId: string,
  env: Env,
): Promise<Response> {
  const favoritesArr = await getFavoritesCache(env);
  const favorites = favoritesArr.map((item) => ({
    listingId: item.listingId,
    total: item.total,
    favoritedByMe: item.userIds.indexOf(userId) !== -1,
  }));

  return jsonResponse({ success: true, favorites });
}

async function executeToggleFavorite(
  tgId: number,
  initData: string,
  listingId: string,
  type: string,
  env: Env,
): Promise<Response> {
  if (!listingId) {
    return jsonResponse({ success: false, error: 'missing_listing_id' });
  }
  if (type !== 'favorite' && type !== 'unfavorite') {
    return jsonResponse({ success: false, error: 'invalid_type' });
  }

  const favoritedAt = new Date().toISOString();

  if (type === 'favorite') {
    const listing = await env.DB.prepare(
      'SELECT status FROM listings WHERE listing_id = ?',
    )
      .bind(listingId)
      .first<{ status: string }>();

    if (!listing || listing.status !== 'active') {
      return jsonResponse({ success: false, error: 'listing_not_active' });
    }

    const { username, firstName } = parseInitDataUser(initData);
    await ensureUser(tgId, username, firstName, env.DB);
  }

  const writeStmt =
    type === 'favorite'
      ? env.DB.prepare(
          'INSERT OR IGNORE INTO favorites (listing_id, tg_id, favorited_at) VALUES (?, ?, ?)',
        ).bind(listingId, tgId, favoritedAt)
      : env.DB.prepare(
          'DELETE FROM favorites WHERE listing_id = ? AND tg_id = ?',
        ).bind(listingId, tgId);

  const countStmt = env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM favorites WHERE listing_id = ?',
  ).bind(listingId);

  const batchResults = await env.DB.batch([writeStmt, countStmt]);
  const countRow = batchResults[1]?.results?.[0] as { cnt?: number } | undefined;

  await env.CACHE.delete(FAVORITES_CACHE_KEY);

  return jsonResponse({
    success: true,
    isFavorited: type === 'favorite',
    newCount: countRow?.cnt ?? 0,
  });
}

/** GET /api?action=getFavoriteCounts — legacy; prefer POST get_favorite_counts */
export async function handleGetFavoriteCounts(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const initData = url.searchParams.get('initData') ?? '';

  const validation = await validateTelegramInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  try {
    return await buildFavoriteCountsResponse(validation.userId, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: msg });
  }
}

/** POST action get_favorite_counts */
export async function handleGetFavoriteCountsPost(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const auth = await authenticateMiniAppUser(body, env);
  if (!auth.ok) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  try {
    return await buildFavoriteCountsResponse(String(auth.tgId), env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: msg });
  }
}

/** GET /api?action=toggleFavorite — legacy; prefer POST toggle_favorite */
export async function handleToggleFavorite(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const initData = url.searchParams.get('initData') ?? '';
  const listingId = String(url.searchParams.get('listingId') ?? '').trim();
  const type = url.searchParams.get('type') ?? '';

  const validation = await validateTelegramInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  try {
    return await executeToggleFavorite(
      Number(validation.userId),
      initData,
      listingId,
      type,
      env,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: msg });
  }
}

/** POST action toggle_favorite */
export async function handleToggleFavoritePost(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const auth = await authenticateMiniAppUser(body, env);
  if (!auth.ok) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  const initData = String(body.initData ?? '');
  const listingId = String(body.listingId ?? '').trim();
  const type = String(body.type ?? '');

  try {
    return await executeToggleFavorite(auth.tgId, initData, listingId, type, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ success: false, error: msg });
  }
}

export async function purgeFavoritesForListing(
  listingId: string,
  env: Env,
): Promise<void> {
  await env.DB.prepare('DELETE FROM favorites WHERE listing_id = ?').bind(listingId).run();
  await env.CACHE.delete(FAVORITES_CACHE_KEY);
}

/** POST action get_favorites — raw active listings for favorites screen */
export async function handleGetFavoritesListings(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const auth = await authenticateMiniAppUser(body, env, 'Invalid_initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }
    const tgId = auth.tgId;

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const totalCountRow = await env.DB.prepare(
      'SELECT COUNT(*) AS cnt FROM favorites WHERE tg_id = ?',
    )
      .bind(tgId)
      .first<{ cnt: number }>();

    const totalCount = totalCountRow?.cnt ?? 0;

    const { results } = await env.DB.prepare(
      `SELECT l.listing_id, l.display_name, l.category, l.description, l.experience,
              l.contact_type, l.contacts, l.avatar_emoji, l.created_at, l.expires_at,
              l.pin_status, l.pinned_at, l.pin_expires_at, l.keywords,
              EXISTS(
                SELECT 1 FROM listing_media lm
                WHERE lm.listing_id = l.listing_id AND lm.status = 'active'
              ) AS has_portfolio,
              (SELECT COUNT(*) FROM listing_media lm
               WHERE lm.listing_id = l.listing_id AND lm.status = 'active') AS portfolio_count
       FROM favorites f
       INNER JOIN listings l ON l.listing_id = f.listing_id AND l.status = 'active'
       WHERE f.tg_id = ?`,
    )
      .bind(tgId)
      .all<CatalogListingRow>();

    const listings = (results ?? []).map(mapCatalogListing);
    const inactiveCount = totalCount - listings.length;

    return jsonResponse({ ok: true, listings, totalCount, inactiveCount });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ ok: false, error: msg });
  }
}
