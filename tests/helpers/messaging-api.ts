import type { APIRequestContext } from '@playwright/test';
import { getStagingApiUrl } from './integration-env';
import { buildInitData, type TelegramTestUser } from './telegram-init-data';

export interface MessagingTestConfig {
  apiUrl: string;
  botToken: string;
  webappSecret: string;
  peerTgId: number;
  waListingId: string;
  telegramListingId: string;
  adminTgId: number;
  adminPassword: string;
}

export interface MessagingApiBody {
  ok?: boolean;
  error?: string;
  username?: string;
  has_unread?: boolean;
  unread_count?: number;
  conversation?: Record<string, unknown>;
  messages?: unknown[];
  expired?: boolean;
  expires_at?: string;
  message?: Record<string, unknown>;
  complaints?: unknown[];
  [key: string]: unknown;
}

export function loadMessagingTestConfig(): MessagingTestConfig | null {
  const botToken = process.env.BOT_TOKEN?.trim();
  if (!botToken) {
    return null;
  }

  const peerRaw = process.env.TEST_MESSAGING_PEER_TG_ID ?? process.env.TEST_RANDOM_TG_ID;
  const peerTgId = peerRaw ? Number(peerRaw) : 9_001_002_003;
  if (!Number.isFinite(peerTgId) || peerTgId <= 0) {
    return null;
  }

  const adminTgId = Number(process.env.TEST_ADMIN_TG_ID);
  const adminPassword = process.env.TEST_ADMIN_PASSWORD?.trim() ?? '';
  const adminReady = Number.isFinite(adminTgId) && adminTgId > 0 && adminPassword.length > 0;

  const apiUrl = getStagingApiUrl();
  if (!apiUrl) {
    return null;
  }

  return {
    apiUrl,
    botToken,
    webappSecret: process.env.WEBAPP_SECRET?.trim() || 'getting_more_money',
    peerTgId,
    waListingId: process.env.TEST_MESSAGING_WA_LISTING_ID?.trim() ?? '',
    telegramListingId: process.env.TEST_MESSAGING_TELEGRAM_LISTING_ID?.trim() ?? '',
    adminTgId: adminReady ? adminTgId : 0,
    adminPassword: adminReady ? adminPassword : '',
  };
}

export function initDataFor(config: MessagingTestConfig, user: TelegramTestUser): string {
  return buildInitData(config.botToken, user);
}

export async function postMessagingAction(
  request: APIRequestContext,
  config: MessagingTestConfig,
  action: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: MessagingApiBody }> {
  const payload = {
    action,
    secret: config.webappSecret,
    ...extra,
  };

  const response = await request.post(`${config.apiUrl}/api`, { data: payload });
  let body: MessagingApiBody = {};
  try {
    body = (await response.json()) as MessagingApiBody;
  } catch {
    body = {};
  }
  return { status: response.status(), body };
}

export async function postMessagingAs(
  request: APIRequestContext,
  config: MessagingTestConfig,
  action: string,
  tgId: number,
  extra: Record<string, unknown> = {},
  user?: Partial<TelegramTestUser>,
): Promise<{ status: number; body: MessagingApiBody }> {
  const initData = initDataFor(config, {
    id: tgId,
    first_name: user?.first_name ?? 'MessagingTest',
    username: user?.username ?? `user_${tgId}`,
  });

  return postMessagingAction(request, config, action, {
    initData,
    tg_id: tgId,
    ...extra,
  });
}
