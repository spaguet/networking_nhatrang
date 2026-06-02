/**
 * Messaging API smoke — user_messaging_TZ.md v1.5 §11, промпт 8.
 *
 * Required for integration block (skip if missing):
 *   ADMIN_API_URL, BOT_TOKEN (see tests/CI_ENV.md)
 *
 * Optional (integration / TTL / complaints):
 *   TEST_MESSAGING_PEER_TG_ID  — peer opening in-app chat (default TEST_RANDOM_TG_ID or 9001002003)
 *   TEST_MESSAGING_WA_LISTING_ID — active Whatsapp/Email listing_id
 *   TEST_MESSAGING_TELEGRAM_LISTING_ID — active Telegram listing_id (for messaging_not_available)
 *   TEST_ADMIN_TG_ID + TEST_ADMIN_PASSWORD — admin complaint list smoke
 */
import { test, expect } from '@playwright/test';
import {
  adminLogin,
  initDataFor as adminInitDataFor,
  loadAdminTestConfig,
  postAdminAction,
} from './helpers/admin-api';
import {
  loadMessagingTestConfig,
  postMessagingAs,
  postMessagingAction,
} from './helpers/messaging-api';
import { getStagingApiUrl } from './helpers/integration-env';
import { useStagingGuard } from './helpers/staging-guard';

useStagingGuard();

const config = loadMessagingTestConfig();
const adminConfig = loadAdminTestConfig();
const skipReason =
  'Set ADMIN_API_URL and BOT_TOKEN to run messaging API smoke tests (see tests/CI_ENV.md).';

