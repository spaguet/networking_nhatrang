/**
 * Telegram webhook secret-token smoke (CODE_REVIEW_RU.md, промт 1).
 *
 * Negative case (no TELEGRAM_WEBHOOK_SECRET): fake update without header → 403/503.
 * Positive case: set TELEGRAM_WEBHOOK_SECRET + ADMIN_API_URL — same update with header → 200.
 */
import { test, expect } from '@playwright/test';
import { getStagingApiUrl } from './helpers/integration-env';
import { useStagingGuard } from './helpers/staging-guard';

useStagingGuard();

const apiBase = getStagingApiUrl()!;

const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();

/** Fake moderation callback — must be rejected without secret header. */
const fakeModerationUpdate = {
  update_id: 9_999_999_001,
  callback_query: {
    id: 'smoke_fake_callback',
    from: { id: 1, is_bot: false, first_name: 'Smoke' },
    message: {
      message_id: 1,
      chat: { id: 1, type: 'private' },
      date: 1_700_000_000,
    },
    chat_instance: 'smoke',
    data: 'approve_listing:smoke-nonexistent-listing',
  },
};

test.describe('Telegram webhook secret-token', () => {
  test('POST /webhook — fake callback without secret header is rejected', async ({
    request,
  }) => {
    const response = await request.post(`${apiBase}/webhook`, {
      data: fakeModerationUpdate,
    });

    expect([403, 503]).toContain(response.status());
    expect(await response.text()).not.toBe('');
  });

  test('POST / — fake callback without secret header is rejected', async ({
    request,
  }) => {
    const response = await request.post(`${apiBase}/`, {
      data: fakeModerationUpdate,
    });

    expect([403, 503]).toContain(response.status());
  });

  test('POST /webhook — ping without secret header still returns OK', async ({
    request,
  }) => {
    const response = await request.post(`${apiBase}/webhook`, {
      data: { ping: true },
    });

    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('OK');
  });

  test('POST /webhook — fake callback with valid secret header is accepted', async ({
    request,
  }) => {
    test.skip(!webhookSecret, 'Set TELEGRAM_WEBHOOK_SECRET for positive webhook smoke.');

    const response = await request.post(`${apiBase}/webhook`, {
      headers: {
        'X-Telegram-Bot-Api-Secret-Token': webhookSecret!,
      },
      data: {
        ...fakeModerationUpdate,
        update_id: 9_999_999_002,
      },
    });

    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('OK');
  });
});
