import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import {
  rejectUnlessValidTelegramWebhookSecret,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
} from './telegram-webhook-auth';

function envWithSecret(secret: string): Env {
  return { TELEGRAM_WEBHOOK_SECRET: secret } as Env;
}

function webhookRequest(secretHeader?: string): Request {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (secretHeader !== undefined) {
    headers.set(TELEGRAM_WEBHOOK_SECRET_HEADER, secretHeader);
  }
  return new Request('https://example.com/webhook', { method: 'POST', headers });
}

describe('rejectUnlessValidTelegramWebhookSecret', () => {
  it('returns 503 when TELEGRAM_WEBHOOK_SECRET is not configured', () => {
    const response = rejectUnlessValidTelegramWebhookSecret(
      webhookRequest('any'),
      {} as Env,
    );
    expect(response?.status).toBe(503);
  });

  it('returns 403 when header is missing or wrong', () => {
    const env = envWithSecret('expected-secret');

    expect(rejectUnlessValidTelegramWebhookSecret(webhookRequest(), env)?.status).toBe(403);
    expect(
      rejectUnlessValidTelegramWebhookSecret(webhookRequest('wrong'), env)?.status,
    ).toBe(403);
  });

  it('returns null when header matches configured secret', () => {
    const env = envWithSecret('expected-secret');
    expect(
      rejectUnlessValidTelegramWebhookSecret(webhookRequest('expected-secret'), env),
    ).toBeNull();
  });
});
