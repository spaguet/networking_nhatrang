import { getConfig } from './config';
import type { Env } from './env';
import { routeApiAction } from './handlers/api';
import {
  handleGetFavoriteCounts,
  handleToggleFavorite,
} from './handlers/favorites';
import { handleGetLikes, handleToggleLike } from './handlers/likes';
import { dailyMaintenance } from './handlers/maintenance';
import {
  handlePortfolioMediaGet,
  routeMultipartAction,
} from './handlers/portfolio';
import {
  handleTelegramUpdate,
  isDuplicateTelegramUpdate,
} from './handlers/telegram';
import { ensureMiniAppMenuButtonSynced } from './services/menu-button';
import {
  getMiniAppCatalogUrl,
  getMiniAppRulesUrl,
  isValidMiniAppUrl,
} from './utils/miniapp-url';
import { rejectUnlessValidTelegramWebhookSecret } from './utils/telegram-webhook-auth';
import { corsHeaders, handleOptions, jsonResponse } from './utils/response';

function textOk(): Response {
  return new Response('OK', { status: 200, headers: corsHeaders() });
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await request.text();
    if (!text) {
      return null;
    }
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Stable entry point for the Mini App: Telegram's persistent menu button is
 * configured (once, see services/menu-button.ts) to point here forever.
 * We always 302 to the current GitHub Pages catalog/rules URL with a fresh
 * cache-buster, so deploys never require updating a link inside Telegram.
 */
function miniAppRedirect(request: Request, env: Env, kind: 'catalog' | 'rules'): Response {
  const config = getConfig(env);
  if (!isValidMiniAppUrl(config.miniAppUrl)) {
    return new Response('MINI_APP_URL is not configured', {
      status: 503,
      headers: corsHeaders(),
    });
  }

  let target =
    kind === 'catalog'
      ? getMiniAppCatalogUrl(config.miniAppUrl)
      : getMiniAppRulesUrl(config.miniAppUrl);

  const launchToken = new URL(request.url).searchParams.get('lt');
  if (launchToken) {
    try {
      const targetUrl = new URL(target);
      targetUrl.searchParams.set('lt', launchToken);
      target = targetUrl.toString();
    } catch {
      // keep target without the launch token
    }
  }

  return new Response(null, {
    status: 302,
    headers: {
      ...corsHeaders(),
      Location: target,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
  });
}

function isMultipartRequest(request: Request): boolean {
  const contentType = request.headers.get('Content-Type') ?? '';
  return contentType.includes('multipart/form-data');
}

function isTelegramUpdate(body: Record<string, unknown>): boolean {
  return body.update_id !== undefined && body.update_id !== null;
}

type NonTelegramWebhookBehavior = 'not_found' | 'ok';

async function processTelegramWebhook(
  request: Request,
  body: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
  nonTelegramBehavior: NonTelegramWebhookBehavior,
): Promise<Response> {
  if (body.ping) {
    return textOk();
  }

  if (!isTelegramUpdate(body)) {
    if (nonTelegramBehavior === 'not_found') {
      return new Response('Not Found', { status: 404, headers: corsHeaders() });
    }
    return textOk();
  }

  const authError = rejectUnlessValidTelegramWebhookSecret(request, env);
  if (authError) {
    return authError;
  }

  const updateId = Number(body.update_id);
  if (!Number.isFinite(updateId)) {
    return textOk();
  }

  if (await isDuplicateTelegramUpdate(updateId, env)) {
    return textOk();
  }

  ctx.waitUntil(handleTelegramUpdate(body, env));
  ctx.waitUntil(ensureMiniAppMenuButtonSynced(env));
  return textOk();
}

async function handleRootPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (!body) {
    return textOk();
  }
  return processTelegramWebhook(request, body, env, ctx, 'not_found');
}

async function handleWebhookPost(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const body = await parseJsonBody(request);
  if (!body) {
    return textOk();
  }
  return processTelegramWebhook(request, body, env, ctx, 'ok');
}

async function handleApiPost(request: Request, env: Env): Promise<Response> {
  if (isMultipartRequest(request)) {
    try {
      const formData = await request.formData();
      const fields = new Map<string, FormDataEntryValue>();
      formData.forEach((value, key) => {
        fields.set(key, value);
      });
      return await routeMultipartAction(fields, env);
    } catch {
      return jsonResponse({ ok: false, error: 'portfolio_upload_failed' });
    }
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ ok: false, error: 'server_error', message: 'Empty body' });
  }
  try {
    const url = new URL(request.url);
    return await routeApiAction(body, env, url.origin);
  } catch {
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);
    const { method } = request;
    const pathname = url.pathname.replace(/\/$/, '') || '/';

    if (method === 'OPTIONS') {
      return handleOptions();
    }

    if (method === 'GET' && pathname === '/') {
      ctx.waitUntil(ensureMiniAppMenuButtonSynced(env));
      return textOk();
    }

    if (method === 'GET' && pathname === '/portfolio-media') {
      return handlePortfolioMediaGet(request, env);
    }

    if (method === 'GET' && pathname === '/miniapp') {
      return miniAppRedirect(request, env, 'catalog');
    }

    if (method === 'GET' && pathname === '/miniapp/rules') {
      return miniAppRedirect(request, env, 'rules');
    }

    if (method === 'GET' && pathname === '/api') {
      const action = url.searchParams.get('action');
      if (action === 'getLikes') {
        return handleGetLikes(request, env);
      }
      if (action === 'toggleLike') {
        return handleToggleLike(request, env);
      }
      if (action === 'getFavoriteCounts') {
        return handleGetFavoriteCounts(request, env);
      }
      if (action === 'toggleFavorite') {
        return handleToggleFavorite(request, env);
      }
      return new Response('Not Found', { status: 404, headers: corsHeaders() });
    }

    if (method === 'POST' && pathname === '/') {
      return handleRootPost(request, env, ctx);
    }

    if (method === 'POST' && pathname === '/webhook') {
      return handleWebhookPost(request, env, ctx);
    }

    if (method === 'POST' && pathname === '/api') {
      return handleApiPost(request, env);
    }

    return new Response('Not Found', { status: 404, headers: corsHeaders() });
  },

  async scheduled(
    _event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(dailyMaintenance(env));
    ctx.waitUntil(ensureMiniAppMenuButtonSynced(env));
  },
};
