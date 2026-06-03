import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { buildInitData } from '../test-utils/build-init-data';
import {
  authenticateMiniAppUser,
  getUserIdFromInitData,
  validateInitData,
} from './auth';
import {
  createMiniAppLaunchToken,
  verifyMiniAppLaunchToken,
} from './miniapp-launch-token';

const BOT_TOKEN = '123456789:AAFakeBotTokenForUnitTests';
const WEBAPP_SECRET = 'unit-test-webapp-secret';

function testEnv(): Env {
  return {
    BOT_TOKEN,
    WEBAPP_SECRET,
  } as Env;
}

describe('validateInitData', () => {
  it('rejects empty initData', async () => {
    expect(await validateInitData('', BOT_TOKEN)).toBe(false);
  });

  it('rejects initData with wrong hash', async () => {
    const initData = buildInitData(BOT_TOKEN, { id: 1001 });
    const tampered = initData.replace(/hash=[^&]+/, 'hash=deadbeef');
    expect(await validateInitData(tampered, BOT_TOKEN)).toBe(false);
  });

  it('accepts valid initData', async () => {
    const initData = buildInitData(BOT_TOKEN, { id: 1001, username: 'alice' });
    expect(await validateInitData(initData, BOT_TOKEN)).toBe(true);
  });

  it('rejects initData older than 86400 seconds', async () => {
    const expired = Math.floor(Date.now() / 1000) - 86401;
    const initData = buildInitData(BOT_TOKEN, { id: 1001 }, expired);
    expect(await validateInitData(initData, BOT_TOKEN)).toBe(false);
  });
});

describe('getUserIdFromInitData', () => {
  it('extracts user id from valid initData string', () => {
    const initData = buildInitData(BOT_TOKEN, { id: 42_424_242 });
    expect(getUserIdFromInitData(initData)).toBe(42_424_242);
  });
});

describe('authenticateMiniAppUser', () => {
  it('returns tgId when body.tg_id matches initData user', async () => {
    const initData = buildInitData(BOT_TOKEN, { id: 2001 });
    const result = await authenticateMiniAppUser(
      { secret: WEBAPP_SECRET, initData, tg_id: 2001 },
      testEnv(),
    );
    expect(result).toEqual({ ok: true, tgId: 2001 });
  });

  it('returns forbidden when body.tg_id differs from initData user', async () => {
    const initData = buildInitData(BOT_TOKEN, { id: 2001 });
    const result = await authenticateMiniAppUser(
      { secret: WEBAPP_SECRET, initData, tg_id: 2002 },
      testEnv(),
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('rejects invalid initData', async () => {
    const result = await authenticateMiniAppUser(
      { secret: WEBAPP_SECRET, initData: 'hash=bad', tg_id: 1 },
      testEnv(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Invalid initData');
    }
  });

  it('accepts valid launch_token when initData is missing', async () => {
    const launchToken = await createMiniAppLaunchToken(3003, testEnv());
    expect(launchToken).toBeTruthy();
    const result = await authenticateMiniAppUser(
      { secret: WEBAPP_SECRET, initData: '', launch_token: launchToken! },
      testEnv(),
    );
    expect(result).toEqual({ ok: true, tgId: 3003 });
  });

  it('rejects mismatched tg_id with launch_token', async () => {
    const launchToken = await createMiniAppLaunchToken(3003, testEnv());
    const result = await authenticateMiniAppUser(
      {
        secret: WEBAPP_SECRET,
        initData: '',
        launch_token: launchToken!,
        tg_id: 3004,
      },
      testEnv(),
    );
    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });
});

describe('miniapp launch token', () => {
  it('verifies token created for user', async () => {
    const token = await createMiniAppLaunchToken(4001, testEnv());
    expect(token).toBeTruthy();
    expect(await verifyMiniAppLaunchToken(token!, BOT_TOKEN)).toBe(4001);
  });

  it('rejects tampered token', async () => {
    const token = await createMiniAppLaunchToken(4001, testEnv());
    expect(await verifyMiniAppLaunchToken(`${token}x`, BOT_TOKEN)).toBeNull();
  });
});
