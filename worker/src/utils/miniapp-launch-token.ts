import type { Env } from '../env';

/** TTL совпадает с validateInitData (86400 с). */
const LAUNCH_TOKEN_TTL_SEC = 86400;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
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

async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Подписанный токен для Mini App с reply keyboard (initData Telegram не передаёт). */
export async function createMiniAppLaunchToken(
  tgId: number,
  env: Env,
): Promise<string | null> {
  const botToken = env.BOT_TOKEN;
  if (!botToken || !Number.isFinite(tgId) || tgId <= 0) {
    return null;
  }

  const exp = Math.floor(Date.now() / 1000) + LAUNCH_TOKEN_TTL_SEC;
  const nonce = base64UrlEncode(crypto.getRandomValues(new Uint8Array(8)));
  const payload = `${tgId}.${exp}.${nonce}`;
  const sig = await hmacSha256Hex(payload, botToken);
  return `${payload}.${sig}`;
}

export async function verifyMiniAppLaunchToken(
  token: string,
  botToken: string,
): Promise<number | null> {
  const trimmed = token.trim();
  if (!trimmed || !botToken) {
    return null;
  }

  const parts = trimmed.split('.');
  if (parts.length !== 4) {
    return null;
  }

  const [tgIdStr, expStr, nonce, sig] = parts;
  const payload = `${tgIdStr}.${expStr}.${nonce}`;
  const expected = await hmacSha256Hex(payload, botToken);
  if (!timingSafeEqual(sig, expected)) {
    return null;
  }

  const tgId = Number(tgIdStr);
  const exp = Number(expStr);
  if (!Number.isFinite(tgId) || tgId <= 0 || !Number.isFinite(exp)) {
    return null;
  }

  if (Math.floor(Date.now() / 1000) > exp) {
    return null;
  }

  return tgId;
}

export function appendLaunchTokenToUrl(url: string, launchToken: string): string {
  if (!launchToken.trim()) {
    return url;
  }
  try {
    const parsed = new URL(url);
    parsed.searchParams.set('lt', launchToken);
    return parsed.toString();
  } catch {
    return url;
  }
}
