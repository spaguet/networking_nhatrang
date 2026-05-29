import {
  DEFAULT_AVATAR_EMOJI,
  QR_PAYMENT_METHODS,
  type AppConfig,
  type QrPaymentMethod,
  getConfig,
} from '../config';
import type { Env } from '../env';
import type { AdminLink } from '../types';
import {
  answerCallbackQuery,
  editMessageReplyMarkup,
  moderationKeyboard,
  pinModerationKeyboard,
  sendMessage,
  sendPhoto,
  type TelegramReplyMarkup,
} from '../services/telegram-api';
import { decodeDescriptionNewlines } from '../utils/description';
import {
  ensureUser,
  formatDateRu,
  getPinDurationLabel,
  getPinPriceByDuration,
  logAction,
  paymentMethodLabel,
  setUserFreeUsed,
} from '../utils/helpers';
import { pinApproveListing, pinRejectListing } from './pins';
import {
  clearSession,
  getSession,
  parsePinSessionDraft,
  parseSessionDraft,
  upsertSession,
  type PaidListingDraft,
} from './sessions';

const WEBHOOK_DEDUP_TTL = 21600;

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramPhotoSize {
  file_id: string;
}

interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
  reply_to_message?: { message_id: number };
  document?: unknown;
}

interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  data?: string;
  message?: TelegramMessage;
}

interface ListingAdminData {
  display_name: string;
  category: string;
  description: string;
  experience?: string;
  contact_type?: string;
  contacts: string;
}

/** KV dedup — upd_{update_id}, TTL 21600s (как isDuplicateUpdate в Code.gs) */
export async function isDuplicateTelegramUpdate(
  updateId: number,
  env: Env,
): Promise<boolean> {
  const key = `upd_${updateId}`;
  const existing = await env.CACHE.get(key);
  if (existing !== null) {
    return true;
  }
  await env.CACHE.put(key, '1', { expirationTtl: WEBHOOK_DEDUP_TTL });
  return false;
}

export async function saveAdminLink(
  adminMessageId: number,
  userTgId: number,
  linkType: string,
  listingId: string,
  env: Env,
): Promise<void> {
  try {
    const now = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO admin_links (admin_message_id, user_tg_id, link_type, listing_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(adminMessageId, userTgId, linkType, listingId || null, now)
      .run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(userTgId, 'error', `saveAdminLink: ${msg}`, env.DB);
  }
}

export async function findAdminLink(
  adminMessageId: number,
  env: Env,
): Promise<AdminLink | null> {
  try {
    const row = await env.DB.prepare(
      `SELECT admin_message_id, user_tg_id, link_type, listing_id, created_at
       FROM admin_links
       WHERE admin_message_id = ?`,
    )
      .bind(adminMessageId)
      .first<AdminLink>();

    return row ?? null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `findAdminLink: ${msg}`, env.DB);
    return null;
  }
}

function isValidMiniAppUrl(url: string | undefined): boolean {
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
    .replace(/\/catalog\.html(\?.*)?$/i, '');
}

function getMiniAppCatalogUrl(miniAppUrl: string): string {
  const u = miniAppUrl.trim();
  if (!u) {
    return '';
  }
  if (u.includes('/catalog.html')) {
    return u.replace(/\/+$/, '');
  }
  return `${normalizeMiniAppBaseUrl(u)}/catalog.html`;
}

function getMiniAppRulesUrl(miniAppUrl: string): string {
  const u = miniAppUrl.trim();
  if (!u) {
    return '';
  }
  if (u.includes('/rules.html')) {
    return u.replace(/\/+$/, '');
  }
  return `${normalizeMiniAppBaseUrl(u)}/rules.html`;
}

function getMessageCommand(message: TelegramMessage): string {
  const text = (message.text || '').trim();
  if (!text || text.charAt(0) !== '/') {
    return '';
  }
  return text.split(/\s+/)[0].split('@')[0].toLowerCase();
}

function formatUserRef(user: TelegramUser): string {
  const tgId = user.id;
  const username = user.username ? `@${user.username}` : '(без username)';
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return `ID: ${tgId}\nИмя: ${name || '—'}\nUsername: ${username}`;
}

function findQrMethodByCaption(caption: string | undefined): QrPaymentMethod | null {
  const normalized = (caption || '').trim().toLowerCase();
  for (let i = 0; i < QR_PAYMENT_METHODS.length; i++) {
    const method = QR_PAYMENT_METHODS[i];
    if (method.captions.includes(normalized)) {
      return method;
    }
  }
  return null;
}

