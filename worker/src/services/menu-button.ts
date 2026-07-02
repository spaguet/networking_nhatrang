import type { Env } from '../env';
import { setChatMenuButton } from './telegram-api';

const MENU_BUTTON_SYNC_KV_KEY = 'mini_app_menu_button_target';
const MENU_BUTTON_TEXT = 'Каталог';

/**
 * Keeps Telegram's persistent (attach-menu) button pointed at our own
 * `${WORKER_URL}/miniapp` redirect instead of a raw GitHub Pages link.
 *
 * That redirect always forwards to the freshest catalog.html with a
 * live cache-buster (see index.ts + utils/miniapp-url.ts), so once this
 * has run once, nobody ever has to open BotFather and update the menu
 * button URL again after a deploy — the indirection absorbs all future
 * cache-busting changes.
 *
 * Idempotent and cheap: a single KV read short-circuits when already in
 * sync, and it only calls the Telegram Bot API when the target actually
 * changed (e.g. WORKER_URL was updated). Safe to call on every webhook
 * update and from the daily cron.
 */
export async function ensureMiniAppMenuButtonSynced(env: Env): Promise<void> {
  const workerUrl = (env.WORKER_URL || '').trim().replace(/\/+$/, '');
  if (!workerUrl || !env.BOT_TOKEN) {
    return;
  }

  const target = `${workerUrl}/miniapp`;
  const desired = `${target}|${MENU_BUTTON_TEXT}`;

  try {
    const stored = await env.CACHE.get(MENU_BUTTON_SYNC_KV_KEY);
    if (stored === desired) {
      return;
    }

    const ok = await setChatMenuButton(target, MENU_BUTTON_TEXT, env);
    if (ok) {
      await env.CACHE.put(MENU_BUTTON_SYNC_KV_KEY, desired);
    }
  } catch {
    // Best effort — never block webhook/cron processing on this.
  }
}
