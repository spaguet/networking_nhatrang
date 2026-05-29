import type { Env } from '../env';
import {
  compressToWebp,
  deleteR2Keys,
  putR2,
  validateImageBytes,
} from '../services/media';
import {
  getPortfolioCount,
  insertMedia,
  listMediaByListing,
  portfolioObjectKey,
  stagingObjectKey,
} from '../services/portfolio-db';
import { moderationKeyboard, sendMessage } from '../services/telegram-api';
import { getUserIdFromInitData, validateInitData } from '../utils/auth';
import { decodeDescriptionNewlines } from '../utils/description';
import { logAction } from '../utils/helpers';
import {
  checkPortfolioRateLimit,
  createSignedMediaUrl,
  incrementPortfolioRateLimit,
  verifyAdminPortfolioToken,
  verifySignedMediaRequest,
} from '../utils/portfolio-auth';
import { jsonResponse } from '../utils/response';
import { saveAdminLink } from './telegram';

const MAX_PHOTOS = 5;
const RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

type MultipartFields = Map<string, FormDataEntryValue>;

interface ProcessedPhoto {
  position: number;
  data: Uint8Array;
  width: number;
  height: number;
  byteSize: number;
  r2Key: string;
  oldR2Key: string | null;
}

function fieldString(fields: MultipartFields, key: string): string {
  const value = fields.get(key);
  if (value == null || value instanceof File) {
    return '';
  }
  return String(value).trim();
}

function fieldFile(fields: MultipartFields, key: string): File | null {
  const value = fields.get(key);
  if (value instanceof File && value.size > 0) {
    return value;
  }
  return null;
}

async function checkMultipartAuth(
  fields: MultipartFields,
  env: Env,
): Promise<{ ok: true; tgId: number } | { ok: false; response: Response }> {
  if (!env.BOT_TOKEN) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'server_config' }) };
  }

  if (env.WEBAPP_SECRET && fieldString(fields, 'secret') !== env.WEBAPP_SECRET) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'invalid_secret' }) };
  }

  const initData = fieldString(fields, 'initData');
  if (!(await validateInitData(initData, env.BOT_TOKEN))) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'Invalid_initData' }) };
  }

  const tgId = getUserIdFromInitData(initData);
  if (!tgId) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'invalid_tg_id' }) };
  }

  return { ok: true, tgId };
}

function collectPhotoFiles(fields: MultipartFields): { position: number; file: File }[] {
  const photos: { position: number; file: File }[] = [];
  for (let i = 1; i <= MAX_PHOTOS; i++) {
    const file = fieldFile(fields, `photo_${i}`);
    if (file) {
      photos.push({ position: i, file });
    }
  }
  return photos;
}

async function processPhotoBytes(
  bytes: Uint8Array,
  position: number,
  r2Key: string,
  existingKey: string | null,
): Promise<
  | { ok: true; photo: ProcessedPhoto }
  | { ok: false; code: string }
> {
  console.log('[portfolio] processPhoto', position, bytes.byteLength);
  const validated = await validateImageBytes(bytes);
  if (!validated.ok) {
    return { ok: false, code: validated.code };
  }

  const compressed = await compressToWebp(bytes, validated.mime);
  if (!compressed.ok) {
    return { ok: false, code: compressed.code };
  }

  return {
    ok: true,
    photo: {
      position,
      data: compressed.data,
      width: compressed.width,
      height: compressed.height,
      byteSize: compressed.byteSize,
      r2Key,
      oldR2Key: existingKey,
    },
  };
}

async function processPhotoFile(
  file: File,
  position: number,
  r2Key: string,
  existingKey: string | null,
): Promise<
  | { ok: true; photo: ProcessedPhoto }
  | { ok: false; code: string }
> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  console.log('[portfolio] processPhoto file', position, file.size, file.type || '', bytes.byteLength);
  return processPhotoBytes(bytes, position, r2Key, existingKey);
}

function base64ToBytes(data: string): Uint8Array | null {
  const trimmed = data.replace(/\s/g, '');
  if (!trimmed) {
    return null;
  }
  try {
    const binary = atob(trimmed);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

async function checkJsonPortfolioAuth(
  body: Record<string, unknown>,
  env: Env,
): Promise<{ ok: true; tgId: number } | { ok: false; response: Response }> {
  if (!env.BOT_TOKEN) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'server_config' }) };
  }

  if (env.WEBAPP_SECRET && body.secret !== env.WEBAPP_SECRET) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'invalid_secret' }) };
  }

  const initData = String(body.initData ?? '');
  if (!(await validateInitData(initData, env.BOT_TOKEN))) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'Invalid_initData' }) };
  }

  const tgId = getUserIdFromInitData(initData);
  if (!tgId) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'invalid_tg_id' }) };
  }

  return { ok: true, tgId };
}

