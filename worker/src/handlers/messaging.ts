import type { Env } from '../env';
import { validateMiniAppRequest } from '../utils/auth';
import { rejectIfBanned } from '../utils/helpers';
import {
  checkComplaintRateLimit,
  checkMessageRateLimit,
  computeConversationId,
  countUnreadConversations,
  fetchMessagesForConversation,
  generateMessageId,
  incrementComplaintRateLimit,
  incrementMessageRateLimit,
  isConversationExpired,
  isConversationUnread,
  loadConversationForParticipant,
  messagePreview,
  MESSAGE_MAX_LEN,
  MESSAGE_TTL_MS,
  type ConversationRow,
  validateMessageBody,
} from '../utils/messaging-helpers';
import { containsLink } from '../utils/links';
import { sendToAllAdmins } from '../services/telegram-api';
import { logAction } from '../utils/helpers';
import { jsonResponse } from '../utils/response';
import {
  checkTelegramVerifyRateLimit,
  incrementTelegramVerifyRateLimit,
  TELEGRAM_VERIFY_ERROR_MESSAGES,
} from '../utils/telegram-listing-verify';
import {
  buildTelegramChatUrl,
  parseTelegramUsername,
  verifyTelegramContactForOwner,
} from '../utils/telegram-contact';

function checkServerConfig(env: Env): Response | null {
  if (!env.BOT_TOKEN) {
    return jsonResponse({ ok: false, error: 'server_config' });
  }
  return null;
}

