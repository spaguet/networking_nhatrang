import type { Env } from '../env';

const MEDIA_URL_TTL_SEC = 15 * 60;
const ADMIN_TOKEN_TTL_SEC = 24 * 60 * 60;
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_TTL_SEC = 3600;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmacSha256(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64UrlEncode(new Uint8Array(signature));
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

export async function createSignedMediaUrl(
  r2Key: string,
  workerOrigin: string,
  env: Env,
): Promise<string> {
  const secret = env.MEDIA_SIGNING_SECRET;
  if (!secret) {
    throw new Error('MEDIA_SIGNING_SECRET is not configured');
  }

  const exp = Math.floor(Date.now() / 1000) + MEDIA_URL_TTL_SEC;
  const payload = `${r2Key}|${exp}`;
  const sig = await hmacSha256(payload, secret);
  const origin = workerOrigin.replace(/\/+$/, '');
  const params = new URLSearchParams({
    key: r2Key,
    exp: String(exp),
    sig,
  });
  return `${origin}/portfolio-media?${params.toString()}`;
}

export async function verifySignedMediaRequest(
  r2Key: string,
  expStr: string,
  sig: string,
  env: Env,
): Promise<boolean> {
  const secret = env.MEDIA_SIGNING_SECRET;
  if (!r2Key || !expStr || !sig || !secret) {
    return false;
  }

  if (!r2Key.startsWith('portfolio/') || r2Key.includes('..')) {
    return false;
  }

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const payload = `${r2Key}|${exp}`;
  const expected = await hmacSha256(payload, secret);
  return timingSafeEqual(expected, sig);
}

export async function createAdminPortfolioToken(
  listingId: string,
  env: Env,
): Promise<{ token: string; exp: number }> {
  const secret = env.ADMIN_PORTFOLIO_SECRET;
  if (!secret) {
    throw new Error('ADMIN_PORTFOLIO_SECRET is not configured');
  }

  const exp = Math.floor(Date.now() / 1000) + ADMIN_TOKEN_TTL_SEC;
  const payload = `admin_portfolio|${listingId}|${exp}`;
  const token = await hmacSha256(payload, secret);
  return { token, exp };
}

export async function verifyAdminPortfolioToken(
  listingId: string,
  token: string,
  expStr: string,
  env: Env,
): Promise<boolean> {
  const secret = env.ADMIN_PORTFOLIO_SECRET;
  if (!listingId || !token || !expStr || !secret) {
    return false;
  }

  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const payload = `admin_portfolio|${listingId}|${exp}`;
  const expected = await hmacSha256(payload, secret);
  return timingSafeEqual(expected, token);
}

export function getMiniAppPortfolioUrl(
  miniAppUrl: string,
  listingId: string,
  adminToken: string,
  exp: number,
): string {
  const base = miniAppUrl.trim().replace(/\/+$/, '');
  const params = new URLSearchParams({
    listing_id: listingId,
    view: 'admin',
    token: adminToken,
    exp: String(exp),
  });
  return `${base}/portfolio.html?${params.toString()}`;
}

export async function checkPortfolioRateLimit(
  tgId: number,
  env: Env,
): Promise<{ allowed: boolean; error?: string }> {
  const key = `portfolio_rl:${tgId}`;
  const raw = await env.CACHE.get(key);
  const count = raw ? Number(raw) : 0;

  if (count >= RATE_LIMIT_MAX) {
    return { allowed: false, error: 'portfolio_upload_failed' };
  }

  return { allowed: true };
}

export async function incrementPortfolioRateLimit(
  tgId: number,
  env: Env,
): Promise<void> {
  const key = `portfolio_rl:${tgId}`;
  const raw = await env.CACHE.get(key);
  const count = raw ? Number(raw) : 0;
  await env.CACHE.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_TTL_SEC });
}
