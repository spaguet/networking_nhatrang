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
import {
  handleGetFavoriteCountsPost,
  handleGetFavoritesListings,
  handleToggleFavoritePost,
} from './favorites';
import { handleGetLikesPost, handleToggleLikePost } from './likes';
import {
  handleGetMessages,
  handleGetMessagingUnread,
  handleGetMyTelegramUsername,
  handleListMyConversations,
  handleMarkConversationRead,
  handleOpenConversation,
  handleResolveTelegramChat,
  handleSendMessage,
  handleSubmitMessageComplaint,
  handleVerifyTelegramContact,
} from './messaging';

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
    case 'get_likes':
      return handleGetLikesPost(body, env);
    case 'toggle_like':
      return handleToggleLikePost(body, env);
    case 'get_favorite_counts':
      return handleGetFavoriteCountsPost(body, env);
    case 'toggle_favorite':
      return handleToggleFavoritePost(body, env);
    case 'get_my_telegram_username':
      return handleGetMyTelegramUsername(body, env);
    case 'verify_telegram_contact':
      return handleVerifyTelegramContact(body, env);
    case 'resolve_telegram_chat':
      return handleResolveTelegramChat(body, env);
    case 'open_conversation':
      return handleOpenConversation(body, env);
    case 'send_message':
      return handleSendMessage(body, env);
    case 'get_messages':
      return handleGetMessages(body, env);
    case 'list_my_conversations':
      return handleListMyConversations(body, env);
    case 'get_messaging_unread':
      return handleGetMessagingUnread(body, env);
    case 'mark_conversation_read':
      return handleMarkConversationRead(body, env);
    case 'submit_message_complaint':
      return handleSubmitMessageComplaint(body, env);
    default:
      return jsonResponse({ ok: false, error: 'unknown_action' });
  }
}
