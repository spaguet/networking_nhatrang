# Деплой: Нетворкинг Нячанг → Cloudflare Workers + D1

**Канонический гайд деплоя** (единственный актуальный источник для prod). Архив GAS: [`DEPLOY_GUIDE_RU.md`](DEPLOY_GUIDE_RU.md) (deprecated).

### Быстрый ориентир

| Что | Значение / действие |
|---|---|
| **Worker URL (prod)** | `https://tg-networking-nhatrang.albertkoall.workers.dev` |
| **Деплой бэкенда** | `cd worker` → `npx tsc --noEmit` → `npx wrangler deploy` |
| **Mini App** | `catalog.html` на GitHub Pages — после правок **push** в репозиторий |
| **`API_URL`** | В `catalog.html` должен совпадать с URL Worker (см. §Часть C) |
| **`WEBAPP_SECRET`** | Строка в `catalog.html` = `wrangler secret put WEBAPP_SECRET` (маркер POST `/api`, не HMAC) |

Категории каталога — **только** русские labels из `worker/src/config.ts` → `CATEGORIES` (например `"Другое"`, `"IT и разработка"`). Английские slug вроде `services` API **не** принимает.

> **Связанные документы:**
> - `migration_to_cf_d1_TZ.md` — полное ТЗ миграции, API-контракт, промпты
> - `portfolio_TZ.md` — портфолио v1.3 (R2, D1 `listing_media`, multipart upload)
> - `keywords_system_TZ.md` — ключевые слова v1.1 (D1 `listings.keywords`, поиск в каталоге)
> - `favorites_system_TZ.md` — избранное v1.3 (D1 `favorites`, GET/POST API, экран «Избранные»)
> - `admin_profile_TZ.md` — админ-профиль v1.3 (роли grand_admin / admin, Mini App, D1 `admins`)
> - `listing_edit_TZ.md` — редактирование мини-резюме v1.5 (3 правки, `edit_pending`, D1 010)
> - `user_messaging_TZ.md` — сообщения v1.5 (Telegram + in-app, жалобы, D1 011–012)
> - `tests/admin-profile-e2e.md` — E2E чеклист (20 сценариев §8.6)
> - `tests/messaging-e2e.md` — E2E чеклист messaging (T1–T21 §11)
> - `DEPLOY_GUIDE_RU.md` — архивный гайд для GAS + Google Sheets
> - `catalog.html` — Mini App (GitHub Pages), `API_URL` указывает на Worker

**Worker (prod):** `tg-networking-nhatrang`  
**URL:** `https://tg-networking-nhatrang.albertkoall.workers.dev`  
**Mini App:** `https://spaguet.github.io/networking_nhatrang/`

---

## Два URL — не путать

| Переменная | Что это | Где задаётся |
|---|---|---|
| **API_URL** | Бэкенд (Worker): `/api`, webhook `POST /` | `catalog.html` + деплой Worker |
| **MINI_APP_URL** | Каталог в Telegram (GitHub Pages) | `wrangler.toml` `[vars]` |

---

## Часть A. Подготовка (один раз)

### A1. Требования

- Node.js **18+**
- Аккаунт Cloudflare (Free plan достаточен)
- Токен бота (`BOT_TOKEN`), Telegram ID админа (`ADMIN_TG_ID`)
- QR `file_id` из Telegram (см. §7 в `migration_to_cf_d1_TZ.md`)

### A2. Установка и вход

```powershell
cd worker
npm install
npx wrangler login
```

OAuth откроется в браузере — войти в аккаунт CF.

### A3. D1 и KV (если ещё не созданы)

```powershell
npx wrangler d1 create networking_nhatrang
```

Скопировать `database_id` в `worker/wrangler.toml` → `[[d1_databases]]`.

```powershell
npx wrangler kv namespace create CACHE
```

Скопировать `id` в `wrangler.toml` → `[[kv_namespaces]]`.

### A4. Схема БД (remote)

