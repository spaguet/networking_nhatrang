/**
 * Integration tests must target an explicit staging Worker — never production by default.
 * See tests/CI_ENV.md for required CI variables.
 */

export const PRODUCTION_WORKER_URL =
  'https://tg-networking-nhatrang.albertkoall.workers.dev';

export const INTEGRATION_SKIP_REASON =
  'Set ADMIN_API_URL to your staging Worker URL (see tests/CI_ENV.md). Integration tests do not default to production.';

export const PRODUCTION_SKIP_REASON =
  'Refusing integration tests against production ADMIN_API_URL. Use a staging Worker or set ALLOW_PROD_INTEGRATION_TESTS=1.';

/** Resolved staging Worker base URL, or null when ADMIN_API_URL is unset. */
export function getStagingApiUrl(): string | null {
  const raw = process.env.ADMIN_API_URL?.trim();
  if (!raw) {
    return null;
  }
  return raw.replace(/\/$/, '');
}

export function isProductionWorkerUrl(url: string): boolean {
  return url.replace(/\/$/, '') === PRODUCTION_WORKER_URL;
}

export function allowProductionIntegrationTests(): boolean {
  return process.env.ALLOW_PROD_INTEGRATION_TESTS === '1';
}

/**
 * Returns staging URL or skips the current test (Playwright).
 * Call from test.beforeEach / beforeAll or at the start of a test body.
 */
export function resolveStagingApiUrl(): string | undefined {
  const url = getStagingApiUrl();
  if (!url) {
    return undefined;
  }
  if (isProductionWorkerUrl(url) && !allowProductionIntegrationTests()) {
    return undefined;
  }
  return url;
}
