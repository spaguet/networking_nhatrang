import type { Env } from './env';

export const CATEGORIES = [
  'IT и разработка',
  'Дизайн и creative',
  'Маркетинг и SMM',
  'Бизнес и финансы',
  'Юриспруденция',
  'Медицина и здоровье',
  'Красота и уход',
  'Туризм и экскурсии',
  'Образование и репетиторство',
  'Строительство и ремонт',
  'Транспорт и логистика',
  'Другое',
] as const;

export const STOP_WORDS = [
  'секс', 'эскорт', 'порно', 'интим', 'наркотики', 'вещества', 'закладки',
  'оружие', 'казино', 'ставки', 'вулкан', 'скам', 'развод', 'схема',
  'заработок 100к', 'заработок 200к', 'пассивный доход без вложений',
  'вакансия', 'требуется сотрудник', 'ищем в команду', 'открыта позиция',
  'нужен специалист', 'работодатель', 'нанимаем',
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
    qr[method.propertyKey] = env[method.propertyKey];
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