**Новая установка** (пустая D1):

```powershell
npx wrangler d1 execute networking_nhatrang --file=src/db/schema.sql --remote
```

**Уже работающий prod** — применить миграции портфолио (если ещё не применены):

```powershell
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/002_portfolio.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/003_backfill_archived_at.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/004_keywords.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/005_favorites.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/006_banned.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/007_admins_and_settings.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/008_ban_metadata.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/010_listing_edit.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/011_messaging.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/012_telegram_contact_verify.sql
```

Ожидаемые таблицы: `users`, `listings`, `sessions`, `logs`, `likes`, **`favorites`**, `admin_links`, **`listing_media`**, **`admins`**, **`app_settings`**, **`conversations`**, **`messages`**, **`conversation_reads`**, **`message_complaints`**.  
В `listings` — колонки **`archived_at`**, **`keywords`** (JSON-массив, default `'[]'`), **`edits_remaining`**, **`replaces_listing_id`** (после 010), **`telegram_username_verified`**, **`telegram_verified_at`** (после 012).  
Статус **`edit_pending`** — черновик правки (не в каталоге; родитель `active` остаётся видимым до approve).  
В `users` — **`banned`**, **`banned_at`**, **`banned_by`** (после 006–008).

**Миграция 010** (`010_listing_edit.sql`): колонки `edits_remaining` / `replaces_listing_id`, partial UNIQUE «один `edit_pending` на пользователя», backfill `edits_remaining = 3` для всех **active**. Повторный запуск безопасен только если колонки уже есть — иначе `ALTER` упадёт; проверка:

```powershell
npx wrangler d1 execute networking_nhatrang --remote --command "PRAGMA table_info(listings);"
# edits_remaining, replaces_listing_id должны быть в списке
```

**Миграция 011** (`011_messaging.sql`): in-app чат — `conversations`, `messages`, `conversation_reads`, `message_complaints` (без FK на `complaints.conversation_id`).

**Миграция 012** (`012_telegram_contact_verify.sql`): `listings.telegram_username_verified`, `telegram_verified_at`.

Проверка messaging-таблиц:

```powershell
npx wrangler d1 execute networking_nhatrang --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('conversations','message_complaints');"
```

**Seed grand_admin** (после 007, `ADMIN_TG_ID` из секрета Worker):

```powershell
cd worker
$env:ADMIN_TG_ID = "<ваш Telegram ID>"
.\scripts\seed-grand-admin.ps1 -Remote
npx wrangler d1 execute networking_nhatrang --remote --command "SELECT tg_id, role FROM admins;"
```

Альтернатива без скрипта: grand_admin открывает Mini App → `admin_check_access` вызывает `ensureGrandAdmin` (idempotent INSERT при пустой таблице `admins` и `tgId === ADMIN_TG_ID`).

**Local D1** (`wrangler dev`, без `--remote`):

```powershell
cd worker
npx wrangler d1 execute networking_nhatrang --file=src/db/migrations/004_keywords.sql
```

Полная локальная схема с нуля:

```powershell
npx wrangler d1 execute networking_nhatrang --file=src/db/schema.sql
```

### A4a. R2 bucket (портфолио)

```powershell
npx wrangler r2 bucket create networking-portfolio
```

В `wrangler.toml` уже есть binding:

```toml
[[r2_buckets]]
binding = "PORTFOLIO"
bucket_name = "networking-portfolio"
```

Ключи в R2: `portfolio/{listing_id}/{position}.webp`, staging — `portfolio/staging/{tg_id}/`.

### A5. Секреты (`wrangler secret put`)

Выполнить из папки `worker/` для каждого ключа (значения **не** коммитить в git):

