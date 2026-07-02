import type { Env } from '../env';
import {
  authenticateMiniAppUser,
  validateTelegramInitData,
} from '../utils/auth';
import { jsonResponse } from '../utils/response';

export const LIKES_CACHE_KEY = 'likes_all';
const LIKES_CACHE_TTL = 180;

type CachedLikeEntry = {
  cardId: string;
  total: number;
  userIds: string[];
};

async function loadLikesFromDb(env: Env): Promise<CachedLikeEntry[]> {
  const { results } = await env.DB.prepare(
    'SELECT listing_id, tg_id FROM likes ORDER BY listing_id',
  ).all<{ listing_id: string; tg_id: number }>();

  const byCard = new Map<string, string[]>();
  for (const row of results ?? []) {
    const cardId = String(row.listing_id ?? '').trim();
    if (!cardId) {
      continue;
    }
    const userIds = byCard.get(cardId) ?? [];
    userIds.push(String(row.tg_id));
    byCard.set(cardId, userIds);
  }

  return Array.from(byCard.entries()).map(([cardId, userIds]) => ({
    cardId,
    total: userIds.length,
    userIds,
  }));
}

async function getLikesCache(env: Env): Promise<CachedLikeEntry[]> {
  const cached = await env.CACHE.get(LIKES_CACHE_KEY);
  if (cached) {
    try {
      const parsed = JSON.parse(cached) as unknown;
      if (Array.isArray(parsed)) {
        return parsed as CachedLikeEntry[];
      }
    } catch {
      // cache miss — reload from D1
    }
  }

  const likesArr = await loadLikesFromDb(env);
  await env.CACHE.put(LIKES_CACHE_KEY, JSON.stringify(likesArr), {
    expirationTtl: LIKES_CACHE_TTL,
  });
  return likesArr;
}

async function buildLikesResponse(userId: string, env: Env): Promise<Response> {
  const likesArr = await getLikesCache(env);
  const likes = likesArr.map((item) => ({
    cardId: item.cardId,
    total: item.total,
    likedByMe: item.userIds.indexOf(userId) !== -1,
  }));

  return jsonResponse({ success: true, likes });
}

async function executeToggleLike(
  userId: number,
  cardId: string,
  type: string,
  env: Env,
): Promise<Response> {
  if (!cardId) {
    return jsonResponse({ success: false, error: 'missing_card_id' });
  }
  if (type !== 'like' && type !== 'unlike') {
    return jsonResponse({ success: false, error: 'invalid_type' });
  }

  if (type === 'like') {
    const listing = await env.DB.prepare(
      'SELECT status FROM listings WHERE listing_id = ?',
    )
      .bind(cardId)
      .first<{ status: string }>();

    if (!listing || listing.status !== 'active') {
      return jsonResponse({ success: false, error: 'listing_not_active' });
    }
  }

  const likedAt = new Date().toISOString();

  const writeStmt =
    type === 'like'
      ? env.DB.prepare(
          'INSERT OR IGNORE INTO likes (listing_id, tg_id, liked_at) VALUES (?, ?, ?)',
        ).bind(cardId, userId, likedAt)
      : env.DB.prepare(
          'DELETE FROM likes WHERE listing_id = ? AND tg_id = ?',
        ).bind(cardId, userId);

  const countStmt = env.DB.prepare(
    'SELECT COUNT(*) AS cnt FROM likes WHERE listing_id = ?',
  ).bind(cardId);

  const batchResults = await env.DB.batch([writeStmt, countStmt]);
  const countRow = batchResults[1]?.results?.[0] as { cnt?: number } | undefined;

  await env.CACHE.delete(LIKES_CACHE_KEY);

  return jsonResponse({ success: true, newCount: countRow?.cnt ?? 0 });
}

/** GET /api?action=getLikes — legacy; prefer POST get_likes */
export async function handleGetLikes(
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
    return await buildLikesResponse(validation.userId, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleGetLikes:', msg);
    return jsonResponse({ success: false, error: 'server_error' });
  }
}

/** POST action get_likes */
export async function handleGetLikesPost(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const auth = await authenticateMiniAppUser(body, env);
  if (!auth.ok) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  try {
    return await buildLikesResponse(String(auth.tgId), env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleGetLikesPost:', msg);
    return jsonResponse({ success: false, error: 'server_error' });
  }
}

/** GET /api?action=toggleLike — legacy; prefer POST toggle_like */
export async function handleToggleLike(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const initData = url.searchParams.get('initData') ?? '';
  const cardId = String(url.searchParams.get('cardId') ?? '').trim();
  const type = url.searchParams.get('type') ?? '';

  const validation = await validateTelegramInitData(initData, env.BOT_TOKEN);
  if (!validation.valid) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  try {
    return await executeToggleLike(Number(validation.userId), cardId, type, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleToggleLike:', msg);
    return jsonResponse({ success: false, error: 'server_error' });
  }
}

/** POST action toggle_like */
export async function handleToggleLikePost(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const auth = await authenticateMiniAppUser(body, env);
  if (!auth.ok) {
    return jsonResponse({ success: false, error: 'unauthorized' });
  }

  const cardId = String(body.cardId ?? '').trim();
  const type = String(body.type ?? '');

  try {
    return await executeToggleLike(auth.tgId, cardId, type, env);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleToggleLikePost:', msg);
    return jsonResponse({ success: false, error: 'server_error' });
  }
}
