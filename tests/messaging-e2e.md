# E2E: Сообщения между пользователями (`user_messaging_TZ.md` v1.5 §11)

> **Стек:** Worker `tg-networking-nhatrang` · D1 `011`–`012` · `catalog.html` · бот  
> **Деплой:** `DEPLOY_GUIDE_CF.md` §D2f  
> **Авто-smoke API:** `worker/scripts/messaging-api-smoke.ps1` · `npm run test:messaging`

Перед прогоном:

- [ ] Миграции `011_messaging.sql`, `012_telegram_contact_verify.sql` на remote D1
- [ ] `wrangler deploy` (handlers `messaging.ts`, `admin.ts`, `maintenance.ts`)
- [ ] Push `catalog.html` (кнопки «Мои сообщения», чат, жалобы, verify Telegram)
- [ ] `BOT_TOKEN` / `WEBAPP_SECRET` совпадают с Worker и `catalog.html`

---

## Автоматические проверки (без полного Telegram UI)

| Проверка | Команда | Ожидание |
|---|---|---|
| Auth regression | `messaging-api-smoke.ps1` | 401 без initData |
| Playwright smoke | `npm run test:messaging` | auth + verify format + unread shape |
| Регрессия каталога | smoke script | `get_listings` → `{ ok: true }` |

**Playwright с интеграцией** (опционально):

```powershell
$env:BOT_TOKEN = "<bot token>"
$env:TEST_MESSAGING_WA_LISTING_ID = "<active Whatsapp listing_id>"
$env:TEST_MESSAGING_TELEGRAM_LISTING_ID = "<active Telegram listing_id>"
$env:TEST_ADMIN_TG_ID = "<admin>"
$env:TEST_ADMIN_PASSWORD = "<password>"
npm run test:messaging
```

---

## Ручной чеклист (§11 T1–T21)

| # | Сценарий | Шаги | Ожидание | ✓ |
|---|---|---|---|---|
| T1 | Telegram карточка | Чужая active, `contact_type=Telegram` | «Написать в Telegram» → t.me / tg:// | ☐ |
| T2 | Telegram форма default | Новая анкета | В select выбран Telegram | ☐ |
| T3 | WA карточка | «Скопировать Whatsapp» + «Написать» | In-app `#screenChat` | ☐ |
| T3b | Email карточка | «Скопировать Email» + «Написать» | In-app чат | ☐ |
| T4 | Первое сообщение | Первый `send_message` в диалоге | `expires_at` ≈ +7 дней от `first_message_at` | ☐ |
| T5 | 8-й день cron | `dailyMaintenance` после TTL | Диалог удалён (нет open жалобы) | ☐ |
| T6 | Непрочитанное на home | Собеседник написал, не открывали чат | Зелёный круг на «💬 Мои сообщения» | ☐ |
| T7 | Открыли чат | `mark_conversation_read` | Круг исчез | ☐ |
| T8 | Жалоба | «Пожаловаться» → отправить | Push админам; строка в таблице | ☐ |
| T9 | Казнить А | Admin → лог → «Казнить контакт А» | `users.banned=1`, guards staff/self | ☐ |
| T10 | Ссылка в чате | `https://…` в теле | `links_forbidden` | ☐ |
| T11 | Своя карточка | Своя active анкета | Нет кнопок сообщений | ☐ |
| T12 | Нет push при msg | Новое in-app сообщение | Бот **не** шлёт уведомление | ☐ |
| T13 | Submit Telegram без verify | Submit без «Проверить» | Ошибка; админам **ничего** | ☐ |
| T14 | Чужой @ник | Verify чужого username | `telegram_username_mismatch` | ☐ |
| T15 | Свой рабочий @ник | Verify + submit | Модерация уходит админам | ☐ |
| T16 | «Пожаловаться» | Шапка чата | Кнопка «Пожаловаться», не «Заблокировать» | ☐ |
| T17 | Казнить | Confirm «Казнить» | Бан + `🚫 Ваш телеграм-аккаунт забанен.` в бот | ☐ |
| T18 | Open жалоба + TTL | `expires_at` прошёл, жалоба `open` | Cron **не** удаляет диалог | ☐ |
| T19 | Пустой диалог 8+ дней | `open_conversation` без сообщений >7d | Удалён cron'ом | ☐ |
| T20 | TTL истёк (до purge) | `open_conversation` / `get_messages` | Read-only, `expired: true`; `send_message` → `conversation_expired` | ☐ |
| T21 | Жалоба после TTL | `expires_at <= now`, диалог ещё в D1 | `submit_message_complaint` OK; push админам | ☐ |

---

## Smoke matrix API

| Action | Условие | Ожидание |
|---|---|---|
| `verify_telegram_contact` | нет initData | 200, `Invalid initData` |
| `verify_telegram_contact` | `contacts: ab` | `invalid_telegram_username` |
| `open_conversation` | Telegram listing | `messaging_not_available` |
| `open_conversation` | `auth === owner` | `forbidden` |
| `send_message` | ссылка в body | `links_forbidden` |
| `send_message` | `expires_at` прошёл | `conversation_expired` |
| `get_messaging_unread` | валидный initData | `has_unread`, `unread_count` |
| `submit_message_complaint` | участник, TTL истёк | `ok: true` (до purge) |
| `admin_list_message_complaints` | admin + token | `complaints[]` |
| `admin_punish_from_complaint` | self-ban target | `forbidden` |

---

## PR / релиз (промпт 8)

1. Вывод `messaging-api-smoke.ps1` и `npm run test:messaging`
2. Отмеченные строки таблицы выше (или «пропущено» с причиной)
3. Version ID Worker после `wrangler deploy`
4. Подтверждение миграций 011–012 на prod D1

*Документ: промпт 8, `user_messaging_TZ.md` v1.5, 01.06.2026.*
