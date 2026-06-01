import type { Env } from '../env';
import type { AdminRole } from '../types';
import { getUserIdFromInitData, validateMiniAppRequest } from './auth';
import { isUserBanned } from './helpers';
import { jsonResponse } from './response';

const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const DERIVED_BITS = 256;
const SLIDING_TTL_MS = 8 * 60 * 60 * 1000;
const HARD_MAX_MS = 24 * 60 * 60 * 1000;
const LOGIN_FAIL_MAX = 5;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_BLOCK_TTL_SEC = 1800;

const SESSION_KEY_PREFIX = 'admin_session:';
const LOGIN_FAIL_KEY_PREFIX = 'admin_login_fail:';
const TG_SESSION_INDEX_PREFIX = 'admin_tg_session_index:';

export interface AdminSessionData {
  tgId: number;
  role: AdminRole;
  createdAt: string;
  lastActivityAt: string;
}

export interface LoginFailRecord {
  count: number;
  windowStart: number;
  blockedUntil?: number;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function sessionKvTtlSec(createdAt: string): number {
  const now = Date.now();
  const createdMs = new Date(createdAt).getTime();
  const remainingHardMs = HARD_MAX_MS - (now - createdMs);
  const ttlMs = Math.min(SLIDING_TTL_MS, remainingHardMs);
  return Math.max(1, Math.floor(ttlMs / 1000));
}

function isSessionExpired(session: AdminSessionData, nowMs = Date.now()): boolean {
  const createdMs = new Date(session.createdAt).getTime();
  const lastMs = new Date(session.lastActivityAt).getTime();
  if (nowMs - createdMs >= HARD_MAX_MS) {
    return true;
  }
  if (nowMs - lastMs >= SLIDING_TTL_MS) {
    return true;
  }
  return false;
}

function tgSessionIndexKey(tgId: number): string {
  return `${TG_SESSION_INDEX_PREFIX}${tgId}`;
}

async function readTgSessionTokens(env: Env, tgId: number): Promise<string[]> {
  const raw = await env.CACHE.get(tgSessionIndexKey(tgId));
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((t): t is string => typeof t === 'string')
      : [];
  } catch {
    return [];
  }
}

async function appendTgSessionToken(
  env: Env,
  tgId: number,
  token: string,
): Promise<void> {
  const tokens = await readTgSessionTokens(env, tgId);
  if (!tokens.includes(token)) {
    tokens.push(token);
  }
  await env.CACHE.put(tgSessionIndexKey(tgId), JSON.stringify(tokens), {
    expirationTtl: Math.ceil(HARD_MAX_MS / 1000),
  });
}

async function removeTgSessionToken(
  env: Env,
  tgId: number,
  token: string,
): Promise<void> {
  const tokens = (await readTgSessionTokens(env, tgId)).filter((t) => t !== token);
  if (tokens.length === 0) {
    await env.CACHE.delete(tgSessionIndexKey(tgId));
    return;
  }
  await env.CACHE.put(tgSessionIndexKey(tgId), JSON.stringify(tokens), {
    expirationTtl: Math.ceil(HARD_MAX_MS / 1000),
  });
}

/** §1.2 A3 — min 12 chars, ≥1 letter, ≥1 digit. */
export function validatePasswordStrength(password: string): boolean {
  if (password.length < 12) {
    return false;
  }
  if (!/[a-zA-Z\u0400-\u04FF]/.test(password)) {
    return false;
  }
  if (!/\d/.test(password)) {
    return false;
  }
  return true;
}

/** PBKDF2-SHA256; salt/hash stored as base64. */
export async function hashPassword(
  password: string,
): Promise<{ hash: string; salt: string }> {
  const saltBytes = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordHash(password, saltBytes);
  return {
    hash: bytesToBase64(hash),
    salt: bytesToBase64(saltBytes),
  };
}

async function derivePasswordHash(
  password: string,
  saltBytes: Uint8Array,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: new Uint8Array(saltBytes),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    DERIVED_BITS,
  );

  return new Uint8Array(derived);
}

export async function verifyPassword(
  password: string,
  hashBase64: string,
  saltBase64: string,
): Promise<boolean> {
  if (!hashBase64 || !saltBase64) {
    return false;
  }

  try {
    const saltBytes = base64ToBytes(saltBase64);
    const expectedHash = base64ToBytes(hashBase64);
    const derived = await derivePasswordHash(password, saltBytes);
    return timingSafeEqual(bytesToBase64(derived), bytesToBase64(expectedHash));
  } catch {
    return false;
  }
}

