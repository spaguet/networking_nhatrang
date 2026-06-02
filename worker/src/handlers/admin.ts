import { getConfig, QR_PAYMENT_METHODS } from '../config';
import type { Env } from '../env';
import { sendMessage } from '../services/telegram-api';
import {
  invalidateAppSettingsCache,
  loadAppSettingsMap,
  qrSettingKey,
  upsertAppSetting,
} from '../services/app-settings';
import { ensureGrandAdmin } from '../utils/admin-bootstrap';
import {
  assertAdminSession,
  assertGrandAdminSession,
  assertLoginAllowed,
  canBanTarget,
  clearLoginFailures,
  createAdminSession,
  deleteAdminSession,
  deleteAdminSessionsForTgId,
  getAdminRole,
  hashPassword,
  isAdmin,
  recordLoginFailure,
  rejectIfAdminUserBanned,
  resolveAdminLabel,
  validatePasswordStrength,
  verifyPassword,
} from '../utils/admin-auth';
import { getUserIdFromInitData, validateMiniAppRequest } from '../utils/auth';
import {
  banUser,
  ensureUser,
  findQrMethodByKey,
  isStaffTgId,
  logAction,
  unbanUser,
} from '../utils/helpers';
import { fetchAllMessagesForConversation } from '../utils/messaging-helpers';
import { jsonResponse } from '../utils/response';
import { clearSession } from './sessions';

const UNBAN_MESSAGE =
  '✅ Доступ к «Место Встречи» восстановлен. Вы снова можете пользоваться сервисом.';

const BAN_USER_MESSAGE = '🚫 Ваш телеграм-аккаунт забанен.';

const BANNED_PAGE_SIZE = 20;
const MAX_QR_IMAGE_BYTES = 5 * 1024 * 1024;

const PRICE_SETTING_KEYS = [
  'payment_amount_vnd',
  'payment_amount_crypto',
  'pin_price_week_vnd',
  'pin_price_week_crypto',
  'pin_price_month_vnd',
  'pin_price_month_crypto',
  'pin_price_lifetime_vnd',
  'pin_price_lifetime_crypto',
] as const;

type PriceSettingKey = (typeof PRICE_SETTING_KEYS)[number];

function getAdminToken(body: Record<string, unknown>): string {
  return String(body.adminToken ?? '').trim();
}

function parsePositiveInt(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    return null;
  }
  return n;
}

function getDefaultPriceSettings(env: Env): Record<PriceSettingKey, string> {
  const config = getConfig(env);
  return {
    payment_amount_vnd: config.paymentAmountVnd,
    payment_amount_crypto: config.paymentAmountCrypto,
    pin_price_week_vnd: config.pinPriceWeekVnd,
    pin_price_week_crypto: config.pinPriceWeekCrypto,
    pin_price_month_vnd: config.pinPriceMonthVnd,
    pin_price_month_crypto: config.pinPriceMonthCrypto,
    pin_price_lifetime_vnd: config.pinPriceLifetimeVnd,
    pin_price_lifetime_crypto: config.pinPriceLifetimeCrypto,
  };
}

function passwordsMatch(p1: string, p2: string): boolean {
  return p1 === p2;
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

function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png';
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return 'image/gif';
  }
  if (bytes.length >= 12) {
    const riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
    if (riff === 'RIFF' && webp === 'WEBP') {
      return 'image/webp';
    }
  }
  return null;
}