| Секрет | Назначение |
|---|---|
| `BOT_TOKEN` | Токен @BotFather |
| `ADMIN_TG_ID` | Числовой Telegram ID **grand_admin** (обязателен; seed в D1 `admins`) |
| `WEBAPP_SECRET` | **Тот же** ключ, что в `catalog.html` (`WEBAPP_SECRET`); только маркер POST `/api`, **не** для HMAC |
| `MEDIA_SIGNING_SECRET` | Случайная длинная строка (≥32 байт); HMAC подписи `/portfolio-media` (TTL 15 мин). **Только** `wrangler secret`, не в HTML |
| `ADMIN_PORTFOLIO_SECRET` | Отдельная случайная строка; HMAC admin preview token портфолио (TTL 24 ч). **Только** `wrangler secret`, не в HTML |
| `PAYMENT_AMOUNT_VND` | Напр. `200 000 VND` |
| `PAYMENT_AMOUNT_CRYPTO` | Напр. `8 USDT` |
| `PIN_PRICE_WEEK_VND` / `_CRYPTO` | Цены pin «неделя» |
| `PIN_PRICE_MONTH_VND` / `_CRYPTO` | Цены pin «месяц» |
| `PIN_PRICE_LIFETIME_VND` / `_CRYPTO` | Цены pin «навсегда» |
| `QR_VND_FILE_ID` | file_id QR VND |
| `QR_USDT_TRC20_FILE_ID` | file_id QR USDT TRC20 |
| `QR_USDT_BYBIT_FILE_ID` | file_id QR USDT Bybit |
| `QR_USDT_SOLANA_FILE_ID` | file_id QR USDT Solana |

Опционально (legacy GAS): `PAYMENT_AMOUNT` — fallback для VND, если нет `PAYMENT_AMOUNT_VND`.

> **Не использовать:** `ADMIN_PASSWORD_HASH` — пароль админа только через Mini App UI и PBKDF2 в D1 (`admin_profile_TZ.md` §1.2).

Проверка списка секретов (без значений):

```powershell
npx wrangler secret list
```

**Секреты портфолио (HMAC, только на сервере):** `MEDIA_SIGNING_SECRET` и `ADMIN_PORTFOLIO_SECRET` не должны совпадать с `WEBAPP_SECRET` из `catalog.html`. Сгенерировать и записать один раз (или при ротации):

```powershell
cd worker
# PowerShell — два независимых значения
$media = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$admin = [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
$media | npx wrangler secret put MEDIA_SIGNING_SECRET
$admin | npx wrangler secret put ADMIN_PORTFOLIO_SECRET
```

После смены `MEDIA_SIGNING_SECRET` старые signed URL медиа перестанут открываться (TTL 15 мин). После смены `ADMIN_PORTFOLIO_SECRET` — admin preview ссылки из Telegram (TTL 24 ч).

### A6. Vars в `wrangler.toml`

```toml
[vars]
MINI_APP_URL = "https://spaguet.github.io/networking_nhatrang/"
```

---

## Часть B. Деплой Worker

### B1. Проверка TypeScript

```powershell
cd worker
npx tsc --noEmit
```

Ошибок быть не должно.

### B2. Деплой

```powershell
npx wrangler deploy
```

В выводе — URL вида `https://tg-networking-nhatrang.<account>.workers.dev`.

> **Имя Worker** `tg-networking-nhatrang` не менять без обновления webhook и `API_URL` в `catalog.html`.

### B3. Webhook Telegram

Worker принимает updates только с заголовком `X-Telegram-Bot-Api-Secret-Token`, совпадающим с секретом `TELEGRAM_WEBHOOK_SECRET` (wrangler secret). Без корректного header запрос отклоняется (**403**), dedup KV и D1 не трогаются.

1. Сгенерировать токен (1–256 символов: `A-Za-z0-9_-`):

```powershell
# пример
$webhookSecret = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
```

2. Записать в Worker:

```powershell
cd worker
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

3. Зарегистрировать webhook с тем же `secret_token` (корень — текущий URL):

```powershell
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://tg-networking-nhatrang.albertkoall.workers.dev/&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Опционально явный путь `/webhook`:

