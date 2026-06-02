import crypto from 'node:crypto';

export interface TelegramTestUser {
  id: number;
  first_name?: string;
  username?: string;
}

/** Valid Mini App initData for unit tests (same HMAC as worker/src/utils/auth.ts). */
export function buildInitData(botToken: string, user: TelegramTestUser, authDateSec?: number): string {
  const authDate = authDateSec ?? Math.floor(Date.now() / 1000);
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
