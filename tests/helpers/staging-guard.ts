import { test } from '@playwright/test';
import {
  getStagingApiUrl,
  INTEGRATION_SKIP_REASON,
  isProductionWorkerUrl,
  allowProductionIntegrationTests,
  PRODUCTION_SKIP_REASON,
} from './integration-env';

/**
 * Register once per integration spec file — skips all tests when staging is not configured
 * or when ADMIN_API_URL points at production without ALLOW_PROD_INTEGRATION_TESTS=1.
 */
export function useStagingGuard(): void {
  test.beforeEach(() => {
    const url = getStagingApiUrl();
    if (!url) {
      test.skip(true, INTEGRATION_SKIP_REASON);
      return;
    }
    if (isProductionWorkerUrl(url) && !allowProductionIntegrationTests()) {
      test.skip(true, PRODUCTION_SKIP_REASON);
    }
  });
}