```powershell
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://tg-networking-nhatrang.albertkoall.workers.dev/webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>"
```

Проверить webhook:

```powershell
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Smoke (без секрета в env — только негативные кейсы):

```powershell
npm run test:webhook
```

С секретом: `$env:TELEGRAM_WEBHOOK_SECRET='...'; npm run test:webhook`

---

## Часть C. Frontend (GitHub Pages)

В `catalog.html` (корень репо):

```javascript
var API_URL = 'https://tg-networking-nhatrang.albertkoall.workers.dev';
```

- POST: `fetch(API_URL + '/api', { method: 'POST', body: JSON.stringify(payload) })`
- GET лайки: `API_URL + '/api?action=getLikes&initData=...'`
- GET избранное (счётчики): `API_URL + '/api?action=getFavoriteCounts&initData=...'`
- GET toggle избранного: `API_URL + '/api?action=toggleFavorite&initData=...&listingId=...&type=favorite|unfavorite'`
- POST список избранного: `buildPayload('get_favorites')` → `{ ok, listings, totalCount, inactiveCount }`
- `WEBAPP_SECRET` — синхронизировать с `wrangler secret put WEBAPP_SECRET`

После правок — **push в GitHub** → Pages обновит Mini App (workflow `.github/workflows/pages.yml`).

---

## Часть D. E2E чеклист

### D1. Автоматические smoke-тесты (curl / PowerShell)

**GET /** — health:

```powershell
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/" -UseBasicParsing
# Ожидание: StatusCode 200, Content "OK"
```

**POST /** — fake Telegram update (dedup + 200):

```powershell
$body = '{"update_id":999999001,"message":{"message_id":1,"chat":{"id":1},"text":"/start"}}'
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/" -Method POST -Body $body -ContentType "application/json" -UseBasicParsing
# Ожидание: 200, "OK"
```

**POST /api** — `get_listings` (без initData допустимо):

```powershell
$payload = '{"action":"get_listings","category":"Другое","secret":"<WEBAPP_SECRET>"}'
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/api" -Method POST -Body $payload -ContentType "application/json" -UseBasicParsing
# Ожидание: JSON { "ok": true, "listings": [...] }
```

**GET /api** — лайки (нужен валидный `initData` из Mini App, TTL 1 ч):

```
GET .../api?action=getLikes&initData=<url-encoded>
# Ожидание: { "success": true, "likes": [...] }
```

**GET /api** — без initData (регрессия лайков):

```powershell
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/api?action=getLikes" -UseBasicParsing
# Ожидание: { "success": false, "error": "unauthorized" }
```

**GET /api** — избранное, без initData:

```powershell
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/api?action=getFavoriteCounts" -UseBasicParsing
# Ожидание: { "success": false, "error": "unauthorized" }

Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/api?action=toggleFavorite&listingId=test&type=favorite" -UseBasicParsing
# Ожидание: { "success": false, "error": "unauthorized" }
```

**POST /api** — `get_favorites` (нужны `secret` + валидный `initData` из Mini App):

```powershell
$payload = '{"action":"get_favorites","secret":"<WEBAPP_SECRET>","initData":"<initData>","tg_id":123}'
# Ожидание: { "ok": true, "listings": [...], "totalCount": N, "inactiveCount": M }
```

С `initData` из Telegram — проверить `favoritedByMe` в `getFavoriteCounts`, `newCount`/`isFavorited` в `toggleFavorite`.

**POST /api** — `get_pin_prices` (регрессия pin):

```powershell
$payload = '{"action":"get_pin_prices"}'
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/api" -Method POST -Body $payload -ContentType "application/json" -UseBasicParsing
# Ожидание: { "ok": true, "week": {...}, "month": {...}, "lifetime": {...} }
```

**POST /api** — `get_listings` с полями портфолио и keywords:

```powershell
$payload = '{"action":"get_listings","category":"Другое","secret":"<WEBAPP_SECRET>"}'
# Ожидание: { "ok": true, "listings": [{ ..., "has_portfolio": false|true, "portfolio_count": N, "keywords": [] }] }
```

**POST /api** — multipart `upload_portfolio` / `upload_portfolio_staging` — только из Mini App с валидным `initData` и файлами `photo_1`…`photo_5` (см. `portfolio_TZ.md` §10). Smoke curl без Telegram initData не применим.

**GET /portfolio-media** — signed URL медиа (TTL 15 мин); выдаётся в ответе `get_portfolio`.

### D2. Ручные сценарии (Telegram + Mini App)

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | `/start` в боте | Приветствие + кнопка каталога (web_app) |
| 2 | Открыть Mini App → каталог | Карточки по категории, без 5–15 сек задержки GAS |
| 3 | `submit_listing` (free) | Анкета на модерации |
| 4 | Админ: Approve в боте | Статус active, уведомление пользователю |
| 5 | Повторная анкета после free | `check_listing_status` → `paid_mode` |
| 6 | `select_payment_method` + фото чека | Draft → модерация paid |
| 7 | Лайк / снять лайк | Счётчик обновляется, KV + D1 |
| 7a | ⭐ Избранное / снять | Счётчик «В избранном: N», KV `favorites_all` + D1 |
| 7b | Экран «Избранные» | POST `get_favorites`, сортировка, keyword, unfavorite |
| 8 | Pin: оплата + approve админом | `pin_status=pinned`, сортировка вверху |
| 9 | «Связаться с админом» + ответ админа reply | Сообщение доходит пользователю |
| 10 | Cron maintenance | `npx wrangler triggers schedule` (ручной invoke) или дождаться 00:00 UTC |

### D2a. Портфолио v1.3 (ручной чеклист, `portfolio_TZ.md` §13)

| # | Сценарий | Ожидание |
|---|---|---|
| P1 | Анкета **без** чекбокса портфолио | Notify в `submit_listing`; нет кнопки «Портфолио»; нет R2 |
| P2 | Free: чекбокс on + 1–5 фото | WebP в R2; админ notify **после** `upload_portfolio`; popup + admin Web App |
| P3 | Free: ошибка upload | Ошибка в `#status`; админ **не** уведомлён; retry ≤ 24 ч |
| P4 | Paid: staging перед `select_payment_method` | После чека — `promoteStaging`; админ видит портфолио |
| P5 | Чекбокс on + 0 файлов | `portfolio_required`, submit не завершается |
| P6 | Reject | R2 + `listing_media` удалены; listing `rejected` |
| P7 | Approve с портфолио | Текст §11; `listing_media` pending → active |
| P8 | Архив > 90 дней | `purgeListing` (D1 + R2); staging > 7 дней — cleanup |

