/**
 * Like toggle: only active listings accept new likes; unlike works without status check.
 * CODE_REVIEW_RU.md, промт 8.
 */
import { test, expect } from '@playwright/test';
import { buildInitData } from './helpers/telegram-init-data';

const apiBase =
  process.env.ADMIN_API_URL?.replace(/\/$/, '') ||
  'https://tg-networking-nhatrang.albertkoall.workers.dev';

const botToken = process.env.BOT_TOKEN?.trim();
const webappSecret = process.env.WEBAPP_SECRET?.trim() || 'getting_more_money';

const TEST_USER = 9_008_008_001;
const FAKE_LISTING = 'smoke-like-inactive-or-missing-listing';

async function toggleLike(
  request: import('@playwright/test').APIRequestContext,
  type: 'like' | 'unlike',
): Promise<Record<string, unknown>> {
  const response = await request.post(`${apiBase}/api`, {
    data: {
      action: 'toggle_like',
      secret: webappSecret,
      initData: buildInitData(botToken!, {
        id: TEST_USER,
        first_name: 'LikeTest',
        username: 'liketest',
      }),
      tg_id: TEST_USER,
      cardId: FAKE_LISTING,
      type,
    },
  });
  return (await response.json()) as Record<string, unknown>;
}

test.describe('toggle_like — listing must be active for like', () => {
  test.beforeEach(() => {
    test.skip(!botToken, 'Set BOT_TOKEN to build valid initData for like smoke.');
  });

  test('like on missing/inactive listing — listing_not_active', async ({ request }) => {
    const body = await toggleLike(request, 'like');
    expect(body.success).toBe(false);
    expect(body.error).toBe('listing_not_active');
  });

  test('unlike on missing listing — succeeds (cleanup old like)', async ({ request }) => {
    const body = await toggleLike(request, 'unlike');
    expect(body.success).toBe(true);
    expect(typeof body.newCount).toBe('number');
  });
});
