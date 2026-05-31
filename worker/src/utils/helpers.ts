import { QR_PAYMENT_METHODS, type AppConfig, type QrPaymentMethod } from '../config';
import type { Env } from '../env';
import { jsonResponse } from './response';

export interface BlockingListing {
  listing_id: string;
  display_name: string;
  category: string;
  status: string;
  payment_status: string;
  expires_at: string | null;
}

export interface UserListingMode {
  paid_mode: boolean;
  can_submit_free: boolean;
  blocking: BlockingListing | null;
  freeUsed: boolean;
  banner: string;
}

function parseStoredDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function generateId(tgId: number): string {
  return `${tgId}_${Date.now()}`;
}

export function formatDateRu(date: Date | string | null | undefined): string {
  if (!date) {
    return '';
  }
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
}

export function findQrMethodByKey(methodKey: string): QrPaymentMethod | null {
  for (let i = 0; i < QR_PAYMENT_METHODS.length; i++) {
    if (QR_PAYMENT_METHODS[i].methodKey === methodKey) {
      return QR_PAYMENT_METHODS[i];
    }
  }
  return null;
}

export function paymentMethodLabel(methodKey: string): string {
  const method = findQrMethodByKey(methodKey);
  return method ? method.sendCaption : String(methodKey || '—');
}

export function buildPaidModeBanner(
  blocking: BlockingListing | null,
  freeUsed: boolean,
): string {
  const suffix =
    ' Второе размещение ПЛАТНО или бесплатно после окончания срока (30 дней со дня размещения).';

  if (blocking && blocking.status === 'active') {
    const until = blocking.expires_at ? formatDateRu(blocking.expires_at) : '';
    return (
      `Бесплатная анкета от «${blocking.display_name}» уже была опубликована в каталоге («${blocking.category}»).` +
      (until ? ` Срок размещения бесплатной публикации до ${until}.` : '') +
      suffix
    );
  }

  if (blocking && blocking.status === 'on_moderation') {
    return (
      `Анкета «${blocking.display_name}» («${blocking.category}») на модерации.` +
      suffix
    );
  }

  if (freeUsed) {
    return `Бесплатное размещение уже использовано.${suffix}`;
  }

  return '';
}

export async function findBlockingListing(
  tgId: number,
  db: D1Database,
): Promise<BlockingListing | null> {
  const { results } = await db
    .prepare(
      `SELECT listing_id, display_name, category, status, payment_status, expires_at, submitted_at
       FROM listings
       WHERE tg_id = ? AND status IN ('on_moderation', 'active')`,
    )
    .bind(tgId)
    .all<{
      listing_id: string;
      display_name: string;
      category: string;
      status: string;
      payment_status: string;
      expires_at: string | null;
      submitted_at: string;
    }>();

  if (!results || results.length === 0) {
    return null;
  }

  let activeBest: BlockingListing | null = null;
  let activeTime = 0;
  let modBest: BlockingListing | null = null;
  let modTime = 0;

  for (let i = 0; i < results.length; i++) {
    const row = results[i];
    const submittedAt = parseStoredDate(row.submitted_at);
    const rowTime = submittedAt ? submittedAt.getTime() : i;
    const item: BlockingListing = {
      listing_id: row.listing_id,
      display_name: row.display_name,
      category: row.category,
      status: row.status,
      payment_status: row.payment_status,
      expires_at: row.expires_at,
    };

    if (row.status === 'active' && rowTime >= activeTime) {
      activeTime = rowTime;
      activeBest = item;
    }
    if (row.status === 'on_moderation' && rowTime >= modTime) {
      modTime = rowTime;
      modBest = item;
    }
  }

  return activeBest || modBest;
}

