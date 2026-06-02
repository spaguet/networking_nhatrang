export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  PORTFOLIO: R2Bucket;

  MINI_APP_URL: string;

  BOT_TOKEN: string;
  /** Secret for X-Telegram-Bot-Api-Secret-Token (set via wrangler secret; match setWebhook secret_token). */
  TELEGRAM_WEBHOOK_SECRET: string;
  ADMIN_TG_ID: string;
  WEBAPP_SECRET: string;
  /** Server-only HMAC secret for signed /portfolio-media URLs (wrangler secret; not in HTML). */
  MEDIA_SIGNING_SECRET: string;
  /** Server-only HMAC secret for admin portfolio preview tokens (wrangler secret; not in HTML). */
  ADMIN_PORTFOLIO_SECRET: string;

  PAYMENT_AMOUNT_VND?: string;
  /** Legacy fallback (GAS Script Properties key PAYMENT_AMOUNT) */
  PAYMENT_AMOUNT?: string;
  PAYMENT_AMOUNT_CRYPTO?: string;

  PIN_PRICE_WEEK_VND?: string;
  PIN_PRICE_WEEK_CRYPTO?: string;
  PIN_PRICE_MONTH_VND?: string;
  PIN_PRICE_MONTH_CRYPTO?: string;
  PIN_PRICE_LIFETIME_VND?: string;
  PIN_PRICE_LIFETIME_CRYPTO?: string;

  QR_VND_FILE_ID?: string;
  QR_USDT_TRC20_FILE_ID?: string;
  QR_USDT_BYBIT_FILE_ID?: string;
  QR_USDT_SOLANA_FILE_ID?: string;

  /** Set to "true" / "1" / "yes" to log byte-level portfolio/media diagnostics. */
  DEBUG_MEDIA?: string;
}