### D2b. Ключевые слова (`keywords_system_TZ.md` §15)

| # | Сценарий | Ожидание |
|---|---|---|
| K1 | Чекбокс keywords off | submit OK, `keywords: []` |
| K2 | Чекбокс on, 0 слов | `keywords_required` |
| K3 | Слово «дизайн123» | `keywords_invalid` |
| K4 | Стоп-слово | popup, submit blocked |
| K5 | Поиск «дизайн» | exact match only |
| K6 | Поиск «диз» | пусто (не substring) |
| K7 | Клик `{#tag}` в каталоге | search autofill + filter |
| K8 | Клик tag в профиле | openListings(cat) + filter |
| K9 | Фильтр в кат. A | нет карточек из кат. B |
| K10 | Republish | чекбокс + поля заполнены |
| K11 | Старые анкеты | без тегов, `keywords: []` |

> **PR-чеклист:** `worker/src/config.ts` `STOP_WORDS` ↔ `catalog.html` `STOP_WORDS`.

### D2c. Избранное (`favorites_system_TZ.md` §8.5)

| # | Сценарий | Ожидание |
|---|---|---|
| F1 | Добавить active в избранное | ⭐, счётчик +1, запись в D1 |
| F2 | Убрать из избранного | ☆, счётчик −1, DELETE |
| F3 | «Избранные» + сортировка | 20/стр, newest/oldest по `created_at` |
| F4 | Поиск по keyword на экране избранного | exact match, не каталог |
| F5 | Архивация / reject карточки | `favorites` очищены (`purgeFavoritesForListing`) |
| F6 | `inactiveCount > 0` | «Нет активных избранных карточек» |
| F7 | Unfavorite на экране «Избранные» | карточка исчезает без перезагрузки |
| F8 | Pinned + ⭐ | 📌 справа, звезда слева (`.is-pinned .favorite-wrap`) |
| F9 | `favoritesNavPrev` / `Next` | пагинация экрана избранного |
| F10 | `purgeListing` (hard delete) | `favorites` + KV `favorites_all` инвалидированы |