function formatListingAdminText(
  listingId: string,
  tgId: number,
  data: ListingAdminData,
  paymentStatus: string,
  userRef: string | null,
): string {
  const paymentLabel =
    paymentStatus === 'free'
      ? 'Бесплатное (первое)'
      : paymentStatus === 'paid'
        ? 'Платное'
        : String(paymentStatus || '—');

  let text =
    '📋 МОДЕРАЦИЯ АНКЕТЫ\n' +
    `listing_id: ${listingId}\n` +
    `Оплата: ${paymentLabel}\n\n` +
    `Имя: ${data.display_name}\n` +
    `Категория: ${data.category}\n` +
    `Опыт/стаж: ${data.experience || '—'}\n` +
    `Описание: ${decodeDescriptionNewlines(data.description)}\n` +
    `Тип контакта: ${data.contact_type || '—'}\n` +
    `Контакты: ${data.contacts}`;

  if (userRef) {
    text += `\n\n👤 Аккаунт автора:\n${userRef}`;
  } else {
    text += `\n\n👤 Telegram ID: ${tgId}`;
  }

  text += '\n\n↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.';
  return text;
}

async function getListingData(
  listingId: string,
  env: Env,
): Promise<(ListingAdminData & { tg_id: number; payment_status: string }) | null> {
  const row = await env.DB.prepare(
    `SELECT tg_id, display_name, category, description, experience, contact_type, contacts, payment_status
     FROM listings
     WHERE listing_id = ?`,
  )
    .bind(listingId)
    .first<{
      tg_id: number;
      display_name: string;
      category: string;
      description: string;
      experience: string | null;
      contact_type: string;
      contacts: string;
      payment_status: string;
    }>();

  if (!row) {
    return null;
  }

  return {
    tg_id: row.tg_id,
    display_name: row.display_name,
    category: row.category,
    description: row.description,
    experience: row.experience || '',
    contact_type: row.contact_type,
    contacts: row.contacts,
    payment_status: row.payment_status,
  };
}

function mainMenuKeyboard(config: AppConfig): TelegramReplyMarkup {
  const rows: TelegramReplyMarkup['inline_keyboard'] = [];
  if (isValidMiniAppUrl(config.miniAppUrl)) {
    rows.push([
      {
        text: '🎩 Добро пожаловать!',
        web_app: { url: getMiniAppCatalogUrl(config.miniAppUrl) },
      },
    ]);
    rows.push([
      {
        text: '📋 Правила',
        web_app: { url: getMiniAppRulesUrl(config.miniAppUrl) },
      },
    ]);
  }
  rows.push([{ text: '📩 Написать администратору', callback_data: 'contact_admin' }]);
  return { inline_keyboard: rows };
}

async function sendWelcome(chatId: number | string, env: Env): Promise<void> {
  const config = getConfig(env);
  const text =
    '👋 Добро пожаловать в Место Встречи — Нячанг!\n\n' +
    'Здесь профессионалы, фрилансеры и мастера находят друг друга.\n\n' +
    '🔍 Ищете специалиста? Откройте каталог и выберите нужную категорию.\n\n' +
    '📋 Хотите разместить мини-резюме? Заполните короткую анкету — одно размещение бесплатно.';
  const keyboard = mainMenuKeyboard(config);
  const msgId = await sendMessage(chatId, text, keyboard, env);
  if (!msgId) {
    await sendMessage(
      chatId,
      `${text}\n\n(Меню без кнопок — проверьте MINI_APP_URL в wrangler.toml: нужен URL GitHub Pages, не GAS.)`,
      null,
      env,
    );
  }
}

async function startContactAdmin(tgId: number, env: Env): Promise<void> {
  await upsertSession(tgId, 'contact_admin', '', env);
  await sendMessage(
    tgId,
    '✉️ Напишите администратору одним сообщением (текст или фото).\n\n' +
      'Для отмены отправьте /start',
    null,
    env,
  );
}

function buildQrStatusText(config: AppConfig): string {
  const lines = ['📷 Статус QR-кодов:', ''];
  QR_PAYMENT_METHODS.forEach((m) => {
    const id = config.qr[m.propertyKey];
    lines.push(m.sendCaption);
    lines.push(`  ${m.propertyKey}: ${id ? id : '❌ не задан'}`);
    lines.push('');
  });
  lines.push(
    `Подписи для загрузки: ${QR_PAYMENT_METHODS.map((m) => m.captions[0]).join(', ')}`,
  );
  return lines.join('\n');
}