async function uploadPhotoGetFileId(
  env: Env,
  chatId: number,
  imageBytes: Uint8Array,
  mimeType: string,
): Promise<string | null> {
  const ext =
    mimeType === 'image/png'
      ? 'png'
      : mimeType === 'image/gif'
        ? 'gif'
        : mimeType === 'image/webp'
          ? 'webp'
          : 'jpg';

  const form = new FormData();
  form.append('chat_id', String(chatId));
  const blobBytes = new Uint8Array(imageBytes);
  form.append('photo', new Blob([blobBytes], { type: mimeType }), `qr.${ext}`);

  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendPhoto`;
  try {
    const response = await fetch(url, { method: 'POST', body: form });
    const text = await response.text();
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      result?: { photo?: { file_id: string }[] };
      description?: string;
    };
    if (!parsed.ok || !parsed.result?.photo?.length) {
      await logAction(
        chatId,
        'error',
        `admin_upload_qr telegram: ${parsed.description ?? text.slice(0, 200)}`,
        env.DB,
      );
      return null;
    }
    return parsed.result.photo[parsed.result.photo.length - 1].file_id;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(chatId, 'error', `admin_upload_qr: ${msg}`, env.DB);
    return null;
  }
}

async function requireInitDataUser(
  body: Record<string, unknown>,
  env: Env,
): Promise<{ tgId: number } | Response> {
  const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, 401);
  }

  const tgId = getUserIdFromInitData(String(body.initData ?? ''));
  if (!tgId) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  return { tgId };
}

async function bootstrapGrandAdminIfNeeded(env: Env, tgId: number): Promise<void> {
  const adminTgId = Number(env.ADMIN_TG_ID);
  if (!adminTgId || tgId !== adminTgId) {
    return;
  }
  await ensureGrandAdmin(env.DB, adminTgId);
}

async function getAdminRow(
  db: D1Database,
  tgId: number,
): Promise<{
  role: 'grand_admin' | 'admin';
  password_hash: string | null;
  password_salt: string | null;
} | null> {
  return db
    .prepare('SELECT role, password_hash, password_salt FROM admins WHERE tg_id = ?')
    .bind(tgId)
    .first<{
      role: 'grand_admin' | 'admin';
      password_hash: string | null;
      password_salt: string | null;
    }>();
}

export async function handleAdminCheckAccess(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const user = await requireInitDataUser(body, env);
  if (user instanceof Response) {
    return user;
  }

  await bootstrapGrandAdminIfNeeded(env, user.tgId);

  const role = await getAdminRole(env.DB, user.tgId);
  if (!role || !(await isAdmin(env.DB, user.tgId))) {
    return jsonResponse({ ok: true, isAdmin: false });
  }

  const row = await getAdminRow(env.DB, user.tgId);
  const needsPasswordSetup =
    role === 'grand_admin' && (!row || !row.password_hash);

  return jsonResponse({
    ok: true,
    isAdmin: true,
    role,
    needsPasswordSetup: !!needsPasswordSetup,
  });
}

export async function handleAdminEnsureGrandAdmin(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const user = await requireInitDataUser(body, env);
  if (user instanceof Response) {
    return user;
  }

  const adminTgId = Number(env.ADMIN_TG_ID);
  if (!adminTgId || user.tgId !== adminTgId) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }

  const result = await ensureGrandAdmin(env.DB, adminTgId);
  return jsonResponse({ ok: true, seeded: result.seeded });
}

export async function handleAdminSetupPassword(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const user = await requireInitDataUser(body, env);
  if (user instanceof Response) {
    return user;
  }

  const banned = await rejectIfAdminUserBanned(user.tgId, env.DB);
  if (banned) {
    return banned;
  }

  await bootstrapGrandAdminIfNeeded(env, user.tgId);

  const role = await getAdminRole(env.DB, user.tgId);
  if (role !== 'grand_admin') {
    return jsonResponse({ ok: false, error: 'not_grand_admin' }, 403);
  }

  const row = await getAdminRow(env.DB, user.tgId);
  if (row?.password_hash) {
    return jsonResponse({ ok: false, error: 'already_setup' }, 400);
  }

  const password = String(body.password ?? '');
  const passwordConfirm = String(body.passwordConfirm ?? '');

  if (!passwordsMatch(password, passwordConfirm)) {
    return jsonResponse({ ok: false, error: 'passwords_mismatch' }, 400);
  }
  if (!validatePasswordStrength(password)) {
    return jsonResponse({ ok: false, error: 'password_too_weak' }, 400);
  }

  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      'UPDATE admins SET password_hash = ?, password_salt = ?, updated_at = ? WHERE tg_id = ?',
    )
    .bind(hash, salt, now, user.tgId)
    .run();

  const adminToken = await createAdminSession(env, user.tgId, 'grand_admin');
  await logAction(user.tgId, 'admin_setup_password', String(user.tgId), env.DB);

  await sendMessage(
    user.tgId,
    'Пароль администратора установлен. Храните его в надёжном месте.',
    null,
    env,
  );

  return jsonResponse({
    ok: true,
    adminToken,
    role: 'grand_admin',
  });
}

export async function handleAdminLogin(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const user = await requireInitDataUser(body, env);
  if (user instanceof Response) {
    return user;
  }

  const blocked = await assertLoginAllowed(env, user.tgId);
  if (blocked) {
    return blocked;
  }

  const banned = await rejectIfAdminUserBanned(user.tgId, env.DB);
  if (banned) {
    return banned;
  }

  const role = await getAdminRole(env.DB, user.tgId);
  if (!role) {
    return jsonResponse({ ok: false, error: 'not_admin' }, 403);
  }

  const row = await getAdminRow(env.DB, user.tgId);
  if (!row?.password_hash || !row.password_salt) {
    return jsonResponse({ ok: false, error: 'not_admin' }, 403);
  }

  const password = String(body.password ?? '');
  const valid = await verifyPassword(password, row.password_hash, row.password_salt);
  if (!valid) {
    await recordLoginFailure(env, user.tgId);
    await logAction(user.tgId, 'admin_login', 'fail', env.DB);
    if (await assertLoginAllowed(env, user.tgId)) {
      return jsonResponse({ ok: false, error: 'too_many_attempts' }, 429);
    }
    return jsonResponse({ ok: false, error: 'invalid_password' }, 401);
  }

  await clearLoginFailures(env, user.tgId);
  const adminToken = await createAdminSession(env, user.tgId, role);
  await logAction(user.tgId, 'admin_login', 'success', env.DB);

  return jsonResponse({ ok: true, adminToken, role });
}

export async function handleAdminLogout(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  await deleteAdminSession(env, token);
  return jsonResponse({ ok: true });
}

export async function handleAdminVerifySession(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  return jsonResponse({ ok: true, valid: true, role: session.role });
}

export async function handleAdminChangePassword(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const currentPassword = String(body.currentPassword ?? '');
  const password = String(body.password ?? '');
  const passwordConfirm = String(body.passwordConfirm ?? '');

  if (!passwordsMatch(password, passwordConfirm)) {
    return jsonResponse({ ok: false, error: 'passwords_mismatch' }, 400);
  }
  if (!validatePasswordStrength(password)) {
    return jsonResponse({ ok: false, error: 'password_too_weak' }, 400);
  }

  const row = await getAdminRow(env.DB, session.tgId);
  if (!row?.password_hash || !row.password_salt) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }

  const currentValid = await verifyPassword(
    currentPassword,
    row.password_hash,
    row.password_salt,
  );
  if (!currentValid) {
    return jsonResponse({ ok: false, error: 'invalid_password' }, 401);
  }

  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();
  await env.DB
    .prepare(
      'UPDATE admins SET password_hash = ?, password_salt = ?, updated_at = ? WHERE tg_id = ?',
    )
    .bind(hash, salt, now, session.tgId)
    .run();

  await logAction(session.tgId, 'admin_change_password', String(session.tgId), env.DB);
  return jsonResponse({ ok: true });
}

export async function handleAdminGetSettings(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertGrandAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const defaults = getDefaultPriceSettings(env);
  const stored = await loadAppSettingsMap(env.DB);
  const settings: Record<string, string> = { ...defaults };
  for (let i = 0; i < PRICE_SETTING_KEYS.length; i++) {
    const key = PRICE_SETTING_KEYS[i];
    const value = stored.get(key);
    if (value != null && value !== '') {
      settings[key] = value;
    }
  }

  const qr: Record<string, { configured: boolean; source: string }> = {};
  for (let i = 0; i < QR_PAYMENT_METHODS.length; i++) {
    const method = QR_PAYMENT_METHODS[i];
    const d1Key = qrSettingKey(method.methodKey);
    const d1Value = stored.get(d1Key);
    const envValue = env[method.propertyKey];
    qr[method.methodKey] = {
      configured: !!(d1Value || envValue),
      source: d1Value ? 'd1' : envValue ? 'env' : 'none',
    };
  }

  return jsonResponse({ ok: true, settings, qr });
}

export async function handleAdminUpdateSettings(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertGrandAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const rawSettings = body.settings;
  if (!rawSettings || typeof rawSettings !== 'object' || Array.isArray(rawSettings)) {
    return jsonResponse({ ok: false, error: 'invalid_settings' }, 400);
  }

  const input = rawSettings as Record<string, unknown>;
  const changedKeys: string[] = [];

  for (let i = 0; i < PRICE_SETTING_KEYS.length; i++) {
    const key = PRICE_SETTING_KEYS[i];
    if (!(key in input)) {
      continue;
    }
    const value = String(input[key] ?? '').trim();
    if (!value) {
      return jsonResponse({ ok: false, error: 'invalid_settings' }, 400);
    }
    await upsertAppSetting(env.DB, key, value, session.tgId);
    changedKeys.push(key);
  }

  if (changedKeys.length === 0) {
    return jsonResponse({ ok: false, error: 'invalid_settings' }, 400);
  }

  await invalidateAppSettingsCache(env);
  await logAction(
    session.tgId,
    'admin_settings_update',
    changedKeys.join(','),
    env.DB,
  );

  return jsonResponse({ ok: true, updated: changedKeys });
}

export async function handleAdminUploadQr(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertGrandAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const methodKey = String(body.methodKey ?? '').trim().toLowerCase();
  const method = findQrMethodByKey(methodKey);
  if (!method) {
    return jsonResponse({ ok: false, error: 'invalid_method' }, 400);
  }

  const bytes = base64ToBytes(String(body.data ?? body.image ?? ''));
  if (!bytes || bytes.byteLength === 0) {
    return jsonResponse({ ok: false, error: 'invalid_image' }, 400);
  }
  if (bytes.byteLength > MAX_QR_IMAGE_BYTES) {
    return jsonResponse({ ok: false, error: 'image_too_large' }, 400);
  }

  const mimeType = detectImageMime(bytes);
  if (!mimeType) {
    return jsonResponse({ ok: false, error: 'invalid_image' }, 400);
  }

  const fileId = await uploadPhotoGetFileId(env, session.tgId, bytes, mimeType);
  if (!fileId) {
    return jsonResponse({ ok: false, error: 'upload_failed' }, 500);
  }

  const settingKey = qrSettingKey(methodKey);
  await upsertAppSetting(env.DB, settingKey, fileId, session.tgId);
  await invalidateAppSettingsCache(env);
  await logAction(session.tgId, 'admin_qr_upload', methodKey, env.DB);

  return jsonResponse({ ok: true, methodKey, fileId });
}

export async function handleAdminGetStats(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const row = await env.DB
    .prepare("SELECT COUNT(*) AS cnt FROM listings WHERE status = 'active'")
    .first<{ cnt: number }>();

  return jsonResponse({ ok: true, activeListings: row?.cnt ?? 0 });
}

export async function handleAdminListBanned(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const page = Math.max(1, parsePositiveInt(body.page) ?? 1);
  const offset = (page - 1) * BANNED_PAGE_SIZE;

  const totalRow = await env.DB
    .prepare('SELECT COUNT(*) AS cnt FROM users WHERE banned = 1')
    .first<{ cnt: number }>();
  const total = totalRow?.cnt ?? 0;

  const { results } = await env.DB
    .prepare(
      `SELECT tg_id, username, first_name, banned_at, banned_by
       FROM users
       WHERE banned = 1
       ORDER BY banned_at DESC, tg_id DESC
       LIMIT ? OFFSET ?`,
    )
    .bind(BANNED_PAGE_SIZE, offset)
    .all<{
      tg_id: number;
      username: string | null;
      first_name: string;
      banned_at: string | null;
      banned_by: number | null;
    }>();

  const users: Record<string, unknown>[] = [];
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      let bannedByLabel = '';
      if (row.banned_by) {
        bannedByLabel = await resolveAdminLabel(env.DB, row.banned_by);
        const bannedByRole = await getAdminRole(env.DB, row.banned_by);
        if (bannedByRole) {
          bannedByLabel += ` (${bannedByRole === 'grand_admin' ? 'главный' : 'админ'})`;
        }
      }
      users.push({
        tgId: row.tg_id,
        username: row.username,
        firstName: row.first_name,
        bannedAt: row.banned_at,
        bannedBy: row.banned_by,
        bannedByLabel,
      });
    }
  }

  return jsonResponse({ ok: true, users, total, page });
}

export async function handleAdminUnbanUser(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const targetTgId = parsePositiveInt(body.targetTgId ?? body.tgId);
  if (!targetTgId) {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  if (targetTgId === session.tgId) {
    return jsonResponse({ ok: false, error: 'cannot_unban_self' }, 403);
  }

  if (await isStaffTgId(env.DB, targetTgId)) {
    return jsonResponse({ ok: false, error: 'cannot_unban_staff' }, 403);
  }

  const bannedRow = await env.DB
    .prepare('SELECT banned FROM users WHERE tg_id = ?')
    .bind(targetTgId)
    .first<{ banned: number }>();

  if (!bannedRow || bannedRow.banned !== 1) {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  await unbanUser(targetTgId, env.DB);
  await sendMessage(targetTgId, UNBAN_MESSAGE, null, env);
  await logAction(
    session.tgId,
    'admin_unban',
    String(targetTgId),
    env.DB,
  );

  return jsonResponse({ ok: true, tgId: targetTgId });
}

export async function handleAdminListAdmins(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertGrandAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const { results } = await env.DB
    .prepare(
      `SELECT a.tg_id, a.created_at, a.created_by, u.username, u.first_name
       FROM admins a
       LEFT JOIN users u ON u.tg_id = a.tg_id
       WHERE a.role = 'admin'
       ORDER BY a.created_at ASC`,
    )
    .all<{
      tg_id: number;
      created_at: string;
      created_by: number | null;
      username: string | null;
      first_name: string | null;
    }>();

  const admins: Record<string, unknown>[] = [];
  if (results) {
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      const createdByLabel = row.created_by
        ? await resolveAdminLabel(env.DB, row.created_by)
        : '';
      admins.push({
        tgId: row.tg_id,
        username: row.username,
        firstName: row.first_name || '—',
        createdAt: row.created_at,
        createdBy: row.created_by,
        createdByLabel,
      });
    }
  }

  return jsonResponse({ ok: true, admins });
}

export async function handleAdminAddAdmin(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertGrandAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const targetTgId = parsePositiveInt(body.targetTgId);
  if (!targetTgId) {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  const adminTgId = Number(env.ADMIN_TG_ID);
  if (targetTgId === adminTgId) {
    return jsonResponse({ ok: false, error: 'cannot_add_grand_admin' }, 400);
  }

  const existing = await getAdminRole(env.DB, targetTgId);
  if (existing) {
    return jsonResponse({ ok: false, error: 'duplicate_admin' }, 400);
  }

  const password = String(body.password ?? '');
  const passwordConfirm = String(body.passwordConfirm ?? '');

  if (!passwordsMatch(password, passwordConfirm)) {
    return jsonResponse({ ok: false, error: 'passwords_mismatch' }, 400);
  }
  if (!validatePasswordStrength(password)) {
    return jsonResponse({ ok: false, error: 'password_too_weak' }, 400);
  }

  const { hash, salt } = await hashPassword(password);
  const now = new Date().toISOString();

  await ensureUser(targetTgId, '', '', env.DB);

  await env.DB
    .prepare(
      `INSERT INTO admins (tg_id, role, password_hash, password_salt, created_at, created_by, updated_at)
       VALUES (?, 'admin', ?, ?, ?, ?, ?)`,
    )
    .bind(targetTgId, hash, salt, now, session.tgId, now)
    .run();

  await logAction(session.tgId, 'admin_add_admin', String(targetTgId), env.DB);

  await sendMessage(
    targetTgId,
    'Вас назначили администратором «Место Встречи». Откройте Mini App → кнопка «Админ» → войдите с паролем, который передал главный администратор.',
    null,
    env,
  );

  return jsonResponse({ ok: true, added: { tgId: targetTgId } });
}

export async function handleAdminRemoveAdmin(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertGrandAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const targetTgId = parsePositiveInt(body.targetTgId);
  if (!targetTgId) {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  const targetRole = await getAdminRole(env.DB, targetTgId);
  if (targetRole !== 'admin') {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  await env.DB.prepare('DELETE FROM admins WHERE tg_id = ? AND role = ?').bind(targetTgId, 'admin').run();
  await deleteAdminSessionsForTgId(env, targetTgId);
  await logAction(session.tgId, 'admin_remove_admin', String(targetTgId), env.DB);

  return jsonResponse({ ok: true, removed: { tgId: targetTgId } });
}

interface MessageComplaintRow {
  complaint_id: string;
  conversation_id: string;
  reporter_tg_id: number;
  body: string;
  created_at: string;
  participant_a_tg_id: number;
  participant_b_tg_id: number;
  status: string;
  resolved_at: string | null;
  resolved_by: number | null;
  punished_tg_id: number | null;
}

export async function handleAdminListMessageComplaints(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const { results } = await env.DB.prepare(
    `SELECT complaint_id, conversation_id, reporter_tg_id, created_at,
            participant_a_tg_id, participant_b_tg_id, punished_tg_id
     FROM message_complaints
     WHERE status = 'open'
     ORDER BY created_at DESC`,
  ).all<{
    complaint_id: string;
    conversation_id: string;
    reporter_tg_id: number;
    created_at: string;
    participant_a_tg_id: number;
    participant_b_tg_id: number;
    punished_tg_id: number | null;
  }>();

  return jsonResponse({ ok: true, complaints: results ?? [] });
}

export async function handleAdminGetComplaintBody(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const complaintId = String(body.complaint_id ?? '').trim();
  if (!complaintId) {
    return jsonResponse({ ok: false, error: 'missing_params' }, 400);
  }

  const row = await env.DB.prepare(
    'SELECT body FROM message_complaints WHERE complaint_id = ?',
  )
    .bind(complaintId)
    .first<{ body: string }>();

  if (!row) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }

  return jsonResponse({ ok: true, body: row.body });
}

export async function handleAdminGetConversationLog(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const complaintId = String(body.complaint_id ?? '').trim();
  if (!complaintId) {
    return jsonResponse({ ok: false, error: 'missing_params' }, 400);
  }

  const complaint = await env.DB.prepare(
    `SELECT complaint_id, conversation_id, participant_a_tg_id, participant_b_tg_id,
            punished_tg_id, status
     FROM message_complaints WHERE complaint_id = ?`,
  )
    .bind(complaintId)
    .first<MessageComplaintRow>();

  if (!complaint) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }

  const messages = await fetchAllMessagesForConversation(
    env.DB,
    complaint.conversation_id,
  );

  const participantAIsStaff = await isStaffTgId(env.DB, complaint.participant_a_tg_id);
  const participantBIsStaff = await isStaffTgId(env.DB, complaint.participant_b_tg_id);

  return jsonResponse({
    ok: true,
    complaint_id: complaint.complaint_id,
    conversation_id: complaint.conversation_id,
    participant_a_tg_id: complaint.participant_a_tg_id,
    participant_b_tg_id: complaint.participant_b_tg_id,
    participant_a_is_staff: participantAIsStaff,
    participant_b_is_staff: participantBIsStaff,
    punished_tg_id: complaint.punished_tg_id,
    status: complaint.status,
    messages,
  });
}

export async function handleAdminPunishFromComplaint(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  const token = getAdminToken(body);
  const session = await assertAdminSession(env, body, token);
  if (session instanceof Response) {
    return session;
  }

  const complaintId = String(body.complaint_id ?? '').trim();
  const targetTgId = parsePositiveInt(body.target_tg_id ?? body.targetTgId);
  if (!complaintId || !targetTgId) {
    return jsonResponse({ ok: false, error: 'missing_params' }, 400);
  }

  const complaint = await env.DB.prepare(
    `SELECT complaint_id, conversation_id, participant_a_tg_id, participant_b_tg_id,
            status, punished_tg_id
     FROM message_complaints WHERE complaint_id = ?`,
  )
    .bind(complaintId)
    .first<MessageComplaintRow>();

  if (!complaint) {
    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }
  if (complaint.status !== 'open') {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  if (
    targetTgId !== complaint.participant_a_tg_id &&
    targetTgId !== complaint.participant_b_tg_id
  ) {
    return jsonResponse({ ok: false, error: 'invalid_target' }, 400);
  }

  const banCheck = await canBanTarget(session.tgId, targetTgId, env.DB);
  if (!banCheck.ok) {
    return jsonResponse({ ok: false, error: 'forbidden', message: banCheck.message }, 403);
  }

  await ensureUser(targetTgId, '', '', env.DB);
  await banUser(targetTgId, '', '', session.tgId, env.DB);
  await clearSession(targetTgId, env);
  await sendMessage(targetTgId, BAN_USER_MESSAGE, null, env);

  const now = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE message_complaints
       SET status = 'resolved', punished_tg_id = ?, resolved_by = ?, resolved_at = ?
       WHERE conversation_id = ? AND status = 'open'`,
    ).bind(targetTgId, session.tgId, now, complaint.conversation_id),
    env.DB.prepare(
      `UPDATE conversations SET status = 'closed' WHERE conversation_id = ?`,
    ).bind(complaint.conversation_id),
  ]);

  await logAction(session.tgId, 'admin_punish_complaint', String(targetTgId), env.DB);

  return jsonResponse({ ok: true, punished_tg_id: targetTgId });
}