**Smoke без initData (автоматически):** `getFavoriteCounts` / `toggleFavorite` → `{ success: false, error: "unauthorized" }`.

**Миграция D1:** `005_favorites.sql` (таблица `favorites`, FK `listings` ON DELETE CASCADE, без FK на `users`).

### D2d. Админ-профиль (`admin_profile_TZ.md` v1.3)

**Миграции D1:** `006_banned.sql`, `007_admins_and_settings.sql`, `008_ban_metadata.sql` (см. §A4).

**Первый вход grand_admin:**

1. Seed в D1 (§A4) или bootstrap при открытии Mini App.
2. Если `password_hash` пустой — popup «Установка пароля» (`#adminSetupPasswordModal`), затем auto-login.
3. Если пароль уже задан — `#screenAdminLogin` → панель `#screenAdmin`.

**Роли:**

| Роль | Mini App | Бот |
|---|---|---|
| `grand_admin` | Цены, QR, admins CRUD, забаненные | Модерация, бан, `/qr*` |
| `admin` | Только забаненные + смена пароля | Модерация, бан (без QR и цен) |

**Авто-smoke API:**

```powershell
cd worker
.\scripts\admin-api-smoke.ps1
```

**Ручной E2E (20 сценариев):** `tests/admin-profile-e2e.md`.

| # | Сценарий | Ожидание |
|---|---|---|
| A1 | Обычный user | Нет кнопки «🛠 Админ» |
| A2 | Grand без пароля | Popup setup → full dashboard |
| A3 | Admin login | Только «Забаненные» |
| A4–A6 | Admin → settings / QR / add_admin | `403 forbidden` |
| A7–A8 | Grand add/remove admin | Доступ появляется / исчезает |
| A9–A12 | Ban / list / unban / unban staff | metadata + notify / guard |
| A13 | Save prices | Modal diff → save |
| A14–A19 | Session TTL, QR bot, moderation, ban admin | см. полный чеклист |
| A20 | Banned admin | `user_banned`, бот блокирует |

**Контрольный список перед релизом (§11):**

- [ ] Миграции 007, 008 на prod D1
- [ ] Seed / bootstrap grand_admin
- [ ] `wrangler deploy` + push `catalog.html`
- [ ] `admin-api-smoke.ps1` — 0 failed
- [ ] Пройти `tests/admin-profile-e2e.md` (хотя бы A1–A13 в Telegram)

#### Runbook: потеря пароля grand_admin

1. Доступ к Cloudflare Dashboard → D1 → `networking_nhatrang`.
2. Сброс пароля (только grand_admin):

```sql
UPDATE admins SET password_hash = NULL, password_salt = NULL, updated_at = datetime('now')
WHERE role = 'grand_admin';
```

3. Очистить KV-сессии (опционально, Dashboard → KV → prefix `admin_session:`) или дождаться TTL (8 ч sliding / 24 ч max).
4. Grand_admin открывает Mini App → снова popup «Установка пароля».
5. **Не** менять `ADMIN_TG_ID` в env без синхронизации строки в `admins` (риск двух или нуля grand_admin — §10).

