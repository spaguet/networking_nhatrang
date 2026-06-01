-- Telegram @username verification on listing submit (user_messaging_TZ.md §6.4.5)

ALTER TABLE listings ADD COLUMN telegram_username_verified TEXT;
ALTER TABLE listings ADD COLUMN telegram_verified_at TEXT;