/** Routes admin_* actions; returns null if action is not admin-related. */
export async function routeAdminAction(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response | null> {
  const action = body.action;
  if (typeof action !== 'string' || !action.startsWith('admin_')) {
    return null;
  }

  switch (action) {
    case 'admin_check_access':
      return handleAdminCheckAccess(body, env);
    case 'admin_ensure_grand_admin':
      return handleAdminEnsureGrandAdmin(body, env);
    case 'admin_setup_password':
      return handleAdminSetupPassword(body, env);
    case 'admin_login':
      return handleAdminLogin(body, env);
    case 'admin_logout':
      return handleAdminLogout(body, env);
    case 'admin_verify_session':
      return handleAdminVerifySession(body, env);
    case 'admin_change_password':
      return handleAdminChangePassword(body, env);
    case 'admin_get_settings':
      return handleAdminGetSettings(body, env);
    case 'admin_update_settings':
      return handleAdminUpdateSettings(body, env);
    case 'admin_upload_qr':
      return handleAdminUploadQr(body, env);
    case 'admin_get_stats':
      return handleAdminGetStats(body, env);
    case 'admin_list_banned':
      return handleAdminListBanned(body, env);
    case 'admin_unban_user':
      return handleAdminUnbanUser(body, env);
    case 'admin_list_admins':
      return handleAdminListAdmins(body, env);
    case 'admin_add_admin':
      return handleAdminAddAdmin(body, env);
    case 'admin_remove_admin':
      return handleAdminRemoveAdmin(body, env);
    case 'admin_list_message_complaints':
      return handleAdminListMessageComplaints(body, env);
    case 'admin_get_complaint_body':
      return handleAdminGetComplaintBody(body, env);
    case 'admin_get_conversation_log':
      return handleAdminGetConversationLog(body, env);
    case 'admin_punish_from_complaint':
      return handleAdminPunishFromComplaint(body, env);
    default:
      return jsonResponse({ ok: false, error: 'unknown_action' });
  }
}