#### Runbook: смена grand_admin (v2, ручная операция)

1. Обновить `ADMIN_TG_ID` в Worker secrets.
2. В D1: одна строка `role='grand_admin'` с новым `tg_id`; старую удалить или понизить до `admin` (только вручную, не через UI).
3. Переустановить пароль через popup setup.

**Динамические цены и QR:** D1 `app_settings` (приоритет над env), кэш KV 60 с — `getConfigWithSettings()`. Env `PIN_PRICE_*` / `QR_*` остаются fallback.

### D2e. Редактирование мини-резюме (`listing_edit_TZ.md` v1.5)

**Миграция D1:** `010_listing_edit.sql` (см. §A4). **Порядок релиза:** миграция 010 → `wrangler deploy` → push `catalog.html`.

**API:** `submit_listing_edit` (POST), поля квоты в `get_my_listings` (`edits_remaining`, `has_edit_pending`, `edit_draft_id`, `edit_draft_needs_portfolio`).

**Контрольный список перед релизом:**

- [ ] Миграция 010 на prod D1 (+ backfill active)
- [ ] `wrangler deploy` (handlers: listings, telegram, portfolio, maintenance)
- [ ] Push `catalog.html` (кнопка «Редактировать», popups, `formEditMode`)
- [ ] Пройти ручной чеклист ниже в Telegram

| # | Сценарий | Ожидание |
|---|---|---|
| E1 | Active, 3 правки, submit edit | `edits_remaining=2`, в каталоге старая версия |
| E2 | Approve edit | Каталог обновлён, тот же `listing_id`, сроки те же |
| E3 | Reject edit | Черновик удалён, счётчик не восстановлен |
| E4 | 3 reject подряд | Кнопка disabled, осталось: 0 |
| E5 | Popup при новом размещении | Показ, «Понятно» → submit/payment |
| E6 | Popup в режимe edit | Не показывается |
| E7 | `get_my_listings` | Нет черновика в списке; на родителе `has_edit_pending`, `edit_draft_id` |
| E8 | `get_listings` | Только старая версия до approve |
| E9 | Edit **без** portfolio | После approve фото родителя **на месте** |
| E10 | Edit **с** portfolio | После approve фото с черновика, старые удалены |
| E11 | Archive / cron archive при pending edit | Черновик удалён |
| E12 | Pin + approve edit | Pin сохранён |
| E13 | Likes | Счётчик на том же id |
| E14 | Stale `edit_pending` 7+ дней | Удалён, попытка не возвращена |
| E15 | Edit + portfolio, deferred | После submit — форма/upload; после upload — profile, hint «На модерации» |
| E16 | Edit + portfolio, upload прерван | В профиле «Отправить фото» → retry на `edit_draft_id`, квота не списывается повторно |
| E17 | `on_moderation`, клик «Редактировать» | Popup «пока недоступно»; форма **не** открывается |
| E18 | Edit, родитель с portfolio | Checkbox выкл., hint виден; submit без галочки → фото родителя на месте после approve |

**Авто-проверка перед ручным E2E:**

```powershell
cd worker
npx tsc --noEmit
npx wrangler deploy
```

### D2f. Сообщения (`user_messaging_TZ.md` v1.5)

**Миграции D1:** `011_messaging.sql`, `012_telegram_contact_verify.sql` (см. §A4).  
**Порядок релиза:** миграции 011–012 → `wrangler deploy` → push `catalog.html`.

**API (POST `/api`):** `verify_telegram_contact`, `resolve_telegram_chat`, `open_conversation`, `send_message`, `get_messages`, `list_my_conversations`, `get_messaging_unread`, `mark_conversation_read`, `submit_message_complaint`; админка: `admin_list_message_complaints`, `admin_get_complaint_body`, `admin_get_conversation_log`, `admin_punish_from_complaint`.

