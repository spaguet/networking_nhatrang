import type { Env } from '../env';
import { corsHeaders } from './response';

export const TELEGRAM_WEBHOOK_SECRET_HEADER = 'X-Telegram-Bot-Api-Secret-Token';

/**
 * Validates Telegram webhook secret header against TELEGRAM_WEBHOOK_SECRET.
 * Returns an error Response when invalid; null when the request may proceed.
 */
export function rejectUnlessValidTelegramWebhookSecret(
  request: Request,
  env: Env,
): Response | null {
  const expected = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!expected) {
    return new Response('Webhook secret not configured', {
      status: 503,
      headers: corsHeaders(),
    });
  }

  const provided = request.headers.get(TELEGRAM_WEBHOOK_SECRET_HEADER)?.trim() ?? '';
  if (!provided || provided !== expected) {
    return new Response('Forbidden', { status: 403, headers: corsHeaders() });
  }

  return null;
}