export async function getAdminRole(
  db: D1Database,
  tgId: number,
): Promise<AdminRole | null> {
  const row = await db
    .prepare('SELECT role FROM admins WHERE tg_id = ?')
    .bind(tgId)
    .first<{ role: AdminRole }>();

  return row?.role ?? null;
}

/** Admin in D1 and not banned in users. */
export async function isAdmin(db: D1Database, tgId: number): Promise<boolean> {
  const role = await getAdminRole(db, tgId);
  if (!role) {
    return false;
  }
  if (await isUserBanned(tgId, db)) {
    return false;
  }
  return true;
}

export async function isGrandAdmin(
  db: D1Database,
  tgId: number,
): Promise<boolean> {
  const role = await getAdminRole(db, tgId);
  if (role !== 'grand_admin') {
    return false;
  }
  if (await isUserBanned(tgId, db)) {
    return false;
  }
  return true;
}

export async function resolveAdminLabel(
  db: D1Database,
  tgId: number,
): Promise<string> {
  const row = await db
    .prepare('SELECT username FROM users WHERE tg_id = ?')
    .bind(tgId)
    .first<{ username: string | null }>();

  const username = row?.username?.trim();
  if (username) {
    return username.startsWith('@') ? username : `@${username}`;
  }
  return String(tgId);
}

export async function createAdminSession(
  env: Env,
  tgId: number,
  role: AdminRole,
): Promise<string> {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToHex(tokenBytes);
  const now = new Date().toISOString();

  const session: AdminSessionData = {
    tgId,
    role,
    createdAt: now,
    lastActivityAt: now,
  };

  await env.CACHE.put(`${SESSION_KEY_PREFIX}${token}`, JSON.stringify(session), {
    expirationTtl: sessionKvTtlSec(now),
  });
  await appendTgSessionToken(env, tgId, token);

  return token;
}

export async function touchAdminSession(
  env: Env,
  token: string,
  session: AdminSessionData,
): Promise<void> {
  const now = new Date().toISOString();
  const updated: AdminSessionData = {
    ...session,
    lastActivityAt: now,
  };

  await env.CACHE.put(`${SESSION_KEY_PREFIX}${token}`, JSON.stringify(updated), {
    expirationTtl: sessionKvTtlSec(session.createdAt),
  });
}

export async function deleteAdminSession(
  env: Env,
  token: string,
): Promise<void> {
  const raw = await env.CACHE.get(`${SESSION_KEY_PREFIX}${token}`);
  if (raw) {
    try {
      const session = JSON.parse(raw) as AdminSessionData;
      if (session.tgId) {
        await removeTgSessionToken(env, session.tgId, token);
      }
    } catch {
      // ignore parse errors
    }
  }
  await env.CACHE.delete(`${SESSION_KEY_PREFIX}${token}`);
}

export async function deleteAdminSessionsForTgId(
  env: Env,
  tgId: number,
): Promise<void> {
  const tokens = await readTgSessionTokens(env, tgId);
  for (let i = 0; i < tokens.length; i++) {
    await env.CACHE.delete(`${SESSION_KEY_PREFIX}${tokens[i]}`);
  }
  await env.CACHE.delete(tgSessionIndexKey(tgId));
}

async function loadAdminSession(
  env: Env,
  token: string,
): Promise<AdminSessionData | null> {
  if (!token) {
    return null;
  }

  const raw = await env.CACHE.get(`${SESSION_KEY_PREFIX}${token}`);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AdminSessionData;
  } catch {
    return null;
  }
}

/**
 * Protected admin API guard: initData + KV session + sliding 8h / hard 24h.
 * Returns Response on auth failure (401 session_expired, 403 forbidden / user_banned).
 */