**Авто-smoke API:**

```powershell
cd worker
.\scripts\messaging-api-smoke.ps1
```

**Playwright** (из корня репо, нужен `BOT_TOKEN`; опционально listing id):

```powershell
npm run test:messaging
```

**Ручной E2E (T1–T21):** `tests/messaging-e2e.md`.

| # | Сценарий | Ожидание |
|---|---|---|
| M1 | Telegram карточка | «Написать в Telegram» → `openTelegramLink` |
| M2 | WA/Email карточка | «Скопировать» + «Написать» → in-app |
| M3 | Verify до модерации | Без verify — submit blocked; чужой @ник — mismatch |
| M4 | Первое сообщение | `expires_at` = +7 дней, не продлевается |
| M5 | Непрочитанные | Зелёный круг на home; снятие после открытия чата |
| M6 | Жалоба + админ | Push одной строкой; таблица; «Казнить» = бан + notify |
| M7 | TTL / purge | Истёкший TTL — read-only; open жалоба — не purge; пустой диалог 7d — удалён |
| M8 | Ссылки в чате | `links_forbidden` |
| M9 | Своя карточка | Нет кнопок сообщений |
| M10 | Нет push при msg | Бот молчит на новые in-app сообщения |

**Контрольный список перед релизом:**

- [ ] Миграции 011, 012 на prod D1
- [ ] `wrangler deploy` + push `catalog.html`
- [ ] `messaging-api-smoke.ps1` — 0 failed
- [ ] `npm run test:messaging` (или smoke без `BOT_TOKEN` — только auth block)
- [ ] Пройти `tests/messaging-e2e.md` (хотя бы M1–M6 в Telegram)

### D3. Логи в реальном времени

```powershell
cd worker
npx wrangler tail
```

Открыть Mini App / бота — в tail должны появляться запросы без необработанных исключений.

### D4. Cron (ручной запуск)

```powershell
npx wrangler triggers schedule
```

Выбрать cron `0 0 * * *` → проверить `logs` в D1 (`action = daily_maintenance`).

---

## Часть E. Cutover (Фаза B)

1. `wrangler deploy` — новый код на том же URL Worker.
2. Webhook — без изменений (если URL Worker тот же).
3. `catalog.html`: `API_URL` → Worker → push GitHub Pages.
4. Проверить: бот, каталог, модерация, лайки, pin (таблица D2).

**GAS не удалять** 2 недели — только read-only архив.

---

## Часть F. Rollback

Если после cutover что-то сломалось:

1. **Frontend:** откатить `catalog.html` — вернуть `GAS_URL` и URL GAS `/exec`, push Pages.
2. **Worker:** Cloudflare Dashboard → Workers → `tg-networking-nhatrang` → Deployments → **Rollback** на предыдущую версию.
3. **Временный proxy:** задеплоить старый proxy-код, пересылающий `POST /` в GAS (см. историю git / `migration_to_cf_d1_TZ.md` §9).

Webhook на GAS при откате frontend **не** переключать, если Worker снова проксирует в GAS.

---

## Часть G. Стабилизация (Фаза C, 2 недели)

- Мониторить `wrangler tail` и ошибки в D1 `logs`.
- Не трогать GAS-деплой до уверенности в Worker.
- Через 2 недели: заархивировать GAS (web app оставить read-only).

---

## Быстрая шпаргалка (уже настроенный аккаунт)

```powershell
cd worker
npm install
npx tsc --noEmit
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/011_messaging.sql
npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/012_telegram_contact_verify.sql
npx wrangler deploy
```

Затем push `catalog.html` и пройти E2E §D (сообщения — §D2f, `tests/messaging-e2e.md`).

---

*Создано в рамках миграции GAS → CF (Промпт 12, `migration_to_cf_d1_TZ.md`). Обновлено 01.06.2026 — сообщения v1.5 (D1 011–012, `user_messaging_TZ.md`, §D2f, промпт 8).*