async function sendQrSetupHint(adminChatId: number | string, env: Env): Promise<void> {
  const lines = [
    'Отправьте фото QR с подписью (одно слово):',
    '',
    ...QR_PAYMENT_METHODS.map(
      (m) => `• ${m.captions[0]} — ${m.sendCaption}`,
    ),
    '',
    'Worker v1: сохранение через wrangler secret put (см. /qr_help)',
    'Команда /qr_status — проверить сохранённые file_id',
  ];
  await sendMessage(adminChatId, lines.join('\n'), null, env);
}

async function handleAdminTextCommand(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const config = getConfig(env);
  const command = getMessageCommand(message);

  if (command === '/qr_status' || command === '/qr') {
    await sendMessage(config.adminTgId, buildQrStatusText(config), null, env);
    return true;
  }

  if (command === '/qr_help') {
    await sendQrSetupHint(config.adminTgId, env);
    return true;
  }

  if (command === '/admin') {
    await sendMessage(
      config.adminTgId,
      '🛠 Команды администратора:\n/qr_help — подписи для QR\n/qr_status — проверка file_id\n/admin — это меню',
      null,
      env,
    );
    return true;
  }

  return false;
}

async function handleAdminQrPhoto(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const config = getConfig(env);
  if (message.from?.id !== config.adminTgId) {
    return false;
  }

  const photos = message.photo;
  if (!photos?.length) {
    return false;
  }

  const method = findQrMethodByCaption(message.caption);
  if (!method) {
    return false;
  }

  const fileId = photos[photos.length - 1].file_id;
  await sendMessage(
    config.adminTgId,
    `ℹ️ Worker v1: QR сохраняются через wrangler secret put (hot-reload через KV — v2).\n\n` +
      `Ключ: ${method.propertyKey}\n` +
      `Подпись: ${method.captions[0]}\n` +
      `file_id из этого фото:\n${fileId}\n\n` +
      `Команда:\nwrangler secret put ${method.propertyKey}`,
    null,
    env,
  );
  await logAction(config.adminTgId, `set_${method.propertyKey}_hint`, fileId, env.DB);
  return true;
}

async function forwardContactToAdmin(
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const config = getConfig(env);
  const user = message.from;
  if (!user) {
    return;
  }

  const tgId = user.id;
  const header =
    '✉️ ОБРАЩЕНИЕ ПОЛЬЗОВАТЕЛЯ\n' +
    `${formatUserRef(user)}\n\n` +
    '↩️ Ответьте на это сообщение (Reply), чтобы ответ ушёл пользователю.';

  let adminMsgId: number | null = null;

  if (message.photo?.length) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    const userCaption = message.caption ? `\n\nТекст: ${message.caption}` : '';
    adminMsgId = await sendPhoto(config.adminTgId, fileId, header + userCaption, null, env);
  } else {
    const body = message.text || message.caption || '(пустое сообщение)';
    adminMsgId = await sendMessage(config.adminTgId, `${header}\n\n${body}`, null, env);
  }

  if (adminMsgId) {
    await saveAdminLink(adminMsgId, tgId, 'contact', '', env);
  }

  await clearSession(tgId, env);
  await sendMessage(
    tgId,
    '✅ Сообщение отправлено администратору.\n\n' +
      'Администратор рассмотрит его в течение 24 часов. Ответ придёт в этот чат.',
    null,
    env,
  );
  await logAction(tgId, 'contact_admin', '', env.DB);
}

async function handleAdminReply(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const config = getConfig(env);
  if (message.from?.id !== config.adminTgId) {
    return false;
  }

  const repliedToId = message.reply_to_message?.message_id;
  if (!repliedToId) {
    return false;
  }

  const link = await findAdminLink(repliedToId, env);
  if (!link) {
    return false;
  }

  const userTgId = Number(link.user_tg_id);
  let delivered = false;

  if (message.text) {
    await sendMessage(userTgId, `📩 Ответ администратора:\n\n${message.text}`, null, env);
    delivered = true;
  } else if (message.photo?.length) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    const cap = message.caption
      ? `📩 Ответ администратора:\n\n${message.caption}`
      : '📩 Ответ администратора';
    await sendPhoto(userTgId, fileId, cap, null, env);
    delivered = true;
  } else if (message.document) {
    await sendMessage(
      userTgId,
      '📩 Администратор отправил файл. Если не видите вложение — напишите в бот ещё раз.',
      null,
      env,
    );
    delivered = true;
  }

  if (delivered) {
    await sendMessage(
      config.adminTgId,
      `✅ Ответ доставлен пользователю ${userTgId} (тип: ${link.link_type})`,
      null,
      env,
    );
    await logAction(
      userTgId,
      'admin_reply',
      `${link.link_type}|${link.listing_id || ''}`,
      env.DB,
    );
  }

  return delivered;
}