export async function handleVerifyTelegramContact(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const tgId = Number(body.tg_id);
    if (!tgId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const contacts = String(body.contacts ?? '').trim();
    if (!contacts) {
      return jsonResponse({
        ok: false,
        error: 'invalid_telegram_username',
        message: TELEGRAM_VERIFY_ERROR_MESSAGES.invalid_telegram_username,
      });
    }

    const rate = await checkTelegramVerifyRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({
        ok: false,
        error: 'telegram_verify_rate_limit',
        message: TELEGRAM_VERIFY_ERROR_MESSAGES.telegram_verify_rate_limit,
      });
    }

    const result = await verifyTelegramContactForOwner(env, tgId, contacts);
    await incrementTelegramVerifyRateLimit(tgId, env);

    if (!result.ok) {
      return jsonResponse({
        ok: false,
        error: result.error,
        message: TELEGRAM_VERIFY_ERROR_MESSAGES[result.error] ?? result.error,
      });
    }

    return jsonResponse({ ok: true, username: result.username });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleVerifyTelegramContact:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

interface ResolveListingRow {
  listing_id: string;
  tg_id: number;
  status: string;
  contact_type: string;
  contacts: string;
  telegram_username_verified: string | null;
  owner_username: string | null;
}

export async function handleResolveTelegramChat(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const cfgErr = checkServerConfig(env);
    if (cfgErr) {
      return cfgErr;
    }

    const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
    if (!auth.ok) {
      return jsonResponse({ ok: false, error: auth.error });
    }

    const tgId = Number(body.tg_id);
    if (!tgId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const banned = await rejectIfBanned(tgId, env.DB);
    if (banned) {
      return banned;
    }

    const listingId = String(body.listing_id ?? '').trim();
    if (!listingId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const row = await env.DB.prepare(
      `SELECT l.listing_id, l.tg_id, l.status, l.contact_type, l.contacts,
              l.telegram_username_verified, u.username AS owner_username
       FROM listings l
       LEFT JOIN users u ON u.tg_id = l.tg_id
       WHERE l.listing_id = ?`,
    )
      .bind(listingId)
      .first<ResolveListingRow>();

    if (!row) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }

    if (row.status !== 'active') {
      return jsonResponse({ ok: false, error: 'listing_not_active' });
    }

    if (row.contact_type !== 'Telegram') {
      return jsonResponse({ ok: false, error: 'messaging_not_available' });
    }

    if (row.tg_id === tgId) {
      return jsonResponse({ ok: false, error: 'forbidden' });
    }

    let url: string;
    try {
      const verified = row.telegram_username_verified?.trim();
      if (verified) {
        url = buildTelegramChatUrl({ username: verified, ownerTgId: row.tg_id });
      } else if (row.owner_username?.trim()) {
        url = buildTelegramChatUrl({
          username: row.owner_username,
          ownerTgId: row.tg_id,
        });
      } else {
        try {
          const parsed = parseTelegramUsername(row.contacts);
          url = buildTelegramChatUrl({ username: parsed, ownerTgId: row.tg_id });
        } catch {
          url = buildTelegramChatUrl({ ownerTgId: row.tg_id });
        }
      }
    } catch {
      return jsonResponse({ ok: false, error: 'invalid_telegram_username' });
    }

    return jsonResponse({ ok: true, url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleResolveTelegramChat:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

interface OpenListingRow {
  listing_id: string;
  tg_id: number;
  status: string;
  contact_type: string;
  display_name: string;
  avatar_emoji: string | null;
}

interface ConversationListRow extends ConversationRow {
  listing_display_name: string;
  listing_avatar_emoji: string | null;
}

function formatConversationResponse(
  conversation: ConversationRow,
  listing?: { display_name: string; avatar_emoji: string | null },
  unread?: boolean,
): Record<string, unknown> {
  const expired = isConversationExpired(conversation.expires_at);
  return {
    conversation_id: conversation.conversation_id,
    listing_id: conversation.listing_id,
    owner_tg_id: conversation.owner_tg_id,
    peer_tg_id: conversation.peer_tg_id,
    created_at: conversation.created_at,
    first_message_at: conversation.first_message_at,
    expires_at: conversation.expires_at,
    last_message_at: conversation.last_message_at,
    last_message_preview: conversation.last_message_preview,
    status: conversation.status,
    expired,
    listing_display_name: listing?.display_name ?? null,
    listing_avatar_emoji: listing?.avatar_emoji ?? null,
    unread: unread ?? false,
  };
}

async function authMessagingRequest(
  body: Record<string, unknown>,
  env: Env,
): Promise<
  | { ok: false; response: Response }
  | { ok: true; tgId: number }
> {
  const cfgErr = checkServerConfig(env);
  if (cfgErr) {
    return { ok: false, response: cfgErr };
  }

  const auth = await validateMiniAppRequest(body, env, 'Invalid initData');
  if (!auth.ok) {
    return { ok: false, response: jsonResponse({ ok: false, error: auth.error }) };
  }

  const tgId = Number(body.tg_id);
  if (!tgId) {
    return { ok: false, response: jsonResponse({ ok: false, error: 'missing_params' }) };
  }

  const banned = await rejectIfBanned(tgId, env.DB);
  if (banned) {
    return { ok: false, response: banned };
  }

  return { ok: true, tgId };
}

async function getOrCreateConversation(
  env: Env,
  listing: OpenListingRow,
  peerTgId: number,
): Promise<ConversationRow> {
  const ownerTgId = listing.tg_id;
  const conversationId = await computeConversationId(listing.listing_id, ownerTgId, peerTgId);
  const now = new Date().toISOString();

  const existing = await env.DB.prepare('SELECT * FROM conversations WHERE conversation_id = ?')
    .bind(conversationId)
    .first<ConversationRow>();

  if (existing) {
    return existing;
  }

  await env.DB.prepare(
    `INSERT INTO conversations (
       conversation_id, listing_id, owner_tg_id, peer_tg_id, created_at, status
     ) VALUES (?, ?, ?, ?, ?, 'open')`,
  )
    .bind(conversationId, listing.listing_id, ownerTgId, peerTgId, now)
    .run();

  return {
    conversation_id: conversationId,
    listing_id: listing.listing_id,
    owner_tg_id: ownerTgId,
    peer_tg_id: peerTgId,
    created_at: now,
    first_message_at: null,
    expires_at: null,
    last_message_at: null,
    last_message_id: null,
    last_message_preview: null,
    status: 'open',
  };
}

export async function handleOpenConversation(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const listingId = String(body.listing_id ?? '').trim();
    if (!listingId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const listing = await env.DB.prepare(
      `SELECT listing_id, tg_id, status, contact_type, display_name, avatar_emoji
       FROM listings WHERE listing_id = ?`,
    )
      .bind(listingId)
      .first<OpenListingRow>();

    if (!listing) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }
    if (listing.status !== 'active') {
      return jsonResponse({ ok: false, error: 'listing_not_active' });
    }
    if (listing.contact_type === 'Telegram') {
      return jsonResponse({ ok: false, error: 'messaging_not_available' });
    }
    if (listing.tg_id === tgId) {
      return jsonResponse({ ok: false, error: 'forbidden' });
    }

    const conversation = await getOrCreateConversation(env, listing, tgId);
    if (conversation.status === 'closed') {
      return jsonResponse({ ok: false, error: 'conversation_closed' });
    }

    const expired = isConversationExpired(conversation.expires_at);
    const messages = await fetchMessagesForConversation(env.DB, conversation.conversation_id, 50);
    const unread = await isConversationUnread(conversation, tgId, env.DB);

    return jsonResponse({
      ok: true,
      conversation: formatConversationResponse(
        conversation,
        { display_name: listing.display_name, avatar_emoji: listing.avatar_emoji },
        unread,
      ),
      messages,
      expired,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleOpenConversation:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleSendMessage(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const conversationId = String(body.conversation_id ?? '').trim();
    if (!conversationId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const validation = validateMessageBody(body.body);
    if (!validation.ok) {
      return jsonResponse({ ok: false, error: validation.error });
    }

    const conversation = await loadConversationForParticipant(conversationId, tgId, env.DB);
    if (!conversation) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }
    if (conversation.status === 'closed') {
      return jsonResponse({ ok: false, error: 'conversation_closed' });
    }
    if (isConversationExpired(conversation.expires_at)) {
      return jsonResponse({ ok: false, error: 'conversation_expired' });
    }

    const rate = await checkMessageRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({ ok: false, error: 'message_rate_limit' });
    }

    const now = new Date().toISOString();
    const messageId = generateMessageId();
    const preview = messagePreview(validation.body);
    const isFirstMessage = !conversation.first_message_at;
    const firstMessageAt = isFirstMessage ? now : conversation.first_message_at;
    const expiresAt = isFirstMessage
      ? new Date(Date.now() + MESSAGE_TTL_MS).toISOString()
      : conversation.expires_at;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO messages (message_id, conversation_id, sender_tg_id, body, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(messageId, conversationId, tgId, validation.body, now),
      env.DB.prepare(
        `UPDATE conversations
         SET first_message_at = COALESCE(first_message_at, ?),
             expires_at = COALESCE(expires_at, ?),
             last_message_at = ?,
             last_message_id = ?,
             last_message_preview = ?
         WHERE conversation_id = ?`,
      ).bind(firstMessageAt, expiresAt, now, messageId, preview, conversationId),
    ]);

    await incrementMessageRateLimit(tgId, env);

    return jsonResponse({
      ok: true,
      message: {
        message_id: messageId,
        conversation_id: conversationId,
        sender_tg_id: tgId,
        body: validation.body,
        created_at: now,
      },
      expires_at: expiresAt,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleSendMessage:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleGetMessages(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const conversationId = String(body.conversation_id ?? '').trim();
    if (!conversationId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const conversation = await loadConversationForParticipant(conversationId, tgId, env.DB);
    if (!conversation) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }
    if (conversation.status === 'closed') {
      return jsonResponse({ ok: false, error: 'conversation_closed' });
    }

    const beforeId = String(body.before_id ?? '').trim() || undefined;
    const limit = Number(body.limit) || 50;
    const messages = await fetchMessagesForConversation(env.DB, conversationId, limit, beforeId);
    const expired = isConversationExpired(conversation.expires_at);

    return jsonResponse({
      ok: true,
      messages,
      expired,
      conversation: formatConversationResponse(conversation),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleGetMessages:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleListMyConversations(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const result = await env.DB.prepare(
      `SELECT c.*, l.display_name AS listing_display_name, l.avatar_emoji AS listing_avatar_emoji
       FROM conversations c
       INNER JOIN listings l ON l.listing_id = c.listing_id
       WHERE c.owner_tg_id = ? OR c.peer_tg_id = ?
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC`,
    )
      .bind(tgId, tgId)
      .all<ConversationListRow>();

    const conversations: Record<string, unknown>[] = [];
    for (const row of result.results ?? []) {
      const unread = await isConversationUnread(row, tgId, env.DB);
      conversations.push(formatConversationResponse(
        row,
        { display_name: row.listing_display_name, avatar_emoji: row.listing_avatar_emoji },
        unread,
      ));
    }

    return jsonResponse({ ok: true, conversations });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleListMyConversations:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleGetMessagingUnread(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const unreadCount = await countUnreadConversations(tgId, env.DB);

    return jsonResponse({
      ok: true,
      has_unread: unreadCount > 0,
      unread_count: unreadCount,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleGetMessagingUnread:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

export async function handleMarkConversationRead(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const conversationId = String(body.conversation_id ?? '').trim();
    if (!conversationId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const conversation = await loadConversationForParticipant(conversationId, tgId, env.DB);
    if (!conversation) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }
    if (conversation.status === 'closed') {
      return jsonResponse({ ok: false, error: 'conversation_closed' });
    }

    const now = new Date().toISOString();
    const lastReadMessageId = conversation.last_message_id;

    if (lastReadMessageId && conversation.last_message_at) {
      await env.DB.prepare(
        `INSERT INTO conversation_reads (
           conversation_id, reader_tg_id, last_read_at, last_read_message_id
         ) VALUES (?, ?, ?, ?)
         ON CONFLICT(conversation_id, reader_tg_id) DO UPDATE SET
           last_read_at = excluded.last_read_at,
           last_read_message_id = excluded.last_read_message_id`,
      )
        .bind(conversationId, tgId, conversation.last_message_at, lastReadMessageId)
        .run();
    }

    const unreadCount = await countUnreadConversations(tgId, env.DB);

    return jsonResponse({
      ok: true,
      has_unread: unreadCount > 0,
      unread_count: unreadCount,
      marked_at: now,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleMarkConversationRead:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}

const COMPLAINT_ADMIN_PUSH =
  'Подана жалоба. Для рассмотрения жалобы войдите в профиль администратора.';

function validateComplaintBody(
  raw: unknown,
): { ok: true; body: string } | { ok: false; error: string } {
  const body = String(raw ?? '').trim();
  if (!body) {
    return { ok: false, error: 'validation' };
  }
  if (body.length > MESSAGE_MAX_LEN) {
    return { ok: false, error: 'message_too_long' };
  }
  if (containsLink(body)) {
    return { ok: false, error: 'links_forbidden' };
  }
  return { ok: true, body };
}

export async function handleSubmitMessageComplaint(
  body: Record<string, unknown>,
  env: Env,
): Promise<Response> {
  try {
    const authResult = await authMessagingRequest(body, env);
    if (!authResult.ok) {
      return authResult.response;
    }
    const tgId = authResult.tgId;

    const conversationId = String(body.conversation_id ?? '').trim();
    if (!conversationId) {
      return jsonResponse({ ok: false, error: 'missing_params' });
    }

    const validation = validateComplaintBody(body.body);
    if (!validation.ok) {
      return jsonResponse({ ok: false, error: validation.error });
    }

    const rate = await checkComplaintRateLimit(tgId, env);
    if (!rate.allowed) {
      return jsonResponse({ ok: false, error: 'complaint_rate_limit' });
    }

    const conversation = await loadConversationForParticipant(conversationId, tgId, env.DB);
    if (!conversation) {
      return jsonResponse({ ok: false, error: 'not_found' });
    }
    if (conversation.status === 'closed') {
      return jsonResponse({ ok: false, error: 'conversation_closed' });
    }

    const complaintId = crypto.randomUUID();
    const now = new Date().toISOString();

    await env.DB.prepare(
      `INSERT INTO message_complaints (
         complaint_id, conversation_id, reporter_tg_id, body, created_at,
         participant_a_tg_id, participant_b_tg_id, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open')`,
    )
      .bind(
        complaintId,
        conversationId,
        tgId,
        validation.body,
        now,
        conversation.owner_tg_id,
        conversation.peer_tg_id,
      )
      .run();

    await incrementComplaintRateLimit(tgId, env);
    await sendToAllAdmins(env.DB, env, COMPLAINT_ADMIN_PUSH);
    await logAction(tgId, 'message_complaint', conversationId, env.DB);

    return jsonResponse({ ok: true, complaint_id: complaintId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('handleSubmitMessageComplaint:', msg);
    return jsonResponse({ ok: false, error: 'server_error' });
  }
}
