import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { buildInitData } from '../test-utils/build-init-data';
import {
  authenticateMiniAppUser,
  getUserIdFromInitData,
  validateInitData,
} from './auth';

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
});