async function handlePinProofPhoto(
  message: TelegramMessage,
  session: { draft: string | null; session_type: string | null },
  env: Env,
): Promise<boolean> {
  const draft = parsePinSessionDraft(session.draft);
  if (!draft?.listing_id) {
    return false;
  }

  const config = getConfig(env);
  const user = message.from;
  if (!user || !message.photo?.length) {
    return false;
  }

  const tgId = user.id;
  const fileId = message.photo[message.photo.length - 1].file_id;
  const listingId = String(draft.listing_id);
  const pinDuration = String(draft.pin_duration || 'week');
  const paymentMethod = String(draft.payment_method || '').trim().toLowerCase();
  const price =
    draft.price_label ||
    getPinPriceByDuration(config, pinDuration, paymentMethod || 'vnd');
  const payLabel = paymentMethod ? paymentMethodLabel(paymentMethod) : '—';
  const label = getPinDurationLabel(pinDuration);
  const username = user.username ? `@${user.username}` : '(без username)';

  const caption =
    '📌 Запрос на закрепление\n' +
    `Пользователь: ${username} (ID: ${user.id})\n` +
    `Анкета: ${listingId}\n` +
    `Срок: ${label}\n` +
    `Способ оплаты: ${payLabel}\n` +
    `Стоимость: ${price}\n\n` +
    '↩️ Чек оплаты выше.';

  await sendPhoto(
    config.adminTgId,
    fileId,
    caption,
    pinModerationKeyboard(listingId, pinDuration),
    env,
  );

  await clearSession(tgId, env);
  await sendMessage(
    tgId,
    '✅ Чек получен! В течение 24 часов ваша карточка будет закреплена в каталоге.',
    null,
    env,
  );
  await logAction(tgId, 'pin_proof_received', listingId, env.DB);
  return true;
}

async function insertPaidListing(
  draft: PaidListingDraft,
  tgId: number,
  user: TelegramUser,
  env: Env,
): Promise<void> {
  const now = new Date().toISOString();
  await ensureUser(
    tgId,
    draft.username || user.username || '',
    draft.first_name || user.first_name || '',
    env.DB,
  );

  await env.DB.prepare(
    `INSERT INTO listings (
      listing_id, tg_id, display_name, category, description, experience,
      contact_type, contacts, status, payment_status, created_at, expires_at,
      submitted_at, avatar_emoji, pin_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'on_moderation', 'paid', NULL, NULL, ?, ?, 'regular')`,
  )
    .bind(
      draft.listing_id,
      tgId,
      draft.display_name,
      draft.category,
      draft.description,
      draft.experience || '',
      draft.contact_type || '',
      draft.contacts,
      now,
      draft.avatar_emoji || DEFAULT_AVATAR_EMOJI,
    )
    .run();
}

