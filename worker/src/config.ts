import type { Env } from './env';
import { loadAppSettings, qrSettingKey } from './services/app-settings';

export const CATEGORIES = [
  'IT и разработка',
  'Дизайн и креатив',
  'Маркетинг и SMM',
  'Бизнес и финансы',
  'Юридические услуги',
  'Медицина и здоровье',
  'Красота и уход',
  'Образование и репетиторство',
  'Строительство и ремонт',
  'Транспорт аренда и ремонт',
  'Спорт и фитнес',
  'Хобби и творчество',
  'Туризм и экскурсии',
  'Бытовые услуги и уборка',
  'Кулинария и кейтеринг',
  'Фото, видео и контент',
  'Семья и дети (няни и воспитатели)',
  'Другое',
] as const;

export const STOP_WORDS = [
  'секс', 'эскорт', 'порно', 'интим', 'наркотики', 'вещества', 'закладки',
  'оружие', 'казино', 'ставки', 'вулкан', 'скам', 'развод', 'схема',
  'заработок', 'пассивный', 'доход',
  'вакансия', 'требуется сотрудник', 'ищем в команду', 'открыта позиция',
  'нужен специалист', 'работодатель', 'нанимаем',
  'продам', 'продаю', 'продажа', 'отдам',
];

export const AVATAR_EMOJIS = [
  '🖥️', '🎨', '📣', '💼', '⚖️', '🩺', '💄', '📚', '🔨', '🚗', '🏋️', '🎭',
  '🌴', '🏠', '👨‍🍳', '📸', '👨‍👩‍👧', '🔹', '👦', '👩', '👨‍🎓', '👨‍💻', '💃',
  '🏃‍♂️', '🧎‍♂️', '🛵', '✈', '🚢', '🔥', '🥇', '🍝', '😎', '✨',
];

export const DEFAULT_AVATAR_EMOJI = '👨‍🎓';

export const CONTACT_TYPES = ['Telegram', 'Whatsapp', 'Email'] as const;

export interface QrPaymentMethod {
  methodKey: string;
  propertyKey: keyof Pick<
    Env,
    | 'QR_VND_FILE_ID'
    | 'QR_USDT_TRC20_FILE_ID'
    | 'QR_USDT_BYBIT_FILE_ID'
    | 'QR_USDT_SOLANA_FILE_ID'
  >;
  captions: string[];
  sendCaption: string;
}

export const QR_PAYMENT_METHODS: QrPaymentMethod[] = [
  {
    methodKey: 'vnd',
    propertyKey: 'QR_VND_FILE_ID',
    captions: ['qr_vnd', 'vnd'],
    sendCaption: '🇻🇳 Оплата VND (банк / QR)',
  },
  {
    methodKey: 'trc20',
    propertyKey: 'QR_USDT_TRC20_FILE_ID',
    captions: ['qr_trc20', 'usdt_trc20', 'trc20'],
    sendCaption: '💎 USDT — сеть TRC20',
  },
  {
    methodKey: 'bybit',
    propertyKey: 'QR_USDT_BYBIT_FILE_ID',
    captions: ['qr_bybit', 'usdt_bybit', 'bybit'],
    sendCaption: '💎 USDT — Bybit',
  },
  {
    methodKey: 'solana',
    propertyKey: 'QR_USDT_SOLANA_FILE_ID',
    captions: ['qr_solana', 'usdt_solana', 'solana'],
    sendCaption: '💎 USDT — Solana',
  },
];

export interface AppConfig {
  botToken: string;
  adminTgId: number;
  webappSecret: string;
  paymentAmountVnd: string;
  paymentAmountCrypto: string;
  pinPriceWeekVnd: string;
  pinPriceWeekCrypto: string;
  pinPriceMonthVnd: string;
  pinPriceMonthCrypto: string;
  pinPriceLifetimeVnd: string;
  pinPriceLifetimeCrypto: string;
  miniAppUrl: string;
  qr: Record<string, string | undefined>;
}

export function getConfig(env: Env): AppConfig {
  const qr: Record<string, string | undefined> = {};
  for (const method of QR_PAYMENT_METHODS) {
    qr[method.methodKey] = env[method.propertyKey];
  }

  return {
    botToken: env.BOT_TOKEN,
    adminTgId: Number(env.ADMIN_TG_ID),
    webappSecret: env.WEBAPP_SECRET,
    paymentAmountVnd:
      env.PAYMENT_AMOUNT_VND ||
      env.PAYMENT_AMOUNT ||
      '200 000 VND',
    paymentAmountCrypto: env.PAYMENT_AMOUNT_CRYPTO || '8 USDT',
    pinPriceWeekVnd: env.PIN_PRICE_WEEK_VND || '500 000 VND',
    pinPriceWeekCrypto: env.PIN_PRICE_WEEK_CRYPTO || '20 USDT',
    pinPriceMonthVnd: env.PIN_PRICE_MONTH_VND || '1 500 000 VND',
    pinPriceMonthCrypto: env.PIN_PRICE_MONTH_CRYPTO || '60 USDT',
    pinPriceLifetimeVnd: env.PIN_PRICE_LIFETIME_VND || '5 000 000 VND',
    pinPriceLifetimeCrypto: env.PIN_PRICE_LIFETIME_CRYPTO || '200 USDT',
    miniAppUrl: env.MINI_APP_URL,
    qr,
  };
}

const D1_PRICE_KEYS: Array<{
  d1Key: string;
  configKey: keyof Pick<
    AppConfig,
    | 'paymentAmountVnd'
    | 'paymentAmountCrypto'
    | 'pinPriceWeekVnd'
    | 'pinPriceWeekCrypto'
    | 'pinPriceMonthVnd'
    | 'pinPriceMonthCrypto'
    | 'pinPriceLifetimeVnd'
    | 'pinPriceLifetimeCrypto'
  >;
}> = [
  { d1Key: 'payment_amount_vnd', configKey: 'paymentAmountVnd' },
  { d1Key: 'payment_amount_crypto', configKey: 'paymentAmountCrypto' },
  { d1Key: 'pin_price_week_vnd', configKey: 'pinPriceWeekVnd' },
  { d1Key: 'pin_price_week_crypto', configKey: 'pinPriceWeekCrypto' },
  { d1Key: 'pin_price_month_vnd', configKey: 'pinPriceMonthVnd' },
  { d1Key: 'pin_price_month_crypto', configKey: 'pinPriceMonthCrypto' },
  { d1Key: 'pin_price_lifetime_vnd', configKey: 'pinPriceLifetimeVnd' },
  { d1Key: 'pin_price_lifetime_crypto', configKey: 'pinPriceLifetimeCrypto' },
];

/** D1 app_settings (cached) merged over env defaults; QR by methodKey. */
export async function getConfigWithSettings(env: Env): Promise<AppConfig> {
  const config = getConfig(env);
  const stored = await loadAppSettings(env);

  for (let i = 0; i < D1_PRICE_KEYS.length; i++) {
    const { d1Key, configKey } = D1_PRICE_KEYS[i];
    const value = stored.get(d1Key);
    if (value != null && value !== '') {
      config[configKey] = value;
    }
  }

  const qr: Record<string, string | undefined> = {};
  for (let i = 0; i < QR_PAYMENT_METHODS.length; i++) {
    const method = QR_PAYMENT_METHODS[i];
    const d1Id = stored.get(qrSettingKey(method.methodKey));
    qr[method.methodKey] = d1Id || env[method.propertyKey];
  }
  config.qr = qr;

  return config;
}
