import {
  DEFAULT_AVATAR_EMOJI,
  QR_PAYMENT_METHODS,
  type AppConfig,
  type QrPaymentMethod,
  getConfig,
  getConfigWithSettings,
} from '../config';
import type { Env } from '../env';
import { purgeFavoritesForListing } from './favorites';
import {
  approveListingModeration,
  rejectListingModeration,
} from '../services/listing-moderation';
import {
  cleanupPortfolioOnReject,
  deleteMediaByListing,
  getPortfolioCount,
  promoteStaging,
} from '../services/portfolio-db';
import type { AdminLink } from '../types';
import {
  invalidateAppSettingsCache,
  qrSettingKey,
  upsertAppSetting,
} from '../services/app-settings';
import {
  answerCallbackQuery,
  banConfirmKeyboard,
  contactBanKeyboard,
  editMessageReplyMarkup,
  editMessageText,
  moderationKeyboard,
  pinModerationKeyboard,
  sendMessage,
  sendModerationPhotoToAdmins,
  sendModerationToAdmins,
  sendPhoto,
  sendToAllAdmins,
  type ReplyKeyboardMarkup,
} from '../services/telegram-api';
import {
  canBanTarget,
  getAdminRole,
  isAdmin,
  isGrandAdmin,
} from '../utils/admin-auth';
import { decodeDescriptionNewlines } from '../utils/description';
import {
  formatKeywordsModerationLine,
  parseKeywordsJson,
  serializeKeywords,
} from '../utils/keywords';
import {
  banUser,
  ensureUser,
  formatDateRu,
  getPinDurationLabel,
  getPinPriceByDuration,
  isStaffTgId,
  isUserBanned,
  logAction,
  paymentMethodLabel,
} from '../utils/helpers';
import {
  appendLaunchTokenToUrl,
  createMiniAppLaunchToken,
} from '../utils/miniapp-launch-token';
import { ensureTelegramListingContact } from '../utils/telegram-listing-verify';
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