export async function ensureUser(
  tgId: number,
  username: string,
  firstName: string,
  db: D1Database,
): Promise<void> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO users (tg_id, username, first_name, reg_date, free_used)
       VALUES (?, ?, ?, ?, 0)`,
    )
    .bind(tgId, username || null, firstName, now)
    .run();
}

export async function getUserFreeUsed(
  tgId: number,
  db: D1Database,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT free_used FROM users WHERE tg_id = ?')
    .bind(tgId)
    .first<{ free_used: number }>();

  return row ? row.free_used === 1 : false;
}

export async function setUserFreeUsed(
  tgId: number,
  value: boolean,
  db: D1Database,
): Promise<void> {
  await db
    .prepare('UPDATE users SET free_used = ? WHERE tg_id = ?')
    .bind(value ? 1 : 0, tgId)
    .run();
}

export async function getUserListingMode(
  tgId: number,
  username: string | undefined,
  firstName: string | undefined,
  env: Env,
): Promise<UserListingMode> {
  if (username !== undefined) {
    await ensureUser(tgId, username || '', firstName || '', env.DB);
  }

  const blocking = await findBlockingListing(tgId, env.DB);
  const freeUsed = await getUserFreeUsed(tgId, env.DB);
  const paid_mode = !!(blocking || freeUsed);

  return {
    paid_mode,
    can_submit_free: !paid_mode,
    blocking,
    freeUsed,
    banner: buildPaidModeBanner(blocking, freeUsed),
  };
}

export function getPinDurationLabel(duration: string): string {
  if (duration === 'week') {
    return 'Неделя (7 дней)';
  }
  if (duration === 'month') {
    return 'Месяц (30 дней)';
  }
  if (duration === 'lifetime') {
    return 'Бессрочно с авто-размещением';
  }
  return duration;
}

export function getPinDurationShortLabel(duration: string): string {
  if (duration === 'week') {
    return 'Неделя';
  }
  if (duration === 'month') {
    return 'Месяц';
  }
  if (duration === 'lifetime') {
    return 'Бессрочно с авто-размещением';
  }
  return duration;
}

export function getPinExpiresDate(duration: string): string {
  if (duration === 'lifetime') {
    return 'lifetime';
  }
  const d = new Date();
  if (duration === 'week') {
    d.setDate(d.getDate() + 7);
  }
  if (duration === 'month') {
    d.setDate(d.getDate() + 30);
  }
  return d.toISOString();
}

export function getPinPriceByDuration(
  config: AppConfig,
  duration: string,
  methodKey: string,
): string {
  const isVnd = String(methodKey || '').trim().toLowerCase() === 'vnd';
  if (duration === 'week') {
    return isVnd ? config.pinPriceWeekVnd : config.pinPriceWeekCrypto;
  }
  if (duration === 'month') {
    return isVnd ? config.pinPriceMonthVnd : config.pinPriceMonthCrypto;
  }
  if (duration === 'lifetime') {
    return isVnd ? config.pinPriceLifetimeVnd : config.pinPriceLifetimeCrypto;
  }
  return '';
}

export async function isUserBanned(tgId: number, db: D1Database): Promise<boolean> {
  const row = await db
    .prepare('SELECT banned FROM users WHERE tg_id = ?')
    .bind(tgId)
    .first<{ banned: number }>();

  return row?.banned === 1;
}

export async function banUser(
  tgId: number,
  username: string,
  firstName: string,
  db: D1Database,
): Promise<void> {
  await ensureUser(tgId, username, firstName, db);
  await db.prepare('UPDATE users SET banned = 1 WHERE tg_id = ?').bind(tgId).run();
}

export function bannedApiResponse(): Response {
  return jsonResponse({
    ok: false,
    error: 'user_banned',
    message: 'Ваш телеграм-аккаунт забанен',
    banned: true,
  });
}

export async function rejectIfBanned(
  tgId: number,
  db: D1Database,
): Promise<Response | null> {
  if (!tgId || !(await isUserBanned(tgId, db))) {
    return null;
  }
  return bannedApiResponse();
}

export async function logAction(
  tgId: number | null,
  action: string,
  details: string | null,
  db: D1Database,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await db
      .prepare(
        'INSERT INTO logs (timestamp, tg_id, action, details) VALUES (?, ?, ?, ?)',
      )
      .bind(now, tgId, action, details)
      .run();
  } catch {
    // silent fail — matches Code.gs logAction
  }
}
