import type { APIRequestContext } from '@playwright/test';
import { buildInitData, type TelegramTestUser } from './telegram-init-data';

export interface AdminTestConfig {
  apiUrl: string;
  botToken: string;
  webappSecret: string;
  randomUserTgId: number;
  adminTgId: number;
  adminPassword: string;
  rateLimitTgId: number;
  rateLimitPassword: string;
}

export interface AdminApiBody {
  ok?: boolean;
  error?: string;
  isAdmin?: boolean;
  role?: string;
  adminToken?: string;
  users?: unknown[];
  total?: number;
  page?: number;
  [key: string]: unknown;
}

export function loadAdminTestConfig(): AdminTestConfig | null {
  const botToken = process.env.BOT_TOKEN?.trim();
  if (!botToken) {
    return null;
  }

  const adminTgId = Number(process.env.TEST_ADMIN_TG_ID);
  const adminPassword = process.env.TEST_ADMIN_PASSWORD?.trim() ?? '';
  const rateLimitTgIdRaw = process.env.TEST_LOGIN_RATE_TG_ID?.trim();
  const rateLimitTgId = rateLimitTgIdRaw ? Number(rateLimitTgIdRaw) : NaN;
  const rateLimitPassword = process.env.TEST_LOGIN_RATE_PASSWORD?.trim() ?? '';

  if (!Number.isFinite(adminTgId) || adminTgId <= 0 || !adminPassword) {
    return null;
  }

  const randomRaw = process.env.TEST_RANDOM_TG_ID;
  const randomUserTgId = randomRaw ? Number(randomRaw) : 9_001_002_003;

  const rateLimitReady =
    Number.isFinite(rateLimitTgId) &&
    rateLimitTgId > 0 &&
    rateLimitPassword.length > 0;

  return {
    apiUrl:
      process.env.ADMIN_API_URL?.replace(/\/$/, '') ||
      'https://tg-networking-nhatrang.albertkoall.workers.dev',
    botToken,
    webappSecret: process.env.WEBAPP_SECRET?.trim() || 'getting_more_money',
    randomUserTgId,
    adminTgId,
    adminPassword,
    rateLimitTgId: rateLimitReady ? rateLimitTgId : 0,
    rateLimitPassword: rateLimitReady ? rateLimitPassword : '',
  };
}

export function initDataFor(config: AdminTestConfig, user: TelegramTestUser): string {
  return buildInitData(config.botToken, user);
}

export async function postAdminAction(
  request: APIRequestContext,
  config: AdminTestConfig,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: AdminApiBody }> {
  const payload = {
    action,
    secret: config.webappSecret,
    ...extra,
  };

  const response = await request.post(`${config.apiUrl}/api`, { data: payload });
  let body: AdminApiBody = {};
  try {
    body = (await response.json()) as AdminApiBody;
  } catch {
    body = {};
  }
  return { status: response.status(), body };
}

export async function adminLogin(
  request: APIRequestContext,
  config: AdminTestConfig,
  tgId: number,
  password: string,
  user?: Partial<TelegramTestUser>,
): Promise<{ status: number; body: AdminApiBody }> {
  const initData = initDataFor(config, {
    id: tgId,
    first_name: user?.first_name ?? 'AdminTest',
    username: user?.username,
  });

  return postAdminAction(request, config, 'admin_login', {
    initData,
    password,
  });
}