async function handlePaymentProofPhoto(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const user = message.from;
  if (!user || !message.photo?.length) {
    return false;
  }

  const tgId = user.id;
  const session = await getSession(tgId, env);
  if (!session) {
    return false;
  }

  if (session.state === 'await_pin_proof' && session.session_type === 'pin') {
    return handlePinProofPhoto(message, session, env);
  }

  if (session.state !== 'await_payment_proof') {
    return false;
  }

  const draft = parseSessionDraft(session.draft);
  if (!draft) {
    return false;
  }

  const config = getConfig(env);
  const fileId = message.photo[message.photo.length - 1].file_id;
  const userRef = formatUserRef(user);

  if (draft.type === 'paid_listing') {
    const listingId = draft.listing_id;
    await insertPaidListing(draft, tgId, user, env);

    await sendMessage(
      config.adminTgId,
      formatListingAdminText(listingId, tgId, draft, 'paid', userRef),
      null,
      env,
    );

    const photoCaption =
      '💳 ЧЕК ОПЛАТЫ\n' +
      `${userRef}\n\n` +
      `Анкета: ${listingId}\n` +
      `Способ: ${paymentMethodLabel(draft.payment_method)}`;

    const adminMsgId = await sendPhoto(
      config.adminTgId,
      fileId,
      photoCaption,
      moderationKeyboard(listingId),
      env,
    );
    if (adminMsgId) {
      await saveAdminLink(adminMsgId, tgId, 'payment_proof', listingId, env);
    }

    await clearSession(tgId, env);
    await sendMessage(
      tgId,
      'Ваш чек и мини-резюме отправлены администратору для проверки. ' +
        'В течение 24 часов администратор проверит ваше размещение и разместит его. ' +
        'В случае запрета размещения администратор свяжется с вами для возврата средств.',
      null,
      env,
    );
    await logAction(tgId, 'payment_proof', listingId, env.DB);
    return true;
  }

  const listingId = draft.listing_id;
  const listingData = await getListingData(listingId, env);
  if (listingData) {
    await sendMessage(
      config.adminTgId,
      formatListingAdminText(
        listingId,
        listingData.tg_id,
        listingData,
        listingData.payment_status,
        userRef,
      ),
      null,
      env,
    );
  }

  const caption =
    '💳 ЧЕК ОПЛАТЫ\n' +
    `${userRef}\n\n` +
    `Анкета: ${listingId}\n\n` +
    '↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.';
  const adminMsgId = await sendPhoto(
    config.adminTgId,
    fileId,
    caption,
    moderationKeyboard(listingId),
    env,
  );
  if (adminMsgId) {
    await saveAdminLink(adminMsgId, tgId, 'payment_proof', listingId, env);
  }

  await clearSession(tgId, env);
  await sendMessage(
    tgId,
    'Ваш чек и мини-резюме отправлены администратору для проверки. ' +
      'В течение 24 часов администратор проверит ваше размещение и разместит его. ' +
      'В случае запрета размещения администратор свяжется с вами для возврата средств.',
    null,
    env,
  );
  await logAction(tgId, 'payment_proof', listingId, env.DB);
  return true;
}

async function handleUserContactMessage(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const user = message.from;
  if (!user) {
    return false;
  }

  const config = getConfig(env);
  if (user.id === config.adminTgId) {
    return false;
  }

  const session = await getSession(user.id, env);
  if (!session || session.state !== 'contact_admin') {
    return false;
  }

  await forwardContactToAdmin(message, env);
  return true;
}

async function handleUserTextMessage(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const chatId = message.chat.id;
  const user = message.from;
  if (!user) {
    return false;
  }

  const tgId = user.id;
  const command = getMessageCommand(message);

  if (command === '/start') {
    await logAction(tgId, 'cmd_start', String(chatId), env.DB);
    await sendWelcome(chatId, env);
    return true;
  }

  const session = await getSession(tgId, env);
  if (session?.state === 'contact_admin') {
    await forwardContactToAdmin(message, env);
    return true;
  }

  if (command) {
    await sendWelcome(chatId, env);
    return true;
  }

  return false;
}

async function approveListing(
  listingId: string,
  adminChatId: number | string,
  messageId: number,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  const listing = await env.DB.prepare(
    'SELECT tg_id, payment_status FROM listings WHERE listing_id = ?',
  )
    .bind(listingId)
    .first<{ tg_id: number; payment_status: string }>();

  if (!listing) {
    await answerCallbackQuery(callbackQueryId, 'Анкета не найдена', env);
    return;
  }

  const today = new Date();
  const expires = new Date(today);
  expires.setDate(expires.getDate() + 30);

  await env.DB.prepare(
    `UPDATE listings
     SET status = 'active', created_at = ?, expires_at = ?
     WHERE listing_id = ?`,
  )
    .bind(today.toISOString(), expires.toISOString(), listingId)
    .run();

  if (listing.payment_status === 'free') {
    await setUserFreeUsed(listing.tg_id, true, env.DB);
  }

  await sendMessage(
    listing.tg_id,
    '🎉 Ваше размещение успешно опубликовано в каталоге!\nОно будет активно 30 дней.',
    null,
    env,
  );
  await editMessageReplyMarkup(adminChatId, messageId, null, env);
  await answerCallbackQuery(callbackQueryId, 'Размещено ✅', env);
  await logAction(listing.tg_id, 'approve', listingId, env.DB);
}

