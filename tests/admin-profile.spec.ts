/**
 * Admin profile API smoke — admin_profile_TZ.md v1.3 §8.6, промпт 8.
 *
 * Required env (skip all tests if missing):
 *   BOT_TOKEN              — same as Worker secret
 *   TEST_ADMIN_TG_ID       — role=admin in D1 admins, password set
 *   TEST_ADMIN_PASSWORD    — password for TEST_ADMIN_TG_ID
 *
 * Optional:
 *   ADMIN_API_URL          — default production Worker URL
 *   WEBAPP_SECRET          — default getting_more_money
 *   TEST_RANDOM_TG_ID      — non-admin user (default 9001002003)
 *   TEST_LOGIN_RATE_TG_ID  — dedicated admin for rate-limit test (optional; blocks KV ~30 min)
 *   TEST_LOGIN_RATE_PASSWORD
 */
import { test, expect } from '@playwright/test';
import {
  adminLogin,
  initDataFor,
  loadAdminTestConfig,
  postAdminAction,
} from './helpers/admin-api';

const config = loadAdminTestConfig();
const skipReason =
  'Set BOT_TOKEN, TEST_ADMIN_TG_ID, TEST_ADMIN_PASSWORD to run admin API smoke tests.';

test.describe('Admin profile API smoke', () => {
  test.skip(!config, skipReason);
  test.describe.configure({ mode: 'serial' });

  test('admin_check_access — random user is not admin', async ({ request }) => {
    const cfg = config!;
    const initData = initDataFor(cfg, {
      id: cfg.randomUserTgId,
      first_name: 'Random',
      username: 'random_smoke_user',
    });

    const { status, body } = await postAdminAction(request, cfg, 'admin_check_access', {
      initData,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.isAdmin).toBe(false);
    expect(body.role).toBeUndefined();
  });

  test('admin_update_settings — forbidden for role admin', async ({ request }) => {
    const cfg = config!;
    const login = await adminLogin(request, cfg, cfg.adminTgId, cfg.adminPassword);
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(login.body.adminToken).toBeTruthy();
    expect(login.body.role).toBe('admin');

    const initData = initDataFor(cfg, { id: cfg.adminTgId, first_name: 'Admin' });
    const { status, body } = await postAdminAction(request, cfg, 'admin_update_settings', {
      initData,
      adminToken: login.body.adminToken,
      settings: { payment_amount_vnd: '999 999 VND' },
    });

    expect(status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('forbidden');
  });

  test('admin_list_banned — pagination response shape', async ({ request }) => {
    const cfg = config!;
    const login = await adminLogin(request, cfg, cfg.adminTgId, cfg.adminPassword);
    expect(login.status).toBe(200);
    expect(login.body.adminToken).toBeTruthy();

    const initData = initDataFor(cfg, { id: cfg.adminTgId, first_name: 'Admin' });
    const { status, body } = await postAdminAction(request, cfg, 'admin_list_banned', {
      initData,
      adminToken: login.body.adminToken,
      page: 1,
    });

    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.users)).toBe(true);
    expect(typeof body.total).toBe('number');
    expect(body.page).toBe(1);
    expect(body.total).toBeGreaterThanOrEqual(0);
    expect(body.users!.length).toBeLessThanOrEqual(20);

    for (const row of body.users as Record<string, unknown>[]) {
      expect(typeof row.tgId).toBe('number');
      expect(Object.prototype.hasOwnProperty.call(row, 'username')).toBe(true);
      expect(typeof row.firstName).toBe('string');
      expect(Object.prototype.hasOwnProperty.call(row, 'bannedAt')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(row, 'bannedBy')).toBe(true);
      expect(typeof row.bannedByLabel).toBe('string');
    }
  });

  test.describe('rate limit (optional)', () => {
    test.skip(!config?.rateLimitTgId, 'Set TEST_LOGIN_RATE_TG_ID + TEST_LOGIN_RATE_PASSWORD');

    test('admin_login — wrong password ×5 then too_many_attempts', async ({ request }) => {
      const cfg = config!;
      const initData = initDataFor(cfg, {
        id: cfg.rateLimitTgId,
        first_name: 'RateLimit',
      });

      for (let attempt = 1; attempt <= 4; attempt++) {
        const { status, body } = await postAdminAction(request, cfg, 'admin_login', {
          initData,
          password: `wrong-password-${attempt}`,
        });
        expect(status).toBe(401);
        expect(body.ok).toBe(false);
        expect(body.error).toBe('invalid_password');
      }

      const blocked = await postAdminAction(request, cfg, 'admin_login', {
        initData,
        password: 'wrong-password-5',
      });
      expect(blocked.status).toBe(429);
      expect(blocked.body.ok).toBe(false);
      expect(blocked.body.error).toBe('too_many_attempts');

      const stillBlocked = await postAdminAction(request, cfg, 'admin_login', {
        initData,
        password: cfg.rateLimitPassword,
      });
      expect(stillBlocked.status).toBe(429);
      expect(stillBlocked.body.error).toBe('too_many_attempts');
    });
  });
});
