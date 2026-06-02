/**
 * IDOR regression: valid initData for user A + body.tg_id of user B → forbidden.
 * CODE_REVIEW_RU.md, промт 2.
 */
import { test, expect } from '@playwright/test';
import { getStagingApiUrl } from './helpers/integration-env';
import { useStagingGuard } from './helpers/staging-guard';
import { buildInitData } from './helpers/telegram-init-data';

useStagingGuard();

const apiBase = getStagingApiUrl()!;

const botToken = process.env.BOT_TOKEN?.trim();
const webappSecret = process.env.WEBAPP_SECRET?.trim() || 'getting_more_money';

const USER_A = 9_001_001_001;
const USER_B = 9_001_001_002;

function initDataForUser(userId: number): string {
  return buildInitData(botToken!, { id: userId, first_name: 'IdorTest', username: `u${userId}` });
}

async function postIdorCase(
  request: import('@playwright/test').APIRequestContext,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request.post(`${apiBase}/api`, {
    data: {
      action,
      secret: webappSecret,
      initData: initDataForUser(USER_A),
      tg_id: USER_B,
      ...extra,
    },
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  return { status: response.status(), body };
}

test.describe('tg_id IDOR — initData user A vs body.tg_id user B', () => {
  test.beforeEach(() => {
    test.skip(!botToken, 'Set BOT_TOKEN to build valid initData for IDOR regression.');
  });

  const cases: Array<{ action: string; extra?: Record<string, unknown> }> = [
    { action: 'get_my_listings' },
    { action: 'archive_listing', extra: { listing_id: 'smoke-nonexistent-listing' } },
    { action: 'open_conversation', extra: { listing_id: 'smoke-nonexistent-listing' } },
    { action: 'send_message', extra: { conversation_id: 'smoke-nonexistent-conv', body: 'test' } },
    { action: 'get_messages', extra: { conversation_id: 'smoke-nonexistent-conv' } },
    {
      action: 'select_payment_method',
      extra: {
        payment_method: 'vnd',
        display_name: 'Test',
        category: 'Другое',
        description: 'Test',
        experience: '1',
        contact_type: 'Telegram',
        contacts: '@test',
        avatar_emoji: '🙂',
      },
    },
    {
      action: 'select_pin_payment_method',
      extra: {
        listing_id: 'smoke-nonexistent-listing',
        pin_duration: 'week',
        payment_method: 'vnd',
      },
    },
  ];

  for (const { action, extra } of cases) {
    test(`${action} — rejects mismatched tg_id`, async ({ request }) => {
      const { status, body } = await postIdorCase(request, action, extra);
      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('forbidden');
    });
  }
});