test.describe('Messaging API smoke', () => {
  test.describe('auth regression (no BOT_TOKEN)', () => {
    test('verify_telegram_contact — missing initData', async ({ request }) => {
      const secret = process.env.WEBAPP_SECRET?.trim() || 'getting_more_money';
      const apiUrl = getStagingApiUrl()!;

      const response = await request.post(`${apiUrl}/api`, {
        data: {
          action: 'verify_telegram_contact',
          secret,
          contacts: '@ivan_spec',
          tg_id: 1,
        },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Invalid initData');
    });

    test('get_messaging_unread — missing initData', async ({ request }) => {
      const secret = process.env.WEBAPP_SECRET?.trim() || 'getting_more_money';
      const apiUrl = getStagingApiUrl()!;

      const response = await request.post(`${apiUrl}/api`, {
        data: { action: 'get_messaging_unread', secret, tg_id: 1 },
      });

      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.ok).toBe(false);
      expect(body.error).toBe('Invalid initData');
    });
  });

  test.describe('with BOT_TOKEN', () => {
    test.skip(!config, skipReason);
    test.describe.configure({ mode: 'serial' });

    test('verify_telegram_contact — invalid username format (T13 partial)', async ({
      request,
    }) => {
      const cfg = config!;
      const { status, body } = await postMessagingAs(
        request,
        cfg,
        'verify_telegram_contact',
        cfg.peerTgId,
        { contacts: 'ab' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('invalid_telegram_username');
    });

    test('verify_telegram_contact — empty contacts', async ({ request }) => {
      const cfg = config!;
      const { status, body } = await postMessagingAs(
        request,
        cfg,
        'verify_telegram_contact',
        cfg.peerTgId,
        { contacts: '   ' },
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(false);
      expect(body.error).toBe('invalid_telegram_username');
    });

    test('get_messaging_unread — response shape (T6 partial)', async ({ request }) => {
      const cfg = config!;
      const { status, body } = await postMessagingAs(
        request,
        cfg,
        'get_messaging_unread',
        cfg.peerTgId,
      );

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.has_unread).toBe('boolean');
      expect(typeof body.unread_count).toBe('number');
    });

    test('send_message — links forbidden without conversation (T10 partial)', async ({
      request,
    }) => {
      const cfg = config!;
      const { status, body } = await postMessagingAs(request, cfg, 'send_message', cfg.peerTgId, {
        conversation_id: '0000000000000000000000000000000000000000000000000000000000000000',
        body: 'see https://evil.example',
      });

      expect(status).toBe(200);
      expect(
        body.error === 'links_forbidden' || body.error === 'not_found',
      ).toBe(true);
    });

    test.describe('WA/Email in-app (optional listing)', () => {
      test.skip(!config?.waListingId, 'Set TEST_MESSAGING_WA_LISTING_ID');

      test('open_conversation — creates thread (T3)', async ({ request }) => {
        const cfg = config!;
        const { status, body } = await postMessagingAs(
          request,
          cfg,
          'open_conversation',
          cfg.peerTgId,
          { listing_id: cfg.waListingId },
        );

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.conversation).toBeTruthy();
        expect(typeof body.conversation!.conversation_id).toBe('string');
        expect(Array.isArray(body.messages)).toBe(true);
      });

      test('send_message — first message sets expires_at ~7d (T4)', async ({ request }) => {
        const cfg = config!;
        const opened = await postMessagingAs(
          request,
          cfg,
          'open_conversation',
          cfg.peerTgId,
          { listing_id: cfg.waListingId },
        );
        expect(opened.body.ok).toBe(true);
        const convId = String(opened.body.conversation!.conversation_id);

        const { status, body } = await postMessagingAs(request, cfg, 'send_message', cfg.peerTgId, {
          conversation_id: convId,
          body: `smoke ${Date.now()}`,
        });

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.expires_at).toBeTruthy();

        const expiresMs = new Date(String(body.expires_at)).getTime();
        const delta = expiresMs - Date.now();
        expect(delta).toBeGreaterThan(6.5 * 24 * 60 * 60 * 1000);
        expect(delta).toBeLessThan(7.5 * 24 * 60 * 60 * 1000);
      });

      test('send_message — links forbidden in active thread (T10)', async ({ request }) => {
        const cfg = config!;
        const opened = await postMessagingAs(
          request,
          cfg,
          'open_conversation',
          cfg.peerTgId,
          { listing_id: cfg.waListingId },
        );
        const convId = String(opened.body.conversation!.conversation_id);

        const { status, body } = await postMessagingAs(request, cfg, 'send_message', cfg.peerTgId, {
          conversation_id: convId,
          body: 'link https://test.example',
        });

        expect(status).toBe(200);
        expect(body.ok).toBe(false);
        expect(body.error).toBe('links_forbidden');
      });
    });

    test.describe('Telegram listing guard (optional)', () => {
      test.skip(!config?.telegramListingId, 'Set TEST_MESSAGING_TELEGRAM_LISTING_ID');

      test('open_conversation — messaging_not_available (T1)', async ({ request }) => {
        const cfg = config!;
        const { status, body } = await postMessagingAs(
          request,
          cfg,
          'open_conversation',
          cfg.peerTgId,
          { listing_id: cfg.telegramListingId },
        );

        expect(status).toBe(200);
        expect(body.ok).toBe(false);
        expect(body.error).toBe('messaging_not_available');
      });
    });
  });
});

test.describe('Admin messaging complaints API (optional)', () => {
  test.skip(!adminConfig, 'Set TEST_ADMIN_TG_ID + TEST_ADMIN_PASSWORD');
  test.describe.configure({ mode: 'serial' });

  test('admin_list_message_complaints — table shape (T8 partial)', async ({ request }) => {
    const cfg = adminConfig!;
    const login = await adminLogin(request, cfg, cfg.adminTgId, cfg.adminPassword);
    expect(login.body.ok).toBe(true);
    expect(login.body.adminToken).toBeTruthy();

    const initData = adminInitDataFor(cfg, { id: cfg.adminTgId, first_name: 'Admin' });
    const { status, body } = await postAdminAction(
      request,
      cfg,
      'admin_list_message_complaints',
      { initData, adminToken: login.body.adminToken },
    );

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.complaints)).toBe(true);
  });
});