/** Текст кнопки reply-клавиатуры (нажатие приходит как message.text). */
const CONTACT_ADMIN_BUTTON = '📩 Написать администратору';
const GRAND_ADMIN_ONLY_MESSAGE =
  'Доступно только главному администратору.';

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
  keywords?: string[];
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
    `Контакты: ${data.contacts}\n` +
    `${formatKeywordsModerationLine(data.keywords ?? [])}`;

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
    `SELECT tg_id, display_name, category, description, experience, contact_type, contacts, payment_status, keywords
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
      keywords: string;
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
    keywords: parseKeywordsJson(row.keywords),
  };
}

/** Постоянное меню у поля ввода: Mini App и «Написать администратору». */
function mainMenuReplyKeyboard(
  config: AppConfig,
  launchToken: string | null,
): ReplyKeyboardMarkup {
  const rows: ReplyKeyboardMarkup['keyboard'] = [];
  if (isValidMiniAppUrl(config.miniAppUrl)) {
    const catalogUrl = launchToken
      ? appendLaunchTokenToUrl(getMiniAppCatalogUrl(config.miniAppUrl), launchToken)
      : getMiniAppCatalogUrl(config.miniAppUrl);
    const rulesUrl = launchToken
      ? appendLaunchTokenToUrl(getMiniAppRulesUrl(config.miniAppUrl), launchToken)
      : getMiniAppRulesUrl(config.miniAppUrl);
    rows.push([
      {
        text: '🎩 Добро пожаловать!',
        web_app: { url: catalogUrl },
      },
      {
        text: '📋 Правила',
        web_app: { url: rulesUrl },
      },
    ]);
  }
  rows.push([{ text: CONTACT_ADMIN_BUTTON }]);
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

function mainMenuReplyKeyboardWithoutContact(): ReplyKeyboardMarkup {
  return {
    keyboard: [],
    resize_keyboard: true,
    is_persistent: true,
    one_time_keyboard: false,
  };
}

async function mainMenuReplyKeyboardForUser(
  tgId: number,
  env: Env,
): Promise<ReplyKeyboardMarkup> {
  const config = getConfig(env);
  const launchToken = await createMiniAppLaunchToken(tgId, env);
  return mainMenuReplyKeyboard(config, launchToken);
}

async function sendWelcome(
  chatId: number | string,
  tgId: number,
  env: Env,
): Promise<void> {
  const config = getConfig(env);
  const text =
    '👋 Добро пожаловать в Место Встречи — Нячанг!\n\n' +
    'Здесь профессионалы, фрилансеры и мастера находят друг друга.\n\n' +
    '🔍 Ищете специалиста? Нажмите «Добро пожаловать!» в меню внизу у поля ввода.\n\n' +
    '📋 Хотите разместить мини-резюме? Откройте каталог и заполните короткую анкету — одно размещение бесплатно.';
  const launchToken = await createMiniAppLaunchToken(tgId, env);
  const replyKb = mainMenuReplyKeyboard(config, launchToken);
  const msgId = await sendMessage(chatId, text, replyKb, env);
  if (!msgId) {
    await sendMessage(
      chatId,
      `${text}\n\n(Меню без кнопок — проверьте MINI_APP_URL в wrangler.toml: нужен URL GitHub Pages с catalog.html.)`,
      null,
      env,
    );
  }
}

async function startContactAdmin(tgId: number, env: Env): Promise<void> {
  if (await isUserBanned(tgId, env.DB)) {
    await sendMessage(
      tgId,
      '🚫 Ваш телеграм-аккаунт забанен. Обращение к администратору недоступно.',
      mainMenuReplyKeyboardWithoutContact(),
      env,
    );
    return;
  }

  await upsertSession(tgId, 'contact_admin', '', env);
  await sendMessage(
    tgId,
    '✉️ Напишите администратору одним сообщением (текст или фото).\n\n' +
      'Для отмены отправьте /start',
    await mainMenuReplyKeyboardForUser(tgId, env),
    env,
  );
}

async function buildQrStatusText(env: Env): Promise<string> {
  const config = await getConfigWithSettings(env);
  const lines = ['📷 Статус QR-кодов:', ''];
  QR_PAYMENT_METHODS.forEach((m) => {
    const id = config.qr[m.methodKey];
    lines.push(m.sendCaption);
    lines.push(`  ${m.methodKey}: ${id ? id : '❌ не задан'}`);
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
    'Фото сохраняется в настройках (D1). Команда /qr_status — проверить file_id.',
  ];
  await sendMessage(adminChatId, lines.join('\n'), null, env);
}

async function handleAdminTextCommand(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const fromId = message.from?.id;
  if (fromId == null) {
    return false;
  }

  const command = getMessageCommand(message);
  const chatId = message.chat.id;

  if (command === '/qr_status' || command === '/qr' || command === '/qr_help') {
    if (!(await isGrandAdmin(env.DB, fromId))) {
      if (await isAdmin(env.DB, fromId)) {
        await sendMessage(chatId, GRAND_ADMIN_ONLY_MESSAGE, null, env);
        return true;
      }
      return false;
    }
    if (command === '/qr_help') {
      await sendQrSetupHint(chatId, env);
    } else {
      await sendMessage(chatId, await buildQrStatusText(env), null, env);
    }
    return true;
  }

  if (command === '/admin') {
    if (!(await isAdmin(env.DB, fromId))) {
      return false;
    }
    const menuText = (await isGrandAdmin(env.DB, fromId))
      ? '🛠 Команды администратора:\n/qr_help — подписи для QR\n/qr_status — проверка file_id\n/admin — это меню'
      : '🛠 Модерация анкет — в сообщениях бота с кнопками.\nРазбан и настройки — в Mini App → «Админ».';
    await sendMessage(chatId, menuText, null, env);
    return true;
  }

  return false;
}

async function handleAdminQrPhoto(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const fromId = message.from?.id;
  if (fromId == null) {
    return false;
  }

  if (!(await isAdmin(env.DB, fromId))) {
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

  const chatId = message.chat.id;

  if (!(await isGrandAdmin(env.DB, fromId))) {
    await sendMessage(chatId, GRAND_ADMIN_ONLY_MESSAGE, null, env);
    return true;
  }

  const fileId = photos[photos.length - 1].file_id;
  const key = qrSettingKey(method.methodKey);
  await upsertAppSetting(env.DB, key, fileId, fromId);
  await invalidateAppSettingsCache(env);
  await sendMessage(
    chatId,
    `✅ QR сохранён (${method.sendCaption}).\nКлюч: ${key}\nfile_id: ${fileId}`,
    null,
    env,
  );
  await logAction(fromId, 'admin_qr_upload_bot', method.methodKey, env.DB);
  return true;
}

async function forwardContactToAdmin(
  message: TelegramMessage,
  env: Env,
): Promise<void> {
  const user = message.from;
  if (!user) {
    return;
  }

  const tgId = user.id;
  if (await isUserBanned(tgId, env.DB)) {
    await clearSession(tgId, env);
    await sendMessage(
      tgId,
      '🚫 Ваш телеграм-аккаунт забанен. Сообщение администратору не отправлено.',
      mainMenuReplyKeyboardWithoutContact(),
      env,
    );
    return;
  }

  const header =
    '✉️ ОБРАЩЕНИЕ ПОЛЬЗОВАТЕЛЯ\n' +
    `${formatUserRef(user)}\n\n` +
    '↩️ Ответьте на это сообщение (Reply), чтобы ответ ушёл пользователю.';
  const banKeyboard = contactBanKeyboard(tgId);

  if (message.photo?.length) {
    const fileId = message.photo[message.photo.length - 1].file_id;
    const userCaption = message.caption ? `\n\nТекст: ${message.caption}` : '';
    const adminMsgIds = await sendModerationPhotoToAdmins(
      env.DB,
      env,
      fileId,
      header + userCaption,
      banKeyboard,
    );
    for (let i = 0; i < adminMsgIds.length; i++) {
      await saveAdminLink(adminMsgIds[i], tgId, 'contact', '', env);
    }
  } else {
    const body = message.text || message.caption || '(пустое сообщение)';
    const adminMsgIds = await sendModerationToAdmins(
      env.DB,
      env,
      `${header}\n\n${body}`,
      banKeyboard,
    );
    for (let i = 0; i < adminMsgIds.length; i++) {
      await saveAdminLink(adminMsgIds[i], tgId, 'contact', '', env);
    }
  }

  await clearSession(tgId, env);
  await sendMessage(
    tgId,
    '✅ Сообщение отправлено администратору.\n\n' +
      'Администратор рассмотрит его в течение 24 часов. Ответ придёт в этот чат.',
    await mainMenuReplyKeyboardForUser(tgId, env),
    env,
  );
  await logAction(tgId, 'contact_admin', '', env.DB);
}

async function handleAdminReply(
  message: TelegramMessage,
  env: Env,
): Promise<boolean> {
  const fromId = message.from?.id;
  if (fromId == null || !(await isAdmin(env.DB, fromId))) {
    return false;
  }

  const repliedToId = message.reply_to_message?.message_id;
  if (!repliedToId) {
    return false;
  }

  const link = await findAdminLink(repliedToId, env);
  if (!link) {
    if (message.reply_to_message?.from?.is_bot) {
      await sendMessage(
        fromId,
        '⚠️ Не удалось связать ответ с пользователем. Ответьте через Reply на сообщение бота с анкетой или чеком.',
        null,
        env,
      );
      return true;
    }
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
      fromId,
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
    return true;
  }

  await sendMessage(
    fromId,
    '⚠️ Отправьте текст или фото — другие типы сообщений пользователю не пересылаются.',
    null,
    env,
  );
  return true;
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

  const config = await getConfigWithSettings(env);
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
    '↩️ Ответьте на это сообщение (Reply), чтобы ответ ушёл пользователю.';

  const adminMsgIds = await sendModerationPhotoToAdmins(
    env.DB,
    env,
    fileId,
    caption,
    pinModerationKeyboard(listingId, pinDuration),
  );
  for (let i = 0; i < adminMsgIds.length; i++) {
    await saveAdminLink(adminMsgIds[i], tgId, 'pin_proof', listingId, env);
  }

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
  telegramVerify: {
    telegram_username_verified: string | null;
    telegram_verified_at: string | null;
  },
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
      submitted_at, avatar_emoji, pin_status, keywords,
      telegram_username_verified, telegram_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'on_moderation', 'paid', NULL, NULL, ?, ?, 'regular', ?, ?, ?)`,
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
      serializeKeywords(draft.keywords ?? []),
      telegramVerify.telegram_username_verified,
      telegramVerify.telegram_verified_at,
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

  const fileId = message.photo[message.photo.length - 1].file_id;
  const userRef = formatUserRef(user);

  if (draft.type === 'paid_listing') {
    const listingId = draft.listing_id;
    const tgVerify = await ensureTelegramListingContact(
      env,
      tgId,
      String(draft.contact_type || ''),
      String(draft.contacts || ''),
    );
    if (!tgVerify.ok) {
      await sendMessage(tgId, tgVerify.message, null, env);
      return true;
    }
    await insertPaidListing(draft, tgId, user, env, tgVerify);
    await promoteStaging(tgId, listingId, env);
    const portfolioCount = await getPortfolioCount(listingId, env.DB, {
      includePending: true,
    });

    const listingAdminMsgIds = await sendModerationToAdmins(
      env.DB,
      env,
      formatListingAdminText(listingId, tgId, draft, 'paid', userRef),
      null,
    );
    for (let i = 0; i < listingAdminMsgIds.length; i++) {
      await saveAdminLink(listingAdminMsgIds[i], tgId, 'payment_proof', listingId, env);
    }

    const photoCaption =
      '💳 ЧЕК ОПЛАТЫ\n' +
      `${userRef}\n\n` +
      `Анкета: ${listingId}\n` +
      `Способ: ${paymentMethodLabel(draft.payment_method)}\n\n` +
      '↩️ Ответьте на это сообщение (Reply), чтобы ответ ушёл пользователю.';

    const adminMsgIds = await sendModerationPhotoToAdmins(
      env.DB,
      env,
      fileId,
      photoCaption,
      await moderationKeyboard(listingId, portfolioCount, tgId, env),
    );
    for (let i = 0; i < adminMsgIds.length; i++) {
      await saveAdminLink(adminMsgIds[i], tgId, 'payment_proof', listingId, env);
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
  const portfolioCount = await getPortfolioCount(listingId, env.DB, {
    includePending: true,
  });
  if (listingData) {
    const listingAdminMsgIds = await sendModerationToAdmins(
      env.DB,
      env,
      formatListingAdminText(
        listingId,
        listingData.tg_id,
        listingData,
        listingData.payment_status,
        userRef,
      ),
      null,
    );
    for (let i = 0; i < listingAdminMsgIds.length; i++) {
      await saveAdminLink(listingAdminMsgIds[i], tgId, 'payment_proof', listingId, env);
    }
  }

  const caption =
    '💳 ЧЕК ОПЛАТЫ\n' +
    `${userRef}\n\n` +
    `Анкета: ${listingId}\n\n` +
    '↩️ Кнопки — разместить/отклонить. Reply — ответ пользователю.';
  const adminMsgIds = await sendModerationPhotoToAdmins(
    env.DB,
    env,
    fileId,
    caption,
    await moderationKeyboard(listingId, portfolioCount, tgId, env),
  );
  for (let i = 0; i < adminMsgIds.length; i++) {
    await saveAdminLink(adminMsgIds[i], tgId, 'payment_proof', listingId, env);
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

  if (await isAdmin(env.DB, user.id)) {
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
    await sendWelcome(chatId, tgId, env);
    return true;
  }

  const text = message.text?.trim() ?? '';
  if (text === CONTACT_ADMIN_BUTTON) {
    await startContactAdmin(tgId, env);
    return true;
  }

  const session = await getSession(tgId, env);
  if (session?.state === 'contact_admin') {
    await forwardContactToAdmin(message, env);
    return true;
  }

  if (command) {
    await sendWelcome(chatId, tgId, env);
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
  const result = await approveListingModeration(listingId, env);
  if (!result.ok) {
    const hint =
      result.error === 'not_found'
        ? 'Анкета не найдена'
        : result.error === 'invalid_status'
          ? 'Анкета недоступна для размещения'
          : 'Ошибка';
    await answerCallbackQuery(callbackQueryId, hint, env);
    return;
  }

  await editMessageReplyMarkup(adminChatId, messageId, null, env);
  const toast =
    result.kind === 'approved_edit' ? 'Правки опубликованы ✅' : 'Размещено ✅';
  await answerCallbackQuery(callbackQueryId, toast, env);
}

async function rejectListing(
  listingId: string,
  adminChatId: number | string,
  messageId: number,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  const result = await rejectListingModeration(listingId, env);
  if (!result.ok) {
    const hint =
      result.error === 'not_found'
        ? 'Анкета не найдена'
        : result.error === 'invalid_status'
          ? 'Анкета недоступна для отклонения'
          : 'Ошибка';
    await answerCallbackQuery(callbackQueryId, hint, env);
    return;
  }

  await editMessageReplyMarkup(adminChatId, messageId, null, env);
  const toast =
    result.kind === 'rejected_edit' ? 'Правки отклонены ❌' : 'Отклонено ❌';
  await answerCallbackQuery(callbackQueryId, toast, env);
}

async function banUserByAdmin(
  userTgId: number,
  bannedBy: number,
  adminChatId: number | string,
  sourceMessageId: number,
  confirmMessageId: number | null,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  const banCheck = await canBanTarget(bannedBy, userTgId, env.DB);
  if (!banCheck.ok) {
    await answerCallbackQuery(callbackQueryId, banCheck.message ?? 'Нельзя забанить', env);
    return;
  }

  await banUser(userTgId, '', '', bannedBy, env);
  await clearSession(userTgId, env);

  await sendMessage(userTgId, '🚫 Ваш телеграм-аккаунт забанен.', null, env);
  await editMessageReplyMarkup(adminChatId, sourceMessageId, null, env);
  if (confirmMessageId != null) {
    await editMessageText(
      adminChatId,
      confirmMessageId,
      '🚫 Пользователь забанен.',
      null,
      env,
    );
  }
  await answerCallbackQuery(callbackQueryId, 'Пользователь забанен 🚫', env);
  await logAction(userTgId, 'ban', '', env.DB);
  await sendToAllAdmins(
    env.DB,
    env,
    `🚫 Пользователь ${userTgId} забанен.`,
  );
}

async function askBanUserConfirmation(
  userTgId: number,
  adminChatId: number | string,
  sourceMessageId: number,
  callbackQueryId: string,
  env: Env,
  bannerTgId: number,
): Promise<void> {
  const banCheck = await canBanTarget(bannerTgId, userTgId, env.DB);
  if (!banCheck.ok) {
    await answerCallbackQuery(callbackQueryId, banCheck.message ?? 'Нельзя забанить', env);
    return;
  }

  await sendMessage(
    adminChatId,
    'Вы уверены, что хотите забанить пользователя?',
    banConfirmKeyboard(userTgId, sourceMessageId),
    env,
  );
  await answerCallbackQuery(callbackQueryId, undefined, env);
}

async function cancelBanUserConfirmation(
  adminChatId: number | string,
  confirmMessageId: number,
  callbackQueryId: string,
  env: Env,
): Promise<void> {
  await editMessageText(
    adminChatId,
    confirmMessageId,
    'Отменено.',
    null,
    env,
  );
  await answerCallbackQuery(callbackQueryId, 'Отменено', env);
}

async function handleBannedUserInteraction(
  update: Record<string, unknown>,
  env: Env,
): Promise<boolean> {
  const callbackQuery = update.callback_query as TelegramCallbackQuery | undefined;
  if (callbackQuery) {
    const fromId = callbackQuery.from.id;
    if (await isAdmin(env.DB, fromId)) {
      return false;
    }
    if (!(await isUserBanned(fromId, env.DB))) {
      return false;
    }

    const hint = 'Аккаунт забанен';
    if (callbackQuery.data === 'contact_admin') {
      await answerCallbackQuery(callbackQuery.id, hint, env);
      await sendMessage(fromId, '🚫 Ваш телеграм-аккаунт забанен.', null, env);
      return true;
    }

    await answerCallbackQuery(callbackQuery.id, hint, env);
    return true;
  }

  const message = update.message as TelegramMessage | undefined;
  if (!message?.from) {
    return false;
  }

  const fromId = message.from.id;
  if (await isAdmin(env.DB, fromId)) {
    return false;
  }
  if (!(await isUserBanned(fromId, env.DB))) {
    return false;
  }

  await clearSession(fromId, env);
  const command = getMessageCommand(message);
  const text = message.text?.trim() ?? '';

  if (command === '/start') {
    await sendMessage(fromId, '🚫 Ваш телеграм-аккаунт забанен.', null, env);
    return true;
  }

  if (text === CONTACT_ADMIN_BUTTON) {
    await sendMessage(
      fromId,
      '🚫 Ваш телеграм-аккаунт забанен. Обращение к администратору недоступно.',
      null,
      env,
    );
    return true;
  }

  await sendMessage(fromId, '🚫 Ваш телеграм-аккаунт забанен.', null, env);
  return true;
}

async function handleCallbackQuery(
  callbackQuery: TelegramCallbackQuery,
  env: Env,
): Promise<void> {
  const fromId = callbackQuery.from.id;
  const data = callbackQuery.data || '';

  if (data === 'contact_admin') {
    await startContactAdmin(fromId, env);
    await answerCallbackQuery(callbackQuery.id, 'Напишите сообщение в чат', env);
    return;
  }

  if (!(await isAdmin(env.DB, fromId))) {
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

  if (data.startsWith('ban_user_')) {
    const userTgId = Number(data.substring('ban_user_'.length));
    if (!userTgId) {
      await answerCallbackQuery(callbackQuery.id, 'Некорректный ID', env);
      return;
    }
    await askBanUserConfirmation(
      userTgId,
      chatId,
      messageId,
      callbackQuery.id,
      env,
      fromId,
    );
    return;
  }

  if (data.startsWith('ban_ok_')) {
    const parts = data.substring('ban_ok_'.length);
    const lastUnderscore = parts.lastIndexOf('_');
    const userTgId = Number(parts.substring(0, lastUnderscore));
    const sourceMessageId = Number(parts.substring(lastUnderscore + 1));
    if (!userTgId || !sourceMessageId) {
      await answerCallbackQuery(callbackQuery.id, 'Некорректные данные', env);
      return;
    }
    await banUserByAdmin(
      userTgId,
      fromId,
      chatId,
      sourceMessageId,
      messageId,
      callbackQuery.id,
      env,
    );
    return;
  }

  if (data.startsWith('ban_no_')) {
    await cancelBanUserConfirmation(chatId, messageId, callbackQuery.id, env);
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
    if (await handleBannedUserInteraction(update, env)) {
      return;
    }

    const callbackQuery = update.callback_query as TelegramCallbackQuery | undefined;
    if (callbackQuery) {
      await handleCallbackQuery(callbackQuery, env);
      return;
    }

    const message = update.message as TelegramMessage | undefined;
    if (!message) {
      return;
    }

    const fromId = message.from?.id;
    if (fromId == null) {
      return;
    }

    if (message.reply_to_message && (await isAdmin(env.DB, fromId))) {
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
      if (await isGrandAdmin(env.DB, fromId)) {
        await sendQrSetupHint(fromId, env);
      } else if (await isAdmin(env.DB, fromId)) {
        await sendMessage(fromId, GRAND_ADMIN_ONLY_MESSAGE, null, env);
      }
      return;
    }

    if (message.text) {
      if (await handleAdminTextCommand(message, env)) {
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
