import type { Env } from './env';
import { routeApiAction } from './handlers/api';
import { handleGetLikes, handleToggleLike } from './handlers/likes';
import { dailyMaintenance } from './handlers/maintenance';
import {
  handleTelegramUpdate,
  isDuplicateTelegramUpdate,
} from './handlers/telegram';
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

function isTelegramUpdate(body: Record<string, unknown>): boolean {
  return body.update_id !== undefined && body.update_id !== null;
}

async function processTelegramWebhook(
  body: Record<string, unknown>,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (body.ping) {
    return textOk();
  }

  if (!isTelegramUpdate(body)) {
    return new Response('Not Found', { status: 404, headers: corsHeaders() });
  }

  const updateId = Number(body.update_id);
  if (!Number.isFinite(updateId)) {
    return textOk();
  }

  if (await isDuplicateTelegramUpdate(updateId, env)) {
    return textOk();
  }

  ctx.waitUntil(handleTelegramUpdate(body, env));
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
  return processTelegramWebhook(body, env, ctx);
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

  if (body.ping) {
    return textOk();
  }

  if (!isTelegramUpdate(body)) {
    return textOk();
  }

  const updateId = Number(body.update_id);
  if (!Number.isFinite(updateId)) {
    return textOk();
  }

  if (await isDuplicateTelegramUpdate(updateId, env)) {
    return textOk();
  }

  ctx.waitUntil(handleTelegramUpdate(body, env));
  return textOk();
}

async function handleApiPost(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  if (!body) {
    return jsonResponse({ ok: false, error: 'server_error', message: 'Empty body' });
  }
  try {
    return await routeApiAction(body, env);
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
      return textOk();
    }

    if (method === 'GET' && pathname === '/api') {
      const action = url.searchParams.get('action');
      if (action === 'getLikes') {
        return handleGetLikes(request, env);
      }
      if (action === 'toggleLike') {
        return handleToggleLike(request, env);
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
  },
};
