import type { Env } from '../env';

export type InitDataErrorCode = 'Invalid initData' | 'Invalid_initData';

export type MiniAppAuthResult =
  | { ok: true }
  | { ok: false; error: string };

export type TelegramInitDataResult =
  | { valid: true; userId: string }
  | { valid: false; error: string };

function parseInitDataParams(initData: string): Record<string, string> {
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
  return params;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function computeInitDataHash(
  dataCheckString: string,
  botToken: string,
): Promise<string> {
  const encoder = new TextEncoder();

  const webAppDataKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const secretKeyBytes = await crypto.subtle.sign(
    'HMAC',
    webAppDataKey,
    encoder.encode(botToken),
  );

  const secretKey = await crypto.subtle.importKey(
    'raw',
    secretKeyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    secretKey,
    encoder.encode(dataCheckString),
  );

  return bytesToHex(signature);
}

function buildDataCheckString(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('\n');
}

/** POST /api — auth_date max 86400 sec (matches Code.gs validateInitData). */
export async function validateInitData(
  initData: string,
  botToken: string,
): Promise<boolean> {
  if (!initData) {
    return false;
  }

  const params = parseInitDataParams(initData);
  const hash = params.hash;
  if (!hash) {
    return false;
  }

  const checkParams = { ...params };
  delete checkParams.hash;

  const dataCheckString = buildDataCheckString(checkParams);
  const calculatedHash = await computeInitDataHash(dataCheckString, botToken);

  if (calculatedHash !== hash) {
    return false;
  }

  const authDate = Number(checkParams.auth_date);
  if (authDate) {
    const maxAgeSec = 86400;
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec - authDate > maxAgeSec) {
      return false;
    }
  }

  return true;
}

/** GET likes — auth_date max 3600 sec (matches Code.gs validateTelegramInitData). */
export async function validateTelegramInitData(
  initDataString: string,
  botToken: string,
): Promise<TelegramInitDataResult> {
  if (!botToken) {
    return { valid: false, error: 'missing_bot_token' };
  }
  if (!initDataString) {
    return { valid: false, error: 'missing_init_data' };
  }

  const params = parseInitDataParams(initDataString);
  const hash = params.hash;
  if (!hash) {
    return { valid: false, error: 'missing_hash' };
  }

  const checkParams = { ...params };
  delete checkParams.hash;

  const dataCheckString = buildDataCheckString(checkParams);
  const expectedHash = await computeInitDataHash(dataCheckString, botToken);

  if (expectedHash !== hash) {
    return { valid: false, error: 'invalid_hash' };
  }

  const authDate = Number(checkParams.auth_date);
  if (!authDate) {
    return { valid: false, error: 'missing_auth_date' };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > 3600) {
    return { valid: false, error: 'auth_date_expired' };
  }

  let userId = '';
  try {
    if (checkParams.user) {
      const user = JSON.parse(checkParams.user) as { id?: number | string };
      if (user && user.id != null) {
        userId = String(user.id);
      }
    }
  } catch {
    return { valid: false, error: 'invalid_user' };
  }

  if (!userId) {
    return { valid: false, error: 'missing_user_id' };
  }

  return { valid: true, userId };
}

/** Extract Telegram username from Mini App initData (unsigned parse). */
export function getUsernameFromInitData(initData: string): string | null {
  if (!initData) {
    return null;
  }

  const params = parseInitDataParams(initData);
  try {
    if (params.user) {
      const user = JSON.parse(params.user) as { username?: string };
      const username = user?.username?.trim();
      return username || null;
    }
  } catch {
    return null;
  }

  return null;
}

/** Extract Telegram user id from Mini App initData (unsigned parse). */
export function getUserIdFromInitData(initData: string): number | null {
  if (!initData) {
    return null;
  }

  const params = parseInitDataParams(initData);
  try {
    if (params.user) {
      const user = JSON.parse(params.user) as { id?: number | string };
      if (user?.id != null) {
        const id = Number(user.id);
        return Number.isFinite(id) ? id : null;
      }
    }
  } catch {
    return null;
  }

  return null;
}

/** secret + initData check (logic from Code.gs handleFormSubmission). */
export async function validateMiniAppRequest(
  body: Record<string, unknown>,
  env: Env,
  initDataError: InitDataErrorCode = 'Invalid initData',
): Promise<MiniAppAuthResult> {
  if (env.WEBAPP_SECRET && body.secret !== env.WEBAPP_SECRET) {
    return { ok: false, error: 'invalid_secret' };
  }

  const initData = String(body.initData ?? '');
  const valid = await validateInitData(initData, env.BOT_TOKEN);
  if (!valid) {
    return { ok: false, error: initDataError };
  }

  return { ok: true };
}
