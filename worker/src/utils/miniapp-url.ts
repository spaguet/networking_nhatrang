/**
 * Shared helpers for building Telegram Mini App URLs (catalog.html / rules.html
 * hosted on GitHub Pages, MINI_APP_URL env var).
 *
 * The cache-buster (`?v=`) is always computed fresh (current timestamp) rather
 * than a hardcoded constant, so every link this worker generates is guaranteed
 * to bypass stale caches without anyone needing to remember to bump a version
 * number after each deploy. See also `/miniapp` in index.ts + services/menu-button.ts
 * for the one link that Telegram itself caches long-term (the persistent menu
 * button) — that one is kept stable forever and redirects here instead.
 */

export function isValidMiniAppUrl(url: string | undefined): boolean {
  const u = (url || '').trim();
  if (!u || !u.startsWith('https://')) {
    return false;
  }
  if (u.includes('script.google.com') || u.includes('googleusercontent.com')) {
    return false;
  }
  return true;
}

function normalizeMiniAppBaseUrl(url: string): string {
  return url
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/index\.html(\?.*)?$/i, '')
    .replace(/\/catalog\.html(\?.*)?$/i, '')
    .replace(/\/rules\.html(\?.*)?$/i, '');
}

function freshCacheBusterVersion(): string {
  return String(Date.now());
}

export function getMiniAppCatalogUrl(miniAppUrl: string): string {
  const u = miniAppUrl.trim();
  if (!u) {
    return '';
  }
  let base: string;
  if (u.includes('/catalog.html')) {
    base = u.replace(/\/+$/, '');
  } else {
    base = `${normalizeMiniAppBaseUrl(u)}/catalog.html`;
  }
  try {
    const parsed = new URL(base);
    parsed.searchParams.set('v', freshCacheBusterVersion());
    return parsed.toString();
  } catch {
    return `${base}?v=${freshCacheBusterVersion()}`;
  }
}

export function getMiniAppRulesUrl(miniAppUrl: string): string {
  const u = miniAppUrl.trim();
  if (!u) {
    return '';
  }
  let base: string;
  if (u.includes('/rules.html')) {
    base = u.replace(/\/+$/, '');
  } else {
    base = `${normalizeMiniAppBaseUrl(u)}/rules.html`;
  }
  try {
    const parsed = new URL(base);
    parsed.searchParams.set('v', freshCacheBusterVersion());
    return parsed.toString();
  } catch {
    return `${base}?v=${freshCacheBusterVersion()}`;
  }
}