async function rejectListing(
  listingId: string,
  adminChatId: number | string,
  messageId: number,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  const listing = await env.DB.prepare(
    'SELECT tg_id, payment_status FROM listings WHERE listing_id = ?',
  )
    .bind(listingId)
    .first<{ tg_id: number; payment_status: string }>();

  if (!listing) {
    await answerCallbackQuery(callbackQueryId, 'Анкета не найдена', env);
    return;
  }

  await env.DB.prepare(
    `UPDATE listings SET status = 'rejected' WHERE listing_id = ?`,
  )
    .bind(listingId)
    .run();

  const rejectText =
    listing.payment_status === 'paid'
      ? '❌ Размещение отклонено.\nАдминистратор свяжется с вами в течение 24 часов для возврата средств.'
      : '❌ Размещение отклонено.\nАдминистратор свяжется с вами в течение 24 часов.';

  await sendMessage(listing.tg_id, rejectText, null, env);
  await editMessageReplyMarkup(adminChatId, messageId, null, env);
  await answerCallbackQuery(callbackQueryId, 'Отклонено ❌', env);
  await logAction(listing.tg_id, 'reject', listingId, env.DB);
}

async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
  env: Env,
): Promise<void> {
  const config = getConfig(env);
  const fromId = callbackQuery.from.id;
  const data = callbackQuery.data || '';

  if (data === 'contact_admin') {
    await startContactAdmin(fromId, env);
    await answerCallbackQuery(callbackQuery.id, 'Напишите сообщение в чат', env);
    return;
  }

  if (fromId !== config.adminTgId) {
    await answerCallbackQuery(callbackQuery.id, 'Нет доступа', env);
    return;
  }

  const chatId = callbackQuery.message?.chat.id;
  const messageId = callbackQuery.message?.message_id;
  if (chatId == null || messageId == null) {
    await answerCallbackQuery(callbackQuery.id, 'Ошибка сообщения', env);
    return;
  }

  if (data.startsWith('approve_')) {
    const listingId = data.substring('approve_'.length);
    await approveListing(listingId, chatId, messageId, callbackQuery.id, env);
    return;
  }

  if (data.startsWith('reject_')) {
    const listingId = data.substring('reject_'.length);
    await rejectListing(listingId, chatId, messageId, callbackQuery.id, env);
    return;
  }

  if (data.startsWith('pin_approve_')) {
    const parts = data.substring('pin_approve_'.length);
    const lastUnderscore = parts.lastIndexOf('_');
    const listingId = parts.substring(0, lastUnderscore);
    const pinDuration = parts.substring(lastUnderscore + 1);
    await pinApproveListing(
      listingId,
      pinDuration,
      chatId,
      messageId,
      callbackQuery.id,
      env,
    );
    return;
  }

  if (data.startsWith('pin_reject_')) {
    const listingId = data.substring('pin_reject_'.length);
    await pinRejectListing(listingId, chatId, messageId, callbackQuery.id, env);
    return;
  }

  await answerCallbackQuery(callbackQuery.id, undefined, env);
}

async function notifyAdminDebug(text: string, env: Env): Promise<void> {
  const adminId = env.ADMIN_TG_ID;
  if (!adminId) {
    return;
  }
  await sendMessage(adminId, String(text).substring(0, 4000), null, env);
}

export async function handleTelegramUpdate(
  update: Record<string, unknown>,
  env: Env,
): Promise<void> {
  try {
    const callbackQuery = update.callback_query as TelegramCallbackQuery | undefined;
    if (callbackQuery) {
      await handleCallbackQuery(callbackQuery, env);
      return;
    }

    const message = update.message as TelegramMessage | undefined;
    if (!message) {
      return;
    }

    const config = getConfig(env);
    const fromId = message.from?.id;
    if (fromId == null) {
      return;
    }

    if (fromId === config.adminTgId && message.reply_to_message) {
      if (await handleAdminReply(message, env)) {
        return;
      }
    }

    if (message.photo?.length) {
      if (await handleAdminQrPhoto(message, env)) {
        return;
      }
      if (await handleUserContactMessage(message, env)) {
        return;
      }
      if (await handlePaymentProofPhoto(message, env)) {
        return;
      }
      if (fromId === config.adminTgId) {
        await sendQrSetupHint(config.adminTgId, env);
      }
      return;
    }

    if (message.text) {
      if (fromId === config.adminTgId && (await handleAdminTextCommand(message, env))) {
        return;
      }
      await handleUserTextMessage(message, env);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logAction(0, 'error', `handleTelegramUpdate: ${msg}`, env.DB);
    await notifyAdminDebug(`⚠️ handleTelegramUpdate: ${msg}`, env);
  }
}
