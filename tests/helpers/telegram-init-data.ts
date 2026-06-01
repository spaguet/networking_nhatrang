import crypto from 'node:crypto';

export interface TelegramTestUser {
  id: number;
  first_name?: string;
  username?: string;
}

/**
 * Build Telegram Mini App initData with valid HMAC (same algorithm as worker/src/utils/auth.ts).
 */
export function buildInitData(botToken: string, user: TelegramTestUser): string {
  const authDate = Math.floor(Date.now() / 1000);
  const params: Record<string, string> = {
    auth_date: String(authDate),
    user: JSON.stringify({
      id: user.id,
      first_name: user.first_name ?? 'Test',
      ...(user.username ? { username: user.username } : {}),
    }),
  };

  const dataCheckString = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const query: Record<string, string> = { ...params, hash };
  return Object.entries(query)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}
