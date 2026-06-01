import type { Env } from '../env';
import { jsonResponse } from '../utils/response';
import { routeAdminAction } from './admin';
import {
  handleArchiveListing,
  handleGetListings,
  handleGetMyListings,
  handleSubmitListing,
  handleSubmitListingEdit,
} from './listings';
import { handleGetPortfolio, handleUploadPortfolioB64, handleUploadPortfolioStagingB64 } from './portfolio';
import { handleCheckListingStatus, handleSelectPaymentMethod } from './payment';
import { handleGetPinPrices, handleSelectPinPaymentMethod } from './pins';
import { handleGetFavoritesListings } from './favorites';
import { handleVerifyTelegramContact } from './messaging';

export async function routeApiAction(
  body: Record<string, unknown>,
  env: Env,
  workerOrigin = '',
): Promise<Response> {
  const action = body.action;
  if (typeof action !== 'string' || !action) {
    return jsonResponse({ ok: false, error: 'unknown_action' });
  }

  const adminResponse = await routeAdminAction(body, env);
  if (adminResponse) {
    return adminResponse;
  }

  switch (action) {
    case 'get_listings':
      return handleGetListings(body, env);
    case 'get_my_listings':
      return handleGetMyListings(body, env);
    case 'submit_listing':
      return handleSubmitListing(body, env);
    case 'submit_listing_edit':
      return handleSubmitListingEdit(body, env);
    case 'archive_listing':
      return handleArchiveListing(body, env);
    case 'check_listing_status':
      return handleCheckListingStatus(body, env);
    case 'select_payment_method':
      return handleSelectPaymentMethod(body, env);
    case 'get_pin_prices':
      return handleGetPinPrices(body, env);
    case 'select_pin_payment_method':
      return handleSelectPinPaymentMethod(body, env);
    case 'get_portfolio':
      return handleGetPortfolio(body, env, workerOrigin);
    case 'upload_portfolio_staging_b64':
      return handleUploadPortfolioStagingB64(body, env);
    case 'upload_portfolio_b64':
      return handleUploadPortfolioB64(body, env);
    case 'get_favorites':
      return handleGetFavoritesListings(body, env);
    case 'verify_telegram_contact':
      return handleVerifyTelegramContact(body, env);
    default:
      return jsonResponse({ ok: false, error: 'unknown_action' });
  }
}