function parsePhotoPosition(body: Record<string, unknown>): number | null {
  const position = Number(body.position);
  if (!Number.isFinite(position) || position < 1 || position > MAX_PHOTOS) {
    return null;
  }
  return position;
}

async function readStagingExistingKeys(tgId: number, env: Env): Promise<Map<number, string>> {
  const existingKeys = new Map<number, string>();
  const prefix = `portfolio/staging/${tgId}/`;
  let cursor: string | undefined;
  do {
    const listed = await env.PORTFOLIO.list({ prefix, cursor });
    for (const obj of listed.objects) {
      const base = obj.key.slice(prefix.length, -'.webp'.length);
      const position = parseInt(base, 10);
      if (Number.isFinite(position)) {
        existingKeys.set(position, obj.key);
      }
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return existingKeys;
}

async function commitPhotos(
  photos: ProcessedPhoto[],
  listingId: string,
  env: Env,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const uploadedKeys: string[] = [];
  const insertedPositions: number[] = [];

  try {
    for (const photo of photos) {
      await putR2(env.PORTFOLIO, photo.r2Key, photo.data);
      uploadedKeys.push(photo.r2Key);

      await insertMedia(
        {
          listingId,
          position: photo.position,
          r2Key: photo.r2Key,
          byteSize: photo.byteSize,
          width: photo.width,
          height: photo.height,
          status: 'pending',
        },
        env.DB,
      );
      insertedPositions.push(photo.position);
    }

    const oldKeys = [...new Set(photos.map((p) => p.oldR2Key).filter(Boolean) as string[])].filter(
      (k) => !uploadedKeys.includes(k),
    );
    if (oldKeys.length > 0) {
      await deleteR2Keys(env.PORTFOLIO, oldKeys);
    }

    return { ok: true };
  } catch {
    await deleteR2Keys(env.PORTFOLIO, uploadedKeys);
    if (insertedPositions.length > 0) {
      const placeholders = insertedPositions.map(() => '?').join(', ');
      await env.DB.prepare(
        `DELETE FROM listing_media WHERE listing_id = ? AND position IN (${placeholders})`,
      )
        .bind(listingId, ...insertedPositions)
        .run();
    }
    return { ok: false, code: 'portfolio_upload_failed' };
  }
}

async function commitStagingPhotos(
  photos: ProcessedPhoto[],
  tgId: number,
  env: Env,
): Promise<{ ok: true } | { ok: false; code: string }> {
  const uploadedKeys: string[] = [];

  try {
    for (const photo of photos) {
      await putR2(env.PORTFOLIO, photo.r2Key, photo.data);
      uploadedKeys.push(photo.r2Key);
    }

    const oldKeys = [...new Set(photos.map((p) => p.oldR2Key).filter(Boolean) as string[])].filter(
      (k) => !uploadedKeys.includes(k),
    );
    if (oldKeys.length > 0) {
      await deleteR2Keys(env.PORTFOLIO, oldKeys);
    }

    return { ok: true };
  } catch {
    await deleteR2Keys(env.PORTFOLIO, uploadedKeys);
    return { ok: false, code: 'portfolio_upload_failed' };
  }
}

async function shouldSendDeferredNotify(
  listingId: string,
  env: Env,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS ok FROM admin_links WHERE listing_id = ? AND link_type = 'listing' LIMIT 1`,
  )
    .bind(listingId)
    .first<{ ok: number }>();
  return !row;
}

function buildFreeModerationAdminText(
  listingId: string,
  tgId: number,
  listing: {
    display_name: string;
    category: string;
    experience: string | null;
    description: string;
    contact_type: string | null;
    contacts: string;
  },
): string {
  return (
    '📋 МОДЕРАЦИЯ АНКЕТЫ\n' +
    `listing_id: ${listingId}\n` +
    `Пользователь ID: ${tgId}\n` +
    'Оплата: Бесплатное (первое)\n\n' +
    `Имя: ${listing.display_name}\n` +
    `Категория: ${listing.category}\n` +
    `Опыт/стаж: ${listing.experience || '—'}\n` +
    `Описание: ${decodeDescriptionNewlines(listing.description)}\n` +
    `Тип контакта: ${listing.contact_type || '—'}\n` +
    `Контакты: ${listing.contacts}\n\n` +
    '↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.'
  );
}

async function sendDeferredFreeNotify(
  listingId: string,
  tgId: number,
  env: Env,
): Promise<void> {
  const listing = await env.DB.prepare(
    `SELECT display_name, category, description, experience, contact_type, contacts
     FROM listings WHERE listing_id = ?`,
  )
    .bind(listingId)
    .first<{
      display_name: string;
      category: string;
      description: string;
      experience: string | null;
      contact_type: string | null;
      contacts: string;
    }>();

  if (!listing) {
    return;
  }

  const adminText = buildFreeModerationAdminText(listingId, tgId, listing);
  const portfolioCount = await getPortfolioCount(listingId, env.DB, { includePending: true });
  const adminMsgId = await sendMessage(
    env.ADMIN_TG_ID,
    adminText,
    await moderationKeyboard(listingId, portfolioCount, env),
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

function listingUploadError(status: string | undefined): Response {
  if (!status) {
    return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
  }
  if (status !== 'on_moderation') {
    return jsonResponse({ ok: false, error: 'portfolio_wrong_status' });
  }
  return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
}

export async function handleUploadPortfolio(
  fields: MultipartFields,
  env: Env,
): Promise<Response> {
  try {
    const auth = await checkMultipartAuth(fields, env);
    if (!auth.ok) {
      return auth.response;
    }
    const { tgId } = auth;

    const rate = await checkPortfolioRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({ ok: false, error: rate.error ?? 'portfolio_upload_failed' });
    }

    const listingId = fieldString(fields, 'listing_id');
    if (!listingId) {
      return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
    }

    const listing = await env.DB.prepare(
      `SELECT tg_id, status, submitted_at, display_name, category, description,
              experience, contact_type, contacts
       FROM listings WHERE listing_id = ?`,
    )
      .bind(listingId)
      .first<{
        tg_id: number;
        status: string;
        submitted_at: string;
        display_name: string;
        category: string;
        description: string;
        experience: string | null;
        contact_type: string | null;
        contacts: string;
      }>();

    if (!listing) {
      return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
    }

    if (listing.tg_id !== tgId) {
      return jsonResponse({ ok: false, error: 'portfolio_not_owner' });
    }

    if (listing.status !== 'on_moderation') {
      return listingUploadError(listing.status);
    }

    const submittedAt = new Date(listing.submitted_at).getTime();
    if (!Number.isFinite(submittedAt) || Date.now() - submittedAt > RETRY_WINDOW_MS) {
      return jsonResponse({ ok: false, error: 'portfolio_retry_expired' });
    }

    const photoFiles = collectPhotoFiles(fields);
    if (photoFiles.length === 0) {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }
    if (photoFiles.length > MAX_PHOTOS) {
      return jsonResponse({ ok: false, error: 'portfolio_too_many' });
    }

    const existingMedia = await listMediaByListing(listingId, env.DB);
    const existingByPosition = new Map(existingMedia.map((m) => [m.position, m.r2_key]));

    const processed: ProcessedPhoto[] = [];
    for (const { position, file } of photoFiles) {
      const r2Key = portfolioObjectKey(listingId, position);
      const result = await processPhotoFile(
        file,
        position,
        r2Key,
        existingByPosition.get(position) ?? null,
      );
      if (!result.ok) {
        return jsonResponse({ ok: false, error: result.code });
      }
      processed.push(result.photo);
    }

    const commit = await commitPhotos(processed, listingId, env);
    if (!commit.ok) {
      return jsonResponse({ ok: false, error: commit.code });
    }

    await incrementPortfolioRateLimit(tgId, env);

    const notify = await shouldSendDeferredNotify(listingId, env);
    if (notify) {
      await sendDeferredFreeNotify(listingId, tgId, env);
    }

    await logAction(tgId, 'upload_portfolio', listingId, env.DB);

    const count = await getPortfolioCount(listingId, env.DB, { includePending: true });
    return jsonResponse({
      ok: true,
      listing_id: listingId,
      portfolio_count: count,
      message: 'Фото загружены',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleUploadPortfolio: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
  }
}

export async function handleUploadPortfolioStaging(
  fields: MultipartFields,
  env: Env,
): Promise<Response> {
  try {
    const auth = await checkMultipartAuth(fields, env);
    if (!auth.ok) {
      return auth.response;
    }
    const { tgId } = auth;

    const rate = await checkPortfolioRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({ ok: false, error: rate.error ?? 'portfolio_upload_failed' });
    }

    const photoFiles = collectPhotoFiles(fields);
    if (photoFiles.length === 0) {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }
    if (photoFiles.length > MAX_PHOTOS) {
      return jsonResponse({ ok: false, error: 'portfolio_too_many' });
    }

    const existingKeys = await readStagingExistingKeys(tgId, env);

    const processed: ProcessedPhoto[] = [];
    for (const { position, file } of photoFiles) {
      const r2Key = stagingObjectKey(tgId, position);
      const result = await processPhotoFile(
        file,
        position,
        r2Key,
        existingKeys.get(position) ?? null,
      );
      if (!result.ok) {
        return jsonResponse({ ok: false, error: result.code });
      }
      processed.push(result.photo);
    }

    const commit = await commitStagingPhotos(processed, tgId, env);
    if (!commit.ok) {
      return jsonResponse({ ok: false, error: commit.code });
    }

    await incrementPortfolioRateLimit(tgId, env);
    await logAction(tgId, 'upload_portfolio_staging', String(processed.length), env.DB);

    return jsonResponse({
      ok: true,
      message: 'Фото сохранены',
      portfolio_count: processed.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleUploadPortfolioStaging: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
  }
}

export async function handleUploadPortfolioStagingB64(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const auth = await checkJsonPortfolioAuth(body, env);
    if (!auth.ok) {
      return auth.response;
    }
    const { tgId } = auth;

    const rate = await checkPortfolioRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({ ok: false, error: rate.error ?? 'portfolio_upload_failed' });
    }

    const position = parsePhotoPosition(body);
    if (!position) {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }

    const bytes = base64ToBytes(String(body.data ?? ''));
    if (!bytes || !bytes.byteLength) {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }

    const existingKeys = await readStagingExistingKeys(tgId, env);
    const r2Key = stagingObjectKey(tgId, position);
    const result = await processPhotoBytes(
      bytes,
      position,
      r2Key,
      existingKeys.get(position) ?? null,
    );
    if (!result.ok) {
      return jsonResponse({ ok: false, error: result.code });
    }

    const commit = await commitStagingPhotos([result.photo], tgId, env);
    if (!commit.ok) {
      return jsonResponse({ ok: false, error: commit.code });
    }

    await incrementPortfolioRateLimit(tgId, env);
    await logAction(tgId, 'upload_portfolio_staging_b64', String(position), env.DB);

    return jsonResponse({
      ok: true,
      message: 'Фото сохранены',
      portfolio_count: 1,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleUploadPortfolioStagingB64: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
  }
}

export async function handleUploadPortfolioB64(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const auth = await checkJsonPortfolioAuth(body, env);
    if (!auth.ok) {
      return auth.response;
    }
    const { tgId } = auth;

    const rate = await checkPortfolioRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({ ok: false, error: rate.error ?? 'portfolio_upload_failed' });
    }

    const listingId = String(body.listing_id ?? '').trim();
    if (!listingId) {
      return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
    }

    const listing = await env.DB.prepare(
      `SELECT tg_id, status, submitted_at, display_name, category, description,
              experience, contact_type, contacts
       FROM listings WHERE listing_id = ?`,
    )
      .bind(listingId)
      .first<{
        tg_id: number;
        status: string;
        submitted_at: string;
        display_name: string;
        category: string;
        description: string;
        experience: string | null;
        contact_type: string | null;
        contacts: string;
      }>();

    if (!listing) {
      return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
    }

    if (listing.tg_id !== tgId) {
      return jsonResponse({ ok: false, error: 'portfolio_not_owner' });
    }

    if (listing.status !== 'on_moderation') {
      return listingUploadError(listing.status);
    }

    const submittedAt = new Date(listing.submitted_at).getTime();
    if (!Number.isFinite(submittedAt) || Date.now() - submittedAt > RETRY_WINDOW_MS) {
      return jsonResponse({ ok: false, error: 'portfolio_retry_expired' });
    }

    const position = parsePhotoPosition(body);
    if (!position) {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }

    const bytes = base64ToBytes(String(body.data ?? ''));
    if (!bytes || !bytes.byteLength) {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }

    const existingMedia = await listMediaByListing(listingId, env.DB);
    const existingByPosition = new Map(existingMedia.map((m) => [m.position, m.r2_key]));
    const r2Key = portfolioObjectKey(listingId, position);
    const result = await processPhotoBytes(
      bytes,
      position,
      r2Key,
      existingByPosition.get(position) ?? null,
    );
    if (!result.ok) {
      return jsonResponse({ ok: false, error: result.code });
    }

    const commit = await commitPhotos([result.photo], listingId, env);
    if (!commit.ok) {
      return jsonResponse({ ok: false, error: commit.code });
    }

    await incrementPortfolioRateLimit(tgId, env);

    const notify = await shouldSendDeferredNotify(listingId, env);
    if (notify) {
      await sendDeferredFreeNotify(listingId, tgId, env);
    }

    await logAction(tgId, 'upload_portfolio_b64', listingId, env.DB);

    const count = await getPortfolioCount(listingId, env.DB, { includePending: true });
    return jsonResponse({
      ok: true,
      listing_id: listingId,
      portfolio_count: count,
      message: 'Фото загружены',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleUploadPortfolioB64: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
  }
}

export async function handleGetPortfolio(
  body: Record<string, unknown>,
  env: Env,
  workerOrigin: string,
): Promise<Response> {
  try {
    if (!env.BOT_TOKEN) {
      return jsonResponse({ ok: false, error: 'server_config' });
    }

    const listingId = String(body.listing_id ?? '').trim();
    if (!listingId) {
      return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
    }

    const listing = await env.DB.prepare(
      'SELECT tg_id, display_name, status FROM listings WHERE listing_id = ?',
    )
      .bind(listingId)
      .first<{ tg_id: number; display_name: string; status: string }>();

    if (!listing) {
      return jsonResponse({ ok: false, error: 'portfolio_listing_not_found' });
    }

    const view = String(body.view ?? '').trim();
    const adminToken = String(body.token ?? '').trim();
    const adminExp = String(body.exp ?? '').trim();

    let includePending = false;

    if (view === 'admin') {
      const valid = await verifyAdminPortfolioToken(listingId, adminToken, adminExp, env);
      if (!valid) {
        return jsonResponse({ ok: false, error: 'forbidden' });
      }
      includePending = true;
    } else {
      const initData = String(body.initData ?? '');
      if (env.WEBAPP_SECRET && body.secret !== env.WEBAPP_SECRET) {
        return jsonResponse({ ok: false, error: 'invalid_secret' });
      }
      if (!(await validateInitData(initData, env.BOT_TOKEN))) {
        return jsonResponse({ ok: false, error: 'Invalid_initData' });
      }

      const requesterId = getUserIdFromInitData(initData);
      if (requesterId === listing.tg_id) {
        includePending = true;
      }
    }

    const rows = await listMediaByListing(listingId, env.DB);
    const allowedStatuses = includePending
      ? new Set(['pending', 'active'])
      : new Set(['active']);

    const items = [];
    for (const row of rows) {
      if (!allowedStatuses.has(row.status)) {
        continue;
      }
      items.push({
        position: row.position,
        url: await createSignedMediaUrl(row.r2_key, workerOrigin, env),
        width: row.width,
        height: row.height,
      });
    }

    return jsonResponse({
      ok: true,
      listing_id: listingId,
      display_name: listing.display_name,
      items,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleGetPortfolio: ${msg}`, env.DB);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handlePortfolioMediaGet(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const r2Key = url.searchParams.get('key') ?? '';
  const exp = url.searchParams.get('exp') ?? '';
  const sig = url.searchParams.get('sig') ?? '';

  const valid = await verifySignedMediaRequest(r2Key, exp, sig, env);
  if (!valid) {
    return new Response('Forbidden', { status: 403, headers: corsHeadersForMedia() });
  }

  const object = await env.PORTFOLIO.get(r2Key);
  if (!object) {
    return new Response('Not Found', { status: 404, headers: corsHeadersForMedia() });
  }

  const headers = new Headers(corsHeadersForMedia());
  headers.set('Content-Type', object.httpMetadata?.contentType ?? 'image/webp');
  headers.set('Cache-Control', 'private, max-age=900');

  return new Response(object.body, { status: 200, headers });
}

function corsHeadersForMedia(): HeadersInit {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  };
}

export async function formDataToFields(formData: FormData): Promise<MultipartFields> {
  const fields: MultipartFields = new Map();
  formData.forEach((value, key) => {
    fields.set(key, value);
  });
  return fields;
}

export async function routeMultipartAction(
  fields: MultipartFields,
  env: Env,
): Promise<Response> {
  const action = fieldString(fields, 'action');
  switch (action) {
    case 'upload_portfolio':
      return handleUploadPortfolio(fields, env);
    case 'upload_portfolio_staging':
      return handleUploadPortfolioStaging(fields, env);
    default:
      return jsonResponse({ ok: false, error: 'unknown_action' });
  }
}