export async function assertAdminSession(
  env: Env,
  body: Record<string, unknown>,
  adminToken: string,
): Promise<{ tgId: number; role: AdminRole } | Response> {
  const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
  if (!auth.ok) {
    return jsonResponse({ ok: false, error: auth.error }, 401);
  }

  const initData = String(body.initData ?? '');
  const userId = getUserIdFromInitData(initData);
  if (!userId) {
    return jsonResponse({ ok: false, error: 'Invalid initData' }, 401);
  }

  if (await isUserBanned(userId, env.DB)) {
    return jsonResponse({ ok: false, error: 'user_banned' }, 403);
  }

  const session = await loadAdminSession(env, adminToken);
  if (!session || isSessionExpired(session)) {
    if (adminToken) {
      await deleteAdminSession(env, adminToken);
    }
    return jsonResponse({ ok: false, error: 'session_expired' }, 401);
  }

  if (session.tgId !== userId) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }

  const role = await getAdminRole(env.DB, userId);
  if (!role || role !== session.role) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }

  if (!(await isAdmin(env.DB, userId))) {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }

  await touchAdminSession(env, adminToken, session);

  return { tgId: userId, role: session.role };
}

export async function assertGrandAdminSession(
  env: Env,
  body: Record<string, unknown>,
  adminToken: string,
): Promise<{ tgId: number; role: AdminRole } | Response> {
  const result = await assertAdminSession(env, body, adminToken);
  if (result instanceof Response) {
    return result;
  }
  if (result.role !== 'grand_admin') {
    return jsonResponse({ ok: false, error: 'forbidden' }, 403);
  }
  return result;
}

function loginFailKey(tgId: number): string {
  return `${LOGIN_FAIL_KEY_PREFIX}${tgId}`;
}

async function readLoginFailRecord(env: Env, tgId: number): Promise<LoginFailRecord> {
  const raw = await env.CACHE.get(loginFailKey(tgId));
  if (!raw) {
    return { count: 0, windowStart: Date.now() };
  }
  try {
    const parsed = JSON.parse(raw) as LoginFailRecord;
    return {
      count: Number(parsed.count) || 0,
      windowStart: Number(parsed.windowStart) || Date.now(),
      blockedUntil: parsed.blockedUntil ? Number(parsed.blockedUntil) : undefined,
    };
  } catch {
    return { count: 0, windowStart: Date.now() };
  }
}

/** §1.2 A8 — 5 fails / 15 min → block 30 min. */
export async function isLoginBlocked(env: Env, tgId: number): Promise<boolean> {
  const record = await readLoginFailRecord(env, tgId);
  const now = Date.now();

  if (record.blockedUntil && now < record.blockedUntil) {
    return true;
  }

  return false;
}

export async function assertLoginAllowed(
  env: Env,
  tgId: number,
): Promise<Response | null> {
  if (await isLoginBlocked(env, tgId)) {
    return jsonResponse({ ok: false, error: 'too_many_attempts' }, 429);
  }
  return null;
}

export async function recordLoginFailure(env: Env, tgId: number): Promise<void> {
  const now = Date.now();
  let record = await readLoginFailRecord(env, tgId);

  if (record.blockedUntil && now < record.blockedUntil) {
    return;
  }

  if (now - record.windowStart > LOGIN_FAIL_WINDOW_MS) {
    record = { count: 0, windowStart: now };
  }

  record.count += 1;

  if (record.count >= LOGIN_FAIL_MAX) {
    record.blockedUntil = now + LOGIN_BLOCK_TTL_SEC * 1000;
    record.count = 0;
    record.windowStart = now;
  }

  await env.CACHE.put(loginFailKey(tgId), JSON.stringify(record), {
    expirationTtl: LOGIN_BLOCK_TTL_SEC,
  });
}

export async function clearLoginFailures(env: Env, tgId: number): Promise<void> {
  await env.CACHE.delete(loginFailKey(tgId));
}

/** Login / setup guard — reject banned admins. */
export async function rejectIfAdminUserBanned(
  tgId: number,
  db: D1Database,
): Promise<Response | null> {
  if (await isUserBanned(tgId, db)) {
    return jsonResponse({ ok: false, error: 'user_banned' }, 403);
  }
  return null;
}

/*
 * Unit smoke (manual / prompt 3 handler tests):
 *
 * await hashPassword('TestPassword1') → base64 hash + salt
 * await verifyPassword('TestPassword1', hash, salt) === true
 * validatePasswordStrength('short') === false
 * await createAdminSession(env, tgId, 'admin') → 64-char hex
 * assertAdminSession with expired/missing token → 401 session_expired
 * assertAdminSession with banned user → 403 user_banned
 * assertGrandAdminSession with role admin → 403 forbidden
 * 5× recordLoginFailure → isLoginBlocked === true → too_many_attempts
 * deleteAdminSessionsForTgId removes all tokens for tgId
 */
