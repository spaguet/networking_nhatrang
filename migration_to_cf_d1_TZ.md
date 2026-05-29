# Миграция Нетворкинг Нячанг: GAS + Google Sheets → Cloudflare Workers + D1

**Версия ТЗ:** 2.5 (май 2026)  
**Статус:** **Фаза B завершена** — cutover на Worker + GitHub Pages (28.05.2026). **Портфолио v1.3** ✅ (29.05.2026). **Следующий шаг:** Фаза C (2 недели мониторинга, GAS не удалять)  
**Источник правды по логике:** `Code.gs` + `catalog.html` + `portfolio_TZ.md` (портфолио)

> **Changelog 2.5:** Портфолио v1.3 ✅ — R2 `PORTFOLIO`, D1 `listing_media` + `archived_at`, multipart upload, `submit_listing` + `listing_id` + `deferred_notify`; actions `upload_portfolio`, `upload_portfolio_staging`, `get_portfolio`; см. журнал в конце §10.
>
> **Changelog 2.4:** Фаза B ✅ — push `catalog.html` на `main`, GitHub Pages deploy, live `API_URL` на workers.dev.
>
> **Changelog 2.3:** Промпт 12 ✅ — `DEPLOY_GUIDE_CF.md`, `wrangler deploy`, smoke E2E, журнал обновлён; Фаза A закрыта.
>
> **Changelog 2.2:** per-handler коды `Invalid initData`, `normalizeDescriptionInput`, fallback `PAYMENT_AMOUNT`, команда `wrangler kv namespace create`, вторичные коды ошибок с `message`.
>
> **Changelog 2.1:** webhook на `/` + `/webhook`, SQL-сортировка pinned, два TTL initData, порядок промптов (telegram-api до handlers), уточнения по server_config, pin warning, get_listings initData.

---

## Ход выполнения (журнал миграции)

**Последнее обновление:** 29.05.2026 (портфолио v1.3)  
**CF аккаунт:** `albertkoall@gmail.com` (`7629e83b82917f3be3175c6f4bf3fed4`)  
**Worker (prod):** `tg-networking-nhatrang` — **полный код Worker + D1 + R2**, `wrangler deploy` ✅  
**Version ID:** `b6db5d6e-4b38-4d88-adf5-87de7ac921f4` (фаза 6 портфолио E2E, 29.05.2026)  
**URL:** `https://tg-networking-nhatrang.albertkoall.workers.dev`  
**GitHub Pages:** `https://spaguet.github.io/networking_nhatrang/` — **live `API_URL` → Worker** (commit `a72e4ff`, портфолио + rules)

### Прогресс по промптам (§10)

| # | Промпт | Статус | Примечание |
|---|---|---|---|
| 1 | Инициализация проекта | ✅ | scaffold в `worker/` |
| 2 | Главный роутер | ✅ | `index.ts` + handlers stubs |
| 3 | Auth + validation | ✅ | utils + sessions.ts |
| 4 | telegram-api service | ✅ | `services/telegram-api.ts` |
| 5 | Listings API | ✅ | `handlers/listings.ts` |
| 6 | Payment API | ✅ | `handlers/payment.ts` |
| 7 | Pins API | ✅ | `handlers/pins.ts` + pin helpers |
| 8 | Likes + KV | ✅ | `handlers/likes.ts` |
| 9 | Telegram bot | ✅ | `handlers/telegram.ts` |
| 10 | Cron maintenance | ✅ | `handlers/maintenance.ts` |
| 11 | catalog.html | ✅ | `GAS_URL` → `API_URL`, пути `/api` |
| 12 | DEPLOY_GUIDE_CF + E2E | ✅ | deploy + smoke E2E 28.05.2026 |

### Фаза A — что сделано

| Шаг | Статус | Детали |
|---|---|---|
| `cd worker && npm install` | ✅ | 38 пакетов, wrangler 4.95 |
| `wrangler login` | ✅ | OAuth, albertkoall@gmail.com |
| `wrangler d1 create networking_nhatrang` | ✅ | `database_id = da3337f2-02ad-49ef-b577-09916aa08763` |
| `wrangler kv namespace create CACHE` | ✅ | `id = aed391de129a4490a3d390731bd9ae90` |
| `wrangler d1 execute … --remote` | ✅ | 6 таблиц: users, listings, sessions, logs, likes, admin_links |
| `wrangler secret put` (§7) | ✅ | 16 секретов (см. ниже) |
| `MINI_APP_URL` в wrangler.toml | ✅ | `https://spaguet.github.io/networking_nhatrang/` |
| Промпт 12 + deploy | ✅ | `wrangler deploy`, Version `368c2c4c-…` |
| E2E на workers.dev | ✅ | smoke: GET/POST `/`, `/api`, `/webhook` (см. Промпт 12) |
| `DEPLOY_GUIDE_CF.md` | ✅ | корень репо |

### Созданные файлы (Промпт 1)

```
worker/
├── package.json, tsconfig.json, wrangler.toml
├── src/
│   ├── env.ts, types.ts, config.ts
│   ├── index.ts              ← роутер (Промпт 2 ✅)
│   ├── handlers/
│   │   ├── api.ts, listings.ts   ← Промпт 5 ✅
│   │   ├── payment.ts            ← Промпт 6 ✅
│   │   ├── pins.ts               ← Промпт 7 ✅
│   │   ├── likes.ts              ← Промпт 8 ✅
│   │   ├── telegram.ts           ← Промпт 9 ✅
│   │   ├── maintenance.ts        ← Промпт 10 ✅
│   │   └── sessions.ts       ← D1 sessions (Промпт 3 ✅)
│   ├── services/
│   │   └── telegram-api.ts   ← Промпт 4 ✅
│   ├── db/schema.sql, db/migrations/001_init.sql
│   └── utils/
│       ├── response.ts
│       ├── auth.ts           ← Промпт 3 ✅
│       ├── validation.ts     ← Промпт 3 ✅
│       ├── description.ts    ← Промпт 3 ✅
│       └── helpers.ts        ← Промпт 3 ✅ + pin helpers (Промпт 7)
```

Дополнительно: в `.gitignore` — `worker/node_modules/`, `worker/.dev.vars`.

### Промпт 12 — деплой и документация *(28.05.2026)*

| Файл | Изменение |
|---|---|
| `DEPLOY_GUIDE_CF.md` | **новый** — пошаговый деплой CF, E2E, rollback |
| `worker/` (remote) | `wrangler deploy` — proxy GAS заменён полным Worker |
| `migration_to_cf_d1_TZ.md` | журнал, §9, Промпт 12, чеклист §12 |

### Секреты и vars (загружены в Worker, значения **не** в репо)

| Ключ | Где | Статус |
|---|---|---|
| `MINI_APP_URL` | wrangler.toml `[vars]` | ✅ |
| `BOT_TOKEN` | secret | ✅ |
| `ADMIN_TG_ID` | secret | ✅ |
| `WEBAPP_SECRET` | secret | ✅ (= `catalog.html`, уже было `getting_more_money`) |
| `PAYMENT_AMOUNT_VND` | secret | ✅ `200 000 VND` |
| `PAYMENT_AMOUNT_CRYPTO` | secret | ✅ `8 USDT` |
| `PIN_PRICE_WEEK_VND` | secret | ✅ `150 000 VND` |
| `PIN_PRICE_WEEK_CRYPTO` | secret | ✅ `7 USDT` |
| `PIN_PRICE_MONTH_VND` | secret | ✅ `500 000 VND` |
| `PIN_PRICE_MONTH_CRYPTO` | secret | ✅ `20 USDT` |
| `PIN_PRICE_LIFETIME_VND` | secret | ✅ `3 000 000 VND` |
| `PIN_PRICE_LIFETIME_CRYPTO` | secret | ✅ `115 USDT` |
| `QR_VND_FILE_ID` | secret | ✅ |
| `QR_USDT_TRC20_FILE_ID` | secret | ✅ |
| `QR_USDT_BYBIT_FILE_ID` | secret | ✅ |
| `QR_USDT_SOLANA_FILE_ID` | secret | ✅ |
| `PAYMENT_AMOUNT` (legacy) | — | не задан (fallback в `config.ts` не нужен — есть `PAYMENT_AMOUNT_VND`) |

### Фаза B — cutover ✅ *(28.05.2026)*

| Шаг | Статус | Детали |
|---|---|---|
| `catalog.html` API_URL → Worker | ✅ | Промпт 11 + rebase с `origin/main` |
| Push `main` | ✅ | commit `25e1947` — `spaguet/networking_nhatrang` |
| GitHub Pages deploy | ✅ | workflow `26583517035`, ~2 мин |
| Live Pages проверка | ✅ | `/`, `catalog.html`, `index.html` — `API_URL`, без `GAS_URL` |
| Worker API с Pages | ✅ | `POST /api` get_listings → `{ ok: true }` |
| Webhook | ✅ | без перерегистрации (уже `workers.dev`, `Code.gs` `installCloudflareWebhook`) |
| Ручной E2E в Telegram | ⬜ | оператор: /start, каталог, форма, модерация, лайки, pin (`DEPLOY_GUIDE_CF.md` §D2) |

**Конфликт при push:** rebase на `4defe5c` — в `initLikes`/`sendLike` на remote остался `GAS_URL`; разрешено в пользу `API_URL + '/api?…'`.

---

## 0. Диагностика проблемы

**Почему тормозит сейчас:**

| Узкое место | Причина | Задержка |
|---|---|---|
| GAS cold start | После простоя JVM переинициализируется | 3–8 сек |
| `getValues()` | Читает ВЕСЬ лист, независимо от фильтра | Растёт линейно с данными |
| Нет индексов | Поиск по категории = перебор всех строк | O(n) |
| CacheService | Протухает за 180 сек, затем снова полный скан | Провалы раз в 3 минуты |
| HTTP 302 | GAS `/exec` делает redirect — лишний round-trip | +200–500 мс |

**Вывод:** при 500+ активных карточках загрузка каталога будет занимать 5–15 секунд. При 1000+ — таймаут.

---

## 1. Принятые решения (ответы на вопросы заказчика)

| # | Вопрос | Решение |
|---|---|---|
| 1 | Самый безопасный способ | **Blue-green cutover:** сначала полный Worker на `workers.dev`, E2E-тесты, затем переключение webhook + одна правка URL во фронте. GAS **не удалять** 2 недели как fallback. |
| 2 | Один файл или модули | **Модульная структура Worker** (handlers/utils/db) — стандарт для CF Workers. `catalog.html` остаётся **одним файлом** в корне репо (GitHub Pages). |
| 3 | Новый Worker или расширить proxy | **Заменить код существующего Worker** `tg-networking-nhatrang` (URL уже в webhook). Не создавать второй Worker — меньше точек отказа. |
| 4 | Кто ведёт миграцию | **Пошаговый план ниже (§10).** Каждый шаг — отдельный промпт + проверка перед следующим. |
| 5 | Перенос данных из Sheets | **Не нужен** (тестовые данные). D1 создаётся пустой, только schema.sql. Скрипт migrate_sheets — опционально на будущее. |
| 6 | WEBAPP_SECRET | **Двухслойная защита:** (1) основная — `validateTelegramInitData` по Bot Token; (2) дополнительная — `WEBAPP_SECRET` в `wrangler secret put`, тот же ключ в `catalog.html`. Секрет в HTML — не криптостойкий (виден в DevTools), но отсекает простой спам без initData. **Не полагаться только на secret.** |

---

## 2. Рекомендуемое решение: Cloudflare Workers + D1

### Почему именно это

1. **Уже есть CF аккаунт** — Worker `tg-networking-nhatrang` уже принимает webhook.
2. **D1 = SQLite at the edge** — SQL с `WHERE`, индексами, транзакциями.
3. **Workers cold start ≈ 0 мс** — против 3–8 сек у GAS.
4. **Бесплатный tier** достаточен: 5 GB D1, 5M reads/день, 100K writes/день, 100K Worker requests/день.
5. **Cursor хорошо пишет Workers** — TypeScript, Web Crypto, wrangler.

### Что меняется / не меняется

| Компонент | Изменение |
|---|---|
| `catalog.html` | Минимально: `API_URL`, пути `/api`, `WEBAPP_SECRET` синхронизировать с Worker |
| `index.html` | **Не нужен** — в репо только `catalog.html` (форма через `?form=1`) |
| GitHub Pages | Без изменений в деплое |
| Telegram Bot | Тот же токен, webhook на тот же Worker URL |
| GAS + Sheets | **Остаются в архиве** 2 недели, потом отключить webhook |
| CF Worker proxy | **Заменяется** полноценным бэкендом на том же имени |

---

## 3. Новая архитектура

```
[Пользователь / Telegram Mini App]
        │
        ▼
[GitHub Pages — catalog.html]
  POST  → {WORKER_URL}/api     (JSON body.action)
  GET   → {WORKER_URL}/api?action=getLikes|toggleLike
        │
        ▼
[Cloudflare Worker — tg-networking-nhatrang]
  GET  /              → health check "OK"
  POST /              → Telegram updates (текущий webhook URL — корень!)
  POST /webhook       → Telegram updates (алиас, для явной регистрации)
  POST /api           → Mini App (все action из doPost)
  GET  /api           → лайки (getLikes, toggleLike)
        │
        ├── D1 (SQLite)
        │     users | listings | sessions | logs | likes | admin_links
        │
        └── KV (CACHE)
              likes_all (TTL 180s) | upd_{update_id} (dedup webhook, TTL 6h)
        │
        ▼
[Telegram Bot API]
```

### Стек

| Компонент | Было | Стало |
|---|---|---|
| Бэкенд | Google Apps Script | Cloudflare Worker (TypeScript) |
| База данных | Google Sheets | Cloudflare D1 |
| Кэш лайков | CacheService | KV `likes_all`, TTL 180s |
| Dedup webhook | CacheService `upd_*` | KV `upd_*`, TTL 21600s |
| Блокировки лайков | LockService | D1 `batch()` |
| Cron | GAS trigger 07:00 | CF Cron `0 0 * * *` UTC (= 07:00 Nha Trang) |
| Фронтенд | GitHub Pages | GitHub Pages |

### Webhook: путь `/` vs `/webhook`

Сейчас в `Code.gs` (`installCloudflareWebhook`) webhook зарегистрирован на **корень** Worker:

```
https://tg-networking-nhatrang.albertkoall.workers.dev
```

**Без суффикса `/webhook`.** Новый Worker **обязан** принимать Telegram updates на `POST /` (backward compatibility). Дополнительно — `POST /webhook` как алиас. Перерегистрация webhook при cutover **не обязательна**, если корень обрабатывается.

---

## 4. Изменения в структуре репозитория

### Было

```
networking/
├── catalog.html
├── Code.gs
├── gas/
├── DEPLOY_GUIDE_RU.md
├── migration_to_cf_d1_TZ.md
└── ...
```

### Станет

```
networking/
├── catalog.html              ← правки URL (остаётся в корне для Pages)
├── Code.gs                   ← архив, не трогать до cutover
├── worker/                   ← НОВЫЙ бэкенд
│   ├── src/
│   │   ├── index.ts
│   │   ├── env.ts            ← интерфейс Env
│   │   ├── config.ts
│   │   ├── types.ts
│   │   ├── db/
│   │   │   ├── schema.sql
│   │   │   └── migrations/001_init.sql
│   │   ├── handlers/
│   │   │   ├── api.ts        ← роутинг action → handler
│   │   │   ├── listings.ts
│   │   │   ├── payment.ts    ← check_listing_status, select_payment_method
│   │   │   ├── likes.ts
│   │   │   ├── pins.ts
│   │   │   ├── telegram.ts
│   │   │   ├── sessions.ts
│   │   │   └── maintenance.ts
│   │   ├── services/
│   │   │   └── telegram-api.ts  ← sendMessage, sendPhoto, editMarkup
│   │   └── utils/
│   │       ├── auth.ts
│   │       ├── response.ts   ← jsonOk, jsonErr, corsHeaders
│   │       ├── validation.ts ← validateListingForm, stop words
│   │       ├── description.ts
│   │       └── helpers.ts
│   ├── wrangler.toml
│   ├── package.json
│   └── tsconfig.json
├── DEPLOY_GUIDE_CF.md        ← ✅ Промпт 12 (28.05.2026)
├── DEPLOY_GUIDE_RU.md        ← остаётся для GAS-архива
└── migration_to_cf_d1_TZ.md  ← этот файл
```

**Почему `catalog.html` не в `frontend/`:** GitHub Pages уже настроен на корень репо (`.github/workflows/pages.yml`). Перенос сломает URL без редиректов.

**Про `index.html`:** отдельный файл в репо не нужен — workflow копирует `catalog.html` → `site/index.html` при деплое Pages.

---

## 5. Схема базы данных D1

```sql
-- users
CREATE TABLE IF NOT EXISTS users (
  tg_id       INTEGER PRIMARY KEY,
  username    TEXT,
  first_name  TEXT NOT NULL,
  reg_date    TEXT NOT NULL,
  free_used   INTEGER NOT NULL DEFAULT 0
);

-- listings
CREATE TABLE IF NOT EXISTS listings (
  listing_id      TEXT PRIMARY KEY,
  tg_id           INTEGER NOT NULL,
  display_name    TEXT NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL,
  experience      TEXT,
  contact_type    TEXT NOT NULL,
  contacts        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'on_moderation',
  payment_status  TEXT NOT NULL DEFAULT 'free',
  created_at      TEXT,
  expires_at      TEXT,
  submitted_at    TEXT NOT NULL,
  avatar_emoji    TEXT,
  pin_status      TEXT NOT NULL DEFAULT 'regular',
  pinned_at       TEXT,
  pin_expires_at  TEXT,
  FOREIGN KEY (tg_id) REFERENCES users(tg_id)
);

CREATE INDEX IF NOT EXISTS idx_listings_status   ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_category ON listings(category);
CREATE INDEX IF NOT EXISTS idx_listings_tg_id    ON listings(tg_id);
CREATE INDEX IF NOT EXISTS idx_listings_pin      ON listings(pin_status, status);
CREATE INDEX IF NOT EXISTS idx_listings_expires  ON listings(expires_at);

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
  tg_id        INTEGER PRIMARY KEY,
  state        TEXT NOT NULL,
  draft        TEXT,
  updated_at   TEXT NOT NULL,
  session_type TEXT DEFAULT 'payment'
);

-- logs
CREATE TABLE IF NOT EXISTS logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp   TEXT NOT NULL,
  tg_id       INTEGER,
  action      TEXT NOT NULL,
  details     TEXT
);

-- likes
CREATE TABLE IF NOT EXISTS likes (
  listing_id  TEXT NOT NULL,
  tg_id       INTEGER NOT NULL,
  liked_at    TEXT NOT NULL,
  PRIMARY KEY (listing_id, tg_id)
);

CREATE INDEX IF NOT EXISTS idx_likes_listing ON likes(listing_id);

-- admin_links (reply админа → пользователь)
CREATE TABLE IF NOT EXISTS admin_links (
  admin_message_id INTEGER PRIMARY KEY,
  user_tg_id       INTEGER NOT NULL,
  link_type        TEXT,
  listing_id       TEXT,
  created_at       TEXT NOT NULL
);
```

**Миграция данных:** не выполняется. После `wrangler d1 execute ... --file=schema.sql` база пустая.

---

## 6. Контракт API (строго как в Code.gs + catalog.html)

> **КРИТИЧНО:** не менять поля ответов. Фронт проверяет `data.ok` (POST) и `data.success` (лайки GET).

### POST `/api` — общий формат запроса

```json
{
  "action": "...",
  "tg_id": 123456789,
  "username": "...",
  "first_name": "...",
  "initData": "...",
  "secret": "..."
}
```

Все POST-хэндлеры (кроме webhook): проверять `secret === env.WEBAPP_SECRET` (если задан) и `validateInitData(initData, BOT_TOKEN)` (TTL **86400 сек**).

**Исключения (как в Code.gs):**
- `get_listings` — initData **опционален** (валидировать только если передан).
- `get_pin_prices` — secret не проверяется; initData опционален.
- GET лайки — отдельная валидация `validateTelegramInitData`, TTL **3600 сек** (см. §8).

**Коды ошибок initData:** в Code.gs **два варианта строки** — не унифицировать при порте! Фронт нормализует: `(data.error || '').replace(/\s/g, '_')` → `Invalid_initData`.

| Handler / action | Строка `error` при невалидном initData |
|---|---|
| `submit_listing`, `check_listing_status`, `select_payment_method`, `select_pin_payment_method` | `'Invalid initData'` (с пробелом) |
| `get_listings`, `get_my_listings`, `archive_listing`, `get_pin_prices` | `'Invalid_initData'` (с подчёркиванием) |

**Вторичные коды** (есть в GAS, **нет** в `ERRORS` catalog.html — фронт показывает `data.message` или сам `data.error`):
`free_listing_available`, `invalid_tg_id`, `invalid_pin_duration`, `missing_listing_id`. Портировать с теми же `message`, что в Code.gs.

### Таблица actions

| action | Handler | Успешный ответ |
|---|---|---|
| `get_listings` | listings | `{ ok: true, listings: [...] }` — **все** active по category, без server pagination |
| `get_my_listings` | listings | `{ ok: true, listings: [...] }` |
| `submit_listing` | listings | `{ ok: true, listing_id, message }` — без портфолио: notify сразу, message «Анкета отправлена на модерацию»; с `portfolio_enabled: true`: **без notify**, `deferred_notify: true`, message «Загрузка фото…» (notify после `upload_portfolio`) |
| `upload_portfolio` | portfolio (multipart) | `{ ok: true, listing_id, count }` — free/retry; notify админу + пользователю при первом успехе |
| `upload_portfolio_staging` | portfolio (multipart) | `{ ok: true, count }` — paid: R2 `portfolio/staging/{tg_id}/` до INSERT listing |
| `get_portfolio` | portfolio (JSON) | `{ ok: true, listing_id, display_name, items: [{ position, url, width, height }] }` — signed URL TTL 15 мин |
| `archive_listing` | listings | `{ ok: true, message: "..." }` |
| `check_listing_status` | payment | `{ ok: true, paid_mode, can_submit_free, banner, has_listing?, listing? }` |
| `select_payment_method` | payment | `{ ok: true, message: "..." }` |
| `get_pin_prices` | pins | `{ ok: true, week: {vnd,crypto}, month: {...}, lifetime: {...} }` |
| `select_pin_payment_method` | pins | `{ ok: true, message: "..." }` |

Ошибки: `{ ok: false, error: "...", message?: "...", paid_mode?: true }`

Коды ошибок из фронта (`ERRORS` в catalog.html): `stop_words`, `use_paid_flow`, `Invalid_initData`, `invalid_secret`, `invalid_category`, `invalid_contact_type`, `invalid_avatar`, `invalid_payment_method`, `qr_not_configured`, `unknown_action`, `server_error`, **`portfolio_required`**, **`portfolio_too_many`**, **`portfolio_upload_failed`**, **`portfolio_invalid_type`**, **`portfolio_too_large`**, **`portfolio_compress_failed`**, **`portfolio_not_owner`**, **`portfolio_listing_not_found`**, **`portfolio_wrong_status`**, **`portfolio_retry_expired`**.

**Поля listings в ответах `get_listings` / `get_my_listings`:** `has_portfolio` (boolean), `portfolio_count` (number). В каталоге — только `active` media; в «Мой профиль» — `pending` + `active`.

**Multipart POST `/api`:** при `Content-Type: multipart/form-data` — actions `upload_portfolio`, `upload_portfolio_staging`; поля файлов `photo_1`…`photo_5`, плюс `listing_id` (upload), `initData`, `secret`. JSON-actions — как раньше.

### GET `/api`

| Query | Ответ |
|---|---|
| `?action=getLikes&initData=...` | `{ success: true, likes: [{ cardId, total, likedByMe }] }` |
| `?action=toggleLike&initData=...&cardId=...&type=like\|unlike` | `{ success: true, newCount: N }` |

### POST `/` и POST `/webhook` (Telegram)

Тело — Telegram Update JSON (`update_id` в body). Всегда отвечать `200 OK` текстом `"OK"`. Dedup: `update_id` → KV ключ `upd_{id}`, TTL 21600.

> **Критично:** `POST /` обязателен — на него уже указывает текущий webhook. `POST /webhook` — дополнительный маршрут.

### GET `/`

`200 OK`, body `"OK"`.

---

## 7. wrangler.toml

> **Актуально в репо** (28.05.2026): ID D1/KV и `MINI_APP_URL` проставлены; секреты загружены через `wrangler secret put` (значения не в git).

```toml
name = "tg-networking-nhatrang"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[d1_databases]]
binding = "DB"
database_name = "networking_nhatrang"
database_id = "da3337f2-02ad-49ef-b577-09916aa08763"

[[kv_namespaces]]
binding = "CACHE"
id = "aed391de129a4490a3d390731bd9ae90"

[[r2_buckets]]
binding = "PORTFOLIO"
bucket_name = "networking-portfolio"

[triggers]
crons = ["0 0 * * *"]

[vars]
MINI_APP_URL = "https://spaguet.github.io/networking_nhatrang/"

# Секреты (wrangler secret put) — ✅ загружены 28.05.2026:
# BOT_TOKEN, ADMIN_TG_ID, WEBAPP_SECRET
# PAYMENT_AMOUNT_VND, PAYMENT_AMOUNT_CRYPTO
# PIN_PRICE_WEEK/MONTH/LIFETIME (_VND + _CRYPTO)
# QR_VND_FILE_ID, QR_USDT_TRC20/BYBIT/SOLANA_FILE_ID
# PAYMENT_AMOUNT — опционально, legacy fallback GAS (не задан)
```

> **Fallback суммы оплаты (как в `getConfig()` Code.gs):** в `config.ts` Worker, не в secrets:  
> `paymentAmountVnd = env.PAYMENT_AMOUNT_VND || env.PAYMENT_AMOUNT || '200 000 VND'`  
> Секрет `PAYMENT_AMOUNT` — опционально (legacy-ключ GAS); основной — `PAYMENT_AMOUNT_VND`.

> **Имя Worker:** `tg-networking-nhatrang` — совпадает с текущим webhook URL в `Code.gs` (`installCloudflareWebhook`).

---

## 8. Ключевые технические правила

| Тема | Правило |
|---|---|
| Web Crypto | Только `crypto.subtle`, не Node `crypto` |
| initData POST `/api` | `validateInitData` — `auth_date` max **86400 сек (24 ч)** (как в Code.gs) |
| initData GET лайки | `validateTelegramInitData` — `auth_date` max **3600 сек (1 ч)** (как `getLikesForUser` / `handleLike` в Code.gs) |
| Webhook routing | Telegram updates на **`POST /`** (текущий URL) **и** `POST /webhook` (алиас) |
| Description | Перед encode: `normalizeDescriptionInput` (trim, `\r\n`/`\r` → `\n`); хранить с `\n` как литерал `\\n` через `encodeDescriptionNewlines`; отдавать через `decodeDescriptionNewlines` |
| initData error string | **Per-handler** — см. таблицу в §6; не заменять все на один вариант |
| PAYMENT_AMOUNT_VND | Fallback: `PAYMENT_AMOUNT_VND \|\| PAYMENT_AMOUNT \|\| '200 000 VND'` в `config.ts` (§7) |
| get_listings | SQL `WHERE status='active' AND category=?`, **без LIMIT** (клиент пагинирует `LISTINGS_PER_PAGE = 20`) |
| Сортировка pinned | **НЕ** `ORDER BY pin_status DESC` (строки: `'regular'` > `'pinned'` по алфавиту!). Использовать: `CASE WHEN pin_status='pinned' THEN 1 ELSE 0 END DESC`, затем `pinned_at DESC`, затем `created_at DESC` — как в `handleGetListings` Code.gs |
| server_config | В Worker проверять `BOT_TOKEN` (+ D1 binding), **не** `SHEET_ID` (это только GAS) |
| Content-Type | `catalog.html` шлёт POST без `Content-Type` — Worker парсит JSON body без строгой проверки заголовка |
| Лайки KV | Кэш `likes_all` — массив `{cardId, total, userIds[]}` без `likedByMe`; `likedByMe` вычислять при ответе |
| D1 batch | Атомарные like/unlike через `env.DB.batch([...])` |
| CORS | `Access-Control-Allow-Origin: *`, OPTIONS preflight для `/api` |
| Cron | Блоки A/B/C из `dailyListingsMaintenance` в Code.gs (архивация, pin expiry, warning 20–28h) |
| Pin warning | Предупреждение за 20–28 ч до истечения pin — **каждый cron-запуск** в этом окне (как в GAS, без dedup «один раз») |
| QR hot-reload | GAS: admin photo → Script Properties. Worker v1: только wrangler secrets; `/qr_status` показывает задан/нет. Hot-reload через KV — опционально v2 (§14) |
| Telegram | `answerCallbackQuery` после каждого callback; approve/reject только от `ADMIN_TG_ID` |

---

## 9. План cutover (руководство миграцией)

### Фаза A — Подготовка (локально, прод не трогаем)

1. ✅ `cd worker && npm install`
2. ✅ `wrangler login`
3. ✅ `wrangler d1 create networking_nhatrang` → database_id в toml (`da3337f2-02ad-49ef-b577-09916aa08763`)
4. ✅ `wrangler kv namespace create CACHE` → id в toml (`aed391de129a4490a3d390731bd9ae90`)
5. ✅ `wrangler d1 execute networking_nhatrang --file=src/db/schema.sql --remote`
6. ✅ `wrangler secret put` — все секреты из §7 (+ `MINI_APP_URL` в vars)
7. ✅ Промпт 12 → `wrangler deploy` (Version `368c2c4c-5ec2-4f3d-9e73-f126284d6794`)
8. ✅ E2E smoke на `https://tg-networking-nhatrang.albertkoall.workers.dev` (см. Промпт 12, `DEPLOY_GUIDE_CF.md` §D)

### Фаза B — Переключение (5 мин downtime max) ✅ *(28.05.2026)*

1. ✅ **Webhook на Worker (корень `/`)** — перерегистрация не выполнялась (URL не менялся)
2. ✅ **`catalog.html`** — `API_URL`, `/api`, `WEBAPP_SECRET` синхронизирован с wrangler
3. ✅ **Push GitHub** → Pages: commit `25e1947`, run `26583517035`
4. ⬜ **Ручная проверка в Telegram:** /start, каталог, форма, модерация, лайки, pin (оператор)

### Фаза C — Стабилизация (2 недели)

- GAS не удалять; webhook на Worker (не на GAS)
- Мониторить `wrangler tail`
- Через 2 недели: заархивировать GAS-деплой

### Rollback (если что-то сломалось)

1. Откатить `catalog.html` (GAS_URL + старый URL)
2. В Cloudflare Dashboard → Worker → предыдущий deployment → Rollback
3. Или временно вернуть proxy-код Worker, проксирующий в GAS `/exec`

---

## 10. Промпты для Cursor (пошагово)

> Выполнять **строго по порядку**: **1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12**  
> (Промпт 4 = telegram-api service — **до** handlers, которые его используют.)  
> Перед каждым промптом: открыть `Code.gs` и соответствующий handler.  
> Контекст для Cursor: `@Code.gs`, `@catalog.html`, `@migration_to_cf_d1_TZ.md`.

---

### Промпт 1 — Инициализация проекта ✅ *(28.05.2026)*

```
Создай Cloudflare Workers проект в папке worker/ для Telegram Mini App «Нетворкинг Нячанг».

Стек: Workers TypeScript, D1, KV.

Структура — как в migration_to_cf_d1_TZ.md §4.

Создай:
1. package.json (@cloudflare/workers-types, typescript, wrangler)
2. tsconfig.json
3. wrangler.toml — name = "tg-networking-nhatrang", D1 binding DB, KV binding CACHE, cron "0 0 * * *"
4. src/env.ts — интерфейс Env (DB, CACHE, все секреты из §7 ТЗ; PAYMENT_AMOUNT опционален)
5. src/types.ts — Listing, User, Session, Log, Like, AdminLink
6. src/config.ts — порт CATEGORIES, STOP_WORDS, AVATAR_EMOJIS, CONTACT_TYPES, QR_PAYMENT_METHODS из Code.gs; getConfig(): paymentAmountVnd с fallback PAYMENT_AMOUNT (§7)
7. src/db/schema.sql — полная схема из §5 ТЗ
8. src/db/migrations/001_init.sql — копия schema.sql
9. src/utils/response.ts — jsonResponse(obj), corsHeaders(), handleOptions()

Не пиши бизнес-логику — только scaffold.
```

**Выполнено:** все пункты + stub `src/index.ts` для wrangler; D1/KV/secrets — см. «Ход выполнения».

---

### Промпт 2 — Главный роутер

```
В worker/src/index.ts создай entry point.

export default {
  async fetch(request, env, ctx) { ... },
  async scheduled(event, env, ctx) { ... }
}

fetch:
- OPTIONS → cors preflight
- GET / → "OK"
- GET /api → query action=getLikes|toggleLike → handlers/likes.ts
- POST / → если body содержит update_id → handleTelegramUpdate (КРИТИЧНО: текущий webhook URL)
- POST /webhook → JSON update → handleTelegramUpdate (алиас)
- POST /api → JSON body → routeApiAction (handlers/api.ts)
- иначе 404

scheduled → import dailyMaintenance from handlers/maintenance.ts

routeApiAction — switch по body.action (все 8 actions из §6 ТЗ).

Webhook dedup: KV ключ upd_{update_id}, TTL 21600, если exists → return OK.

Распознавание Telegram update на POST /: JSON с полем update_id (не путать с POST /api).

CORS: Access-Control-Allow-Origin: *
```

---

### Промпт 3 — Аутентификация и валидация ✅ *(28.05.2026)*

```
Порт из Code.gs в worker/src/utils/:

auth.ts:
- validateInitData(initData, botToken) → boolean, auth_date max 86400 sec — для POST /api (как validateInitData в Code.gs)
- validateTelegramInitData(initData, botToken) → { valid, userId?, error? }, auth_date max 3600 sec — для GET лайков (как validateTelegramInitData в Code.gs)
- validateMiniAppRequest(body, env) → проверка secret + validateInitData (как в handleFormSubmission)

validation.ts:
- validateListingForm(body) — порт validateListingForm из Code.gs
- checkStopWords встроить в validation

description.ts:
- normalizeDescriptionInput — trim + нормализация переносов (как Code.gs, вызывается до encode)
- encodeDescriptionNewlines (= normalizeDescriptionInput + замена \n на \\n), decodeDescriptionNewlines — из gas/description_newlines_snippet.gs + Code.gs

helpers.ts:
- generateId(tgId), formatDateRu, paymentMethodLabel, findQrMethodByKey
- getUserListingMode, findBlockingListing, buildPaidModeBanner — порт из Code.gs
- ensureUser(tgId, username, firstName) — INSERT OR IGNORE users

sessions.ts (handlers):
- getSession, upsertSession, clearSession — D1 таблица sessions
- parseSessionDraft, parsePinSessionDraft

logAction(tgId, action, details) → INSERT logs

Коды ошибок initData — строго per-handler (таблица §6): 'Invalid initData' vs 'Invalid_initData'.
validateMiniAppRequest — новая обёртка Worker (в GAS нет отдельной функции; логика как в handleFormSubmission).
```

**Выполнено 28.05.2026:**

| Файл | Функции |
|---|---|
| `utils/auth.ts` | `validateInitData` (86400s, Web Crypto HMAC), `validateTelegramInitData` (3600s + userId), `validateMiniAppRequest` (secret + initData, per-handler error code) |
| `utils/validation.ts` | `validateListingForm`, встроенный `checkStopWords` |
| `utils/description.ts` | `normalizeDescriptionInput`, `encodeDescriptionNewlines`, `decodeDescriptionNewlines` |
| `utils/helpers.ts` | `generateId`, `formatDateRu`, `paymentMethodLabel`, `findQrMethodByKey`, `findBlockingListing`, `buildPaidModeBanner`, `ensureUser`, `getUserFreeUsed`, `getUserListingMode`, `logAction` |
| `handlers/sessions.ts` | `getSession`, `upsertSession`, `clearSession`, `parseSessionDraft`, `parsePinSessionDraft`, `inferSessionType` |

**Детали реализации:**
- HMAC через `crypto.subtle` (не Node `crypto`) — порядок ключей как в GAS: `HMAC("WebAppData", botToken)` → secret_key → hash data_check_string
- `validateMiniAppRequest` принимает `initDataError: 'Invalid initData' \| 'Invalid_initData'` для per-handler кодов (§6)
- `findBlockingListing` — SQL + JS-логика приоритета active > on_moderation по `submitted_at` (как GAS)
- `upsertSession` — `INSERT … ON CONFLICT DO UPDATE` (замена Sheets upsert)
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 4 (telegram-api service).

---

### Промпт 4 — Telegram API service ✅ *(28.05.2026)*

```
worker/src/services/telegram-api.ts

Функции (fetch к api.telegram.org):
- sendMessage(chatId, text, replyMarkup?, env)
- sendPhoto(chatId, fileId, caption, replyMarkup?, env)
- answerCallbackQuery(callbackQueryId, text?, env)
- editMessageReplyMarkup(chatId, messageId, replyMarkup, env)

moderationKeyboard(listingId), pinModerationKeyboard(listingId, duration) — порт из Code.gs.

Обработка ошибок: log в D1 logs, не бросать uncaught в webhook.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт |
|---|---|
| `services/telegram-api.ts` | `sendMessage`, `sendPhoto`, `answerCallbackQuery`, `editMessageReplyMarkup`, `moderationKeyboard`, `pinModerationKeyboard`, типы `TelegramReplyMarkup`, `InlineKeyboardButton` |

**Детали реализации:**
- Внутренние `telegramRequest` + `sendMessageRaw` + `notifyAdminDebug` — как в Code.gs (`telegramRequest`, fallback без клавиатуры при ошибке keyboard)
- `sendMessage` с `replyMarkup`: при ошибке keyboard → `logAction` + `notifyAdminDebug` админу → повтор без клавиатуры
- Все публичные методы **не бросают** исключения наружу; сбои Telegram API → `logAction(0, 'error', …)` в D1
- `editMessageReplyMarkup`: пустая клавиатура `{ inline_keyboard: [] }` если `replyMarkup` не передан (как Code.gs)
- Callback data: `approve_`, `reject_`, `pin_approve_{id}_{duration}`, `pin_reject_` — идентично GAS
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 5 (Listings API).

---

### Промпт 5 — Listings API ✅ *(28.05.2026)*

```
worker/src/handlers/listings.ts — порт из Code.gs:

1. handleGetListings(body, env)
   - secret + initData опционален (валидировать initData только если передан — как Code.gs)
   - category обязательна, из CATEGORIES
   - SQL: status='active' AND category=?
   - decodeDescriptionNewlines для description
   - сортировка pinned first:
     CASE WHEN pin_status='pinned' THEN 1 ELSE 0 END DESC,
     pinned_at DESC, created_at DESC
     (НЕ pin_status DESC — строковая сортировка даст regular первым!)
   - return { ok: true, listings } — БЕЗ LIMIT/OFFSET

2. handleGetMyListings(body, env)
   - validateMiniAppRequest (initData обязателен)
   - все listings tg_id, все status
   - сортировка как в Code.gs (active first, submitted_at DESC)

3. handleSubmitListing(body, env) — handleFormSubmission
   - getUserListingMode → если paid_mode: { ok:false, error:'use_paid_flow', paid_mode:true, message: banner }
   - INSERT listings on_moderation, payment_status free
   - notify admin sendMessage + moderationKeyboard
   - return { ok: true, message }

4. handleArchiveListing(body, env)
   - только owner, только status active → archived

Формат ответов — только { ok: true/false }, НЕ success.
server_config: проверять BOT_TOKEN, не SHEET_ID.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт |
|---|---|
| `handlers/listings.ts` | `handleGetListings`, `handleGetMyListings`, `handleSubmitListing`, `handleArchiveListing` |

**Детали реализации:**
- `checkServerConfig` — только `env.BOT_TOKEN` (не `SHEET_ID`)
- `handleGetListings` — secret обязателен если задан `WEBAPP_SECRET`; initData валидируется **только если передан**; ошибка `Invalid_initData`; SQL `WHERE status='active' AND category=?` **без LIMIT**; сортировка pinned через `CASE WHEN pin_status='pinned' THEN 1 ELSE 0 END DESC`, `pinned_at DESC`, `created_at DESC`
- `handleGetMyListings` — `validateMiniAppRequest` + `Invalid_initData`; все статусы по `tg_id`; сортировка `active → on_moderation → archived → rejected`, затем `submitted_at DESC`
- `handleSubmitListing` — `getUserListingMode` → `use_paid_flow`; INSERT `on_moderation` / `payment_status=free`; админу `sendMessage` + `moderationKeyboard`; `saveAdminLink` в D1 `admin_links`; пользователю подтверждение
- `handleArchiveListing` — только owner, только `active` → `archived`; коды `missing_params`, `not_found`, `forbidden`, `wrong_status` как в GAS
- `mapCatalogListing` / `mapMyListing` — `decodeDescriptionNewlines`, `DEFAULT_AVATAR_EMOJI`, даты `created_at`/`expires_at`/`submitted_at` в ISO
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 6 (Payment API).

---

### Промпт 6 — Payment API ✅ *(28.05.2026)*

```
worker/src/handlers/payment.ts — порт из Code.gs:

1. handleCheckListingStatus(body, env)
   - getUserListingMode(tgId, username, firstName)
   - return { ok:true, has_listing, paid_mode, can_submit_free, banner, listing? }

2. handleSelectPaymentMethod(body, env)
   - validate form, getUserListingMode — если !paid_mode → free_listing_available
   - findQrMethodByKey, check file_id in env
   - generateId, upsertSession state=await_payment_proof, draft JSON type=paid_listing
   - sendPhoto QR пользователю
   - return { ok:true, message }

Используй services/telegram-api.ts для sendMessage, sendPhoto.
server_config: проверять BOT_TOKEN, не SHEET_ID.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт |
|---|---|
| `handlers/payment.ts` | `handleCheckListingStatus`, `handleSelectPaymentMethod` |

**Детали реализации:**
- `checkServerConfig` — только `env.BOT_TOKEN` (не `SHEET_ID`)
- `handleCheckListingStatus` — `validateMiniAppRequest` + `'Invalid initData'` (с пробелом, §6); `getUserListingMode`; ответ `{ ok, has_listing, paid_mode, can_submit_free, banner }`; при blocking — `listing` с `expires_at` через `formatDateRu`
- `handleSelectPaymentMethod` — валидация формы (`validateListingForm`); если `!paid_mode` → `free_listing_available`; `findQrMethodByKey` + проверка QR из `getConfig(env).qr[propertyKey]`; сессия `await_payment_proof`, draft `{ type: 'paid_listing', … }` через `upsertSession`; `sendPhoto` с текстом суммы VND/crypto; `logAction('select_payment', methodKey|listingId)`
- Коды ошибок: `invalid_payment_method`, `qr_not_configured`, `free_listing_available` — как в Code.gs
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 7 (Pins API).

---

### Промпт 7 — Pins API ✅ *(28.05.2026)*

```
worker/src/handlers/pins.ts — порт handleGetPinPrices, handleSelectPinPaymentMethod, pinApproveListing, pinRejectListing из Code.gs.

handleGetPinPrices → { ok:true, week:{vnd,crypto}, month, lifetime }
(secret не проверяется; initData опционален — как Code.gs)

handleSelectPinPaymentMethod:
- проверки: active, owner, not already_pinned
- session await_pin_proof, session_type pin
- sendPhoto QR + message

Экспорт pinApproveListing, pinRejectListing для telegram.ts callbacks.
getPinExpiresDate, getPinDurationLabel — порт helpers.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт |
|---|---|
| `handlers/pins.ts` | `handleGetPinPrices`, `handleSelectPinPaymentMethod`, `pinApproveListing`, `pinRejectListing` |
| `utils/helpers.ts` | `getPinDurationLabel`, `getPinDurationShortLabel`, `getPinExpiresDate`, `getPinPriceByDuration` |

**Детали реализации:**
- `checkServerConfig` — только `env.BOT_TOKEN` (не `SHEET_ID`)
- `handleGetPinPrices` — **secret не проверяется**; initData валидируется **только если передан**; ошибка `Invalid_initData`; ответ `{ ok, week, month, lifetime }` с ценами из `getConfig(env)`
- `handleSelectPinPaymentMethod` — `validateMiniAppRequest` + `'Invalid initData'` (с пробелом, §6); проверки `missing_listing_id`, `invalid_pin_duration`, `not_found`, `not_active`, `forbidden`, `already_pinned`; сессия `await_pin_proof`, `session_type=pin`, draft `{ listing_id, pin_duration, payment_method, price_label }`; `sendPhoto` с caption + `sendMessage` с ожиданием чека; `logAction('select_pin_payment', …)`
- `pinApproveListing` — D1 `UPDATE pin_status='pinned'`, `pinned_at`, `pin_expires_at` (`'lifetime'` или ISO +7/+30 дней); уведомление пользователю; `editMessageReplyMarkup` + `answerCallbackQuery` — для callbacks в Промпте 9
- `pinRejectListing` — отказ пользователю, очистка клавиатуры, `logAction('pin_rejected', …)`
- Pin helpers в `helpers.ts` — идентично `getPinDurationLabel`, `getPinDurationShortLabel`, `getPinExpiresDate`, `getPinPriceByDuration` из Code.gs
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 9 (Telegram bot).

---

### Промпт 8 — Likes + KV ✅ *(28.05.2026)*

```
worker/src/handlers/likes.ts — порт getLikesForUser + handleLike из Code.gs.

handleGetLikes(request, env):
- validateTelegramInitData из query (auth_date max 3600 sec — НЕ 86400!)
- KV likes_all TTL 180 — кэш массива {cardId, total, userIds[]}
- SQL fallback если cache miss
- return { success: true, likes: [{ cardId, total, likedByMe }] }

handleToggleLike(request, env):
- validateTelegramInitData, cardId, type like|unlike (auth_date max 3600 sec)
- D1 batch: INSERT OR IGNORE / DELETE
- invalidate KV likes_all
- return { success: true, newCount }

ВАЖНО: формат как catalog.html initLikes/sendLike — НЕ counts/myLikes.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт |
|---|---|
| `handlers/likes.ts` | `handleGetLikes`, `handleToggleLike` |

**Детали реализации:**
- `handleGetLikes` — query `initData` → `validateTelegramInitData` (TTL **3600 сек**, не 86400); при ошибке `{ success: false, error: 'unauthorized' }`; KV `likes_all` TTL **180 сек** — массив `{ cardId, total, userIds[] }` без `likedByMe`; при cache miss — `SELECT listing_id, tg_id FROM likes`, группировка в JS; ответ `{ success: true, likes: [{ cardId, total, likedByMe }] }` — формат `catalog.html` initLikes
- `handleToggleLike` — query `initData`, `cardId`, `type` (`like`|`unlike`); те же проверки auth; коды `missing_card_id`, `invalid_type`, `unauthorized`; `env.DB.batch`: `INSERT OR IGNORE` / `DELETE` + `SELECT COUNT(*)` → `newCount`; `CACHE.delete('likes_all')`; ответ `{ success: true, newCount }` — формат sendLike
- Роутинг уже был в `index.ts` (`GET /api?action=getLikes|toggleLike`) — без изменений
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 9 (Telegram bot).

---

### Промпт 9 — Telegram bot (полный порт) ✅ *(28.05.2026)*

```
worker/src/handlers/telegram.ts (использует services/telegram-api.ts из Промпта 4)

handleTelegramUpdate(update, env) — порт handleTelegramUpdate + handleCallbackQuery из Code.gs:

Callbacks:
- contact_admin → startContactAdmin
- approve_{id}, reject_{id} — только ADMIN_TG_ID
- pin_approve_{id}_{duration}, pin_reject_{id}

Messages:
- /start → sendWelcome + mainMenuKeyboard (web_app catalog URL из MINI_APP_URL)
- Admin: /qr_status, /qr_help, /admin — показывают статус QR из env secrets
- handleAdminQrPhoto — v1: подсказка «используйте wrangler secret put» (hot-reload через KV — v2)
- handleAdminReply — reply_to_message → findAdminLink → send user
- handlePaymentProofPhoto — paid_listing draft → INSERT listing paid → forward to admin
- handlePinProofPhoto — forward to admin with pin keyboard
- forwardContactToAdmin — contact_admin session
- handleUserTextMessage

admin_links: saveAdminLink, findAdminLink — D1

Всегда answerCallbackQuery. editMessageReplyMarkup после модерации.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт / изменения |
|---|---|
| `handlers/telegram.ts` | `handleTelegramUpdate`, `isDuplicateTelegramUpdate`, `saveAdminLink`, `findAdminLink` + внутренние handlers |
| `utils/helpers.ts` | `setUserFreeUsed` (для approve free listing) |
| `handlers/listings.ts` | `saveAdminLink` вынесен в `telegram.ts`, импорт оттуда |

**Детали реализации:**
- `handleTelegramUpdate` — порядок как в Code.gs: callback → admin reply → photo (QR hint / contact / payment proof) → text commands / user text; ошибки → `logAction` + уведомление админу
- Callbacks: `contact_admin` (все пользователи); `approve_` / `reject_` / `pin_approve_` / `pin_reject_` — только `ADMIN_TG_ID`; pin callbacks делегируют в `pinApproveListing` / `pinRejectListing` (Промпт 7)
- `approveListing` / `rejectListing` — D1 UPDATE + `setUserFreeUsed` при `payment_status=free`; `editMessageReplyMarkup` + `answerCallbackQuery`
- `/start` → `sendWelcome` + `mainMenuKeyboard` с `web_app` URL из `MINI_APP_URL` (`getMiniAppCatalogUrl`)
- Admin: `/qr_status`, `/qr`, `/qr_help`, `/admin` — статус QR из `getConfig(env).qr` (secrets)
- `handleAdminQrPhoto` — **v1**: не сохраняет file_id, показывает подсказку `wrangler secret put {propertyKey}` + file_id из фото
- `handleAdminReply` — `findAdminLink` по `reply_to_message.message_id` → текст/фото/document пользователю
- `handlePaymentProofPhoto` — сессия `await_payment_proof`: draft `paid_listing` → INSERT listing `on_moderation`/`paid` + чек админу с `moderationKeyboard`; legacy draft → чек + существующая анкета
- `handlePinProofPhoto` — сессия `await_pin_proof`/`pin` → `pinModerationKeyboard`
- `forwardContactToAdmin` — сессия `contact_admin`, `saveAdminLink` type `contact`
- `admin_links` — `INSERT` / `SELECT BY admin_message_id` (PK в D1)
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 10 (Cron maintenance).

---

### Промпт 10 — Cron maintenance ✅ *(28.05.2026)*

```
worker/src/handlers/maintenance.ts — порт dailyListingsMaintenance из Code.gs:

Блок A: active + expires_at <= now → archived + notify
Блок B: pin expired (not lifetime) → pin_status regular + notify
Блок C: pin expires in 20–28 hours → warning (каждый cron в этом окне — как GAS, без dedup)

Каждая строка в try/catch. Итог logAction daily_maintenance summary.
```

**Выполнено 28.05.2026:**

| Файл | Экспорт |
|---|---|
| `handlers/maintenance.ts` | `dailyMaintenance` |

**Детали реализации:**
- `dailyMaintenance` — вызывается из `index.ts` → `scheduled` → `ctx.waitUntil(dailyMaintenance(env))`; cron `0 0 * * *` UTC (= 07:00 Nha Trang)
- SQL prefetch: `WHERE status='active' OR pin_status='pinned'` — только строки, которые могут попасть в блоки A/B/C
- **Блок A:** `expires_at <= now` → `UPDATE status='archived'` + `sendMessage` (30 дней) + `logAction('archive')`
- **Блок B:** `pin_status='pinned'`, `pin_expires_at` не `lifetime`, дата ≤ now → `pin_status='regular'`, `pinned_at=NULL`, `pin_expires_at=NULL` + уведомление + `logAction('pin_expired')`
- **Блок C:** окно **20 ≤ hoursLeft < 28** — предупреждение + `logAction('pin_expiry_warning')`; **без dedup** (каждый cron в окне, как GAS)
- Каждая строка в `try/catch` → `logAction(0, 'error', 'dailyListingsMaintenance row N: …')`
- Итог: `logAction(0, 'daily_maintenance', '{ archived: N, pins_removed: N, warnings_sent: N }')`
- Тексты сообщений и `formatDateRu` — идентично `dailyListingsMaintenance` в Code.gs
- `npx tsc --noEmit` — ✅ без ошибок

**Следующий шаг:** Промпт 11 (catalog.html — `GAS_URL` → `API_URL`).

---

### Промпт 11 — Обновление catalog.html ✅ *(28.05.2026)*

```
Минимальные правки catalog.html:

1. Переименовать GAS_URL → API_URL:
   var API_URL = 'https://tg-networking-nhatrang.albertkoall.workers.dev';

2. apiPost: fetch(API_URL + '/api', { method:'POST', body: JSON.stringify(payload) })

3. initLikes: API_URL + '/api?action=getLikes&initData=...'

4. sendLike: API_URL + '/api?action=toggleLike&initData=...&cardId=...&type=...'

5. WEBAPP_SECRET — то же значение что wrangler secret (комментарий: синхронизировать при смене)

6. Не менять buildPayload, UI, action names, обработку data.ok / data.success

7. credentials не добавлять (default omit)
```

**Выполнено 28.05.2026:**

| Изменение | Было | Стало |
|---|---|---|
| CONFIG | `GAS_URL` → GAS `/exec` | `API_URL` → `https://tg-networking-nhatrang.albertkoall.workers.dev` |
| `apiPost` | `fetch(GAS_URL, …)` | `fetch(API_URL + '/api', …)` |
| `initLikes` | `GAS_URL + '?action=getLikes&…'` | `API_URL + '/api?action=getLikes&…'` |
| `sendLike` | `GAS_URL + '?action=toggleLike&…'` | `API_URL + '/api?action=toggleLike&…'` |
| `WEBAPP_SECRET` | `'getting_more_money'` | без изменения значения; комментарий про sync с wrangler |
| 404 в `apiErrorMessage` | текст про GAS_URL | текст про `API_URL` |

**Не менялось (по ТЗ):** `buildPayload`, UI, имена `action`, обработка `data.ok` / `data.success`, `credentials` в fetch.

**Следующий шаг:** Промпт 12 (`DEPLOY_GUIDE_CF.md` + `wrangler deploy` + E2E).

---

### Промпт 12 — Деплой и E2E ✅ *(28.05.2026)*

```
Создай DEPLOY_GUIDE_CF.md с пошаговой инструкцией:

1. wrangler login, npm install в worker/
2. wrangler d1 create + wrangler kv namespace create CACHE + schema execute
3. wrangler secret put — полный список из §7
4. wrangler deploy
5. Webhook — перерегистрация НЕ обязательна, если Worker принимает POST / (текущий URL).
   Опционально явный путь: curl setWebhook url=https://tg-networking-nhatrang....workers.dev/webhook
6. Обновить catalog.html API_URL + push GitHub Pages

E2E чеклист:
- GET / → OK
- POST / с fake update (update_id) → OK, бот отвечает
- POST /api {action:get_listings, ...} через Mini App
- submit_listing free + approve в боте
- check_listing_status paid_mode после free_used
- select_payment_method + photo proof
- getLikes + toggleLike
- pin flow
- contact_admin + admin reply
- cron: wrangler triggers schedule (manual invoke)

Rollback секция из §9 ТЗ.
```

**Выполнено 28.05.2026:**

| Артефакт / действие | Результат |
|---|---|
| `DEPLOY_GUIDE_CF.md` | Создан в корне репо: части A–G (setup, deploy, E2E, cutover, rollback) |
| `npx tsc --noEmit` | ✅ без ошибок |
| `npx wrangler deploy` | ✅ `https://tg-networking-nhatrang.albertkoall.workers.dev` |
| Version ID | `368c2c4c-5ec2-4f3d-9e73-f126284d6794` |
| Remote override | Локальный `wrangler.toml` заменил Dashboard: `GAS_URL` → `MINI_APP_URL`, cron `0 0 * * *` |
| Bindings после deploy | D1 `DB`, KV `CACHE`, var `MINI_APP_URL` |

**Smoke E2E (автоматически, PowerShell/curl):**

| Тест | Результат |
|---|---|
| `GET /` | `200`, body `OK` |
| `POST /` fake update `update_id=999999001` | `200`, `OK` |
| Повтор `update_id=999999001` (dedup KV) | `200`, `OK` |
| `POST /webhook` `{"ping":true}` | `200`, `OK` |
| `OPTIONS /api` | `204`, `Access-Control-Allow-Origin: *` |
| `POST /api` `get_listings` + category `Другое` + secret | `{ ok: true, listings: [] }` |
| `POST /api` `unknown_action` | `{ ok: false, error: "unknown_action" }` |
| `POST /api` неверный secret | `{ ok: false, error: "invalid_secret" }` |
| `GET /api?action=getLikes` без initData | `{ success: false, error: "unauthorized" }` |

**Ручные E2E (Telegram / Mini App)** — по чеклисту в `DEPLOY_GUIDE_CF.md` §D2; выполняются оператором после push GitHub Pages (Фаза B).

**Cron:** триггер `0 0 * * *` задеплоен; ручной invoke через Dashboard / `wrangler tail` при первом срабатывании.

**Не выполнялось в этой сессии:** push `catalog.html` на GitHub Pages (Фаза B); полный прогон submit/approve/pin в живом боте.

**Следующий шаг:** Фаза B — push `catalog.html` в GitHub → проверка Mini App + ручной E2E §D2.

---

## 11. Оценка сложности

| Этап | Сложность | Время с Cursor |
|---|---|---|
| Промпт 1: scaffold | ★☆☆ | 15 мин |
| Промпт 2: роутер | ★★☆ | 25 мин |
| Промпт 3: auth + validation | ★★★ | 45 мин |
| Промпт 4: telegram service | ★★☆ | 25 мин |
| Промпт 5: listings | ★★☆ | 45 мин |
| Промпт 6: payment | ★★☆ | 35 мин |
| Промпт 7: pins | ★★☆ | 35 мин |
| Промпт 8: likes | ★★☆ | ✅ 28.05.2026 |
| Промпт 9: telegram bot | ★★★ | ✅ 28.05.2026 |
| Промпт 10: maintenance | ★★☆ | ✅ 28.05.2026 |
| Промпт 11: frontend | ★☆☆ | ✅ 28.05.2026 |
| Промпт 12: deploy + E2E | ★★☆ | ✅ 28.05.2026 |
| **Итого** | | **~6–8 часов** |

---

## 12. Чеклист перед стартом

```
✅ Cloudflare аккаунт, план Free
✅ Node.js 18+ установлен
✅ wrangler login выполнен
✅ BOT_TOKEN, ADMIN_TG_ID, QR file_id — загружены в wrangler secrets
✅ WEBAPP_SECRET — синхронизирован catalog.html + wrangler secret
✅ Cursor: контекст Code.gs, catalog.html, этот ТЗ
✅ Промпт 12: `DEPLOY_GUIDE_CF.md` + `wrangler deploy` + smoke E2E
✅ Фаза B: push GitHub Pages + live `API_URL` проверен
⬜ Фаза C: 2 недели `wrangler tail`, GAS не удалять; ручной E2E в боте
✅ Миграция Sheets — пропустить (пустая D1)
```

---

## 13. Альтернативы (справка)

| Вариант | Вердикт |
|---|---|
| Supabase | Новый аккаунт, pause на free — не оптимально |
| Firebase | NoSQL, дороже, Google lock-in |
| PlanetScale | Free tier убран |
| **CF Workers + D1** | ✅ Оптимально для проекта |

---

## 14. Важные нюансы (для Cursor)

- **Не изобретать API** — копировать контракт из §6.
- **get_listings без LIMIT** — пагинация на клиенте (`LISTINGS_PER_PAGE = 20`).
- **Два формата успеха:** POST → `ok`, likes GET → `success`.
- **Два TTL initData:** POST `/api` → 86400 сек; GET лайки → 3600 сек (§8).
- **Webhook на корне `/`** — обязателен для совместимости с текущим `setWebhook` URL.
- **Сортировка pinned** — только через `CASE WHEN`, не `pin_status DESC` (§8).
- **QR file_id:** хранятся как wrangler secrets; admin `/qr_status` только показывает задан/нет (обновление — `wrangler secret put` или admin photo → KV `qr_*` — опционально v2).
- **republish во фронте** — отдельного API action нет; кнопка «Опубликовать снова» вызывает `goToForm()` с prefill → `submit_listing` / paid flow.
- **Worker name** `tg-networking-nhatrang` — не менять без обновления webhook и catalog.html.
- **GAS** остаётся read-only архивом до завершения Фазы C.
- **initData error** — per-handler таблица §6; не унифицировать.
- **normalizeDescriptionInput** — обязателен до encode; иначе стоп-слова/валидация расходятся с GAS.
- **PAYMENT_AMOUNT** — legacy fallback для VND в `config.ts` (§7).
- **wrangler kv** — `wrangler kv namespace create CACHE`, не `kv:namespace` (§9).

---

## 15. Результаты аудита (v2.2)

Проверка ТЗ против `Code.gs`, `catalog.html`, webhook и GitHub Pages. Внесённые исправления:

| # | Проблема | Решение в ТЗ |
|---|---|---|
| 1 | Webhook зарегистрирован на **корень** Worker, не `/webhook` | `POST /` + `POST /webhook` (§3, Промпт 2, §9) |
| 2 | `ORDER BY pin_status DESC` даёт `regular` первым | `CASE WHEN pin_status='pinned' THEN 1 ELSE 0 END DESC` (§8, Промпт 5) |
| 3 | Два TTL initData в Code.gs (86400 vs 3600) | Разделены в §8, Промпт 3, Промпт 8 |
| 4 | telegram-api шёл после handlers (был Промпт 11) | Перенесён в **Промпт 4** (§10, §11) |
| 5 | `server_config` в GAS проверяет `SHEET_ID` | В Worker — только `BOT_TOKEN` (§8, Промпты 5–6) |
| 6 | Pin warning «один раз» — неверно | Как в GAS: каждый cron в окне 20–28 ч (§8, Промпт 10) |
| 7 | `get_listings`: initData опционален | Зафиксировано в §6, Промпт 5 |
| 8 | `Invalid initData` vs `Invalid_initData` | Фронт нормализует пробелы → `_` (§6) |
| 9 | QR через фото админа — regression v1 | Документировано: secrets + опционально KV v2 (§8, §14) |
| 10 | `index.html` | Workflow копирует из `catalog.html` — отдельный файл не нужен (§4) |
| 11 | Два варианта `Invalid initData` / `Invalid_initData` по handlers | Таблица per-handler в §6, §8, Промпт 3 |
| 12 | `normalizeDescriptionInput` не был в Промпте 3 | Явно в §8, Промпт 3, §14 |
| 13 | Legacy `PAYMENT_AMOUNT` в GAS `getConfig()` | Fallback в §7, `config.ts`, §14 |
| 14 | Устаревшая команда `wrangler kv:namespace create` | Исправлено на `wrangler kv namespace create` (§9, Промпт 12) |

**Вердикт:** ТЗ согласовано с проектом, готово к реализации.

---

*Промпты 1–12 ✅, Фаза B ✅. **Портфолио v1.3 ✅** (29.05.2026). **Следующий шаг: Фаза C** — мониторинг 2 недели + ручной E2E в Telegram (`DEPLOY_GUIDE_CF.md` §D2, §D2a).*

---

## 16. Журнал: портфолио v1.3 *(29.05.2026)*

> Источник правды: `portfolio_TZ.md` v1.3. Фазы 1–6 выполнены по промптам §16.

| Компонент | Статус | Примечание |
|---|---|---|
| R2 `networking-portfolio` | ✅ | binding `PORTFOLIO` в wrangler.toml |
| D1 `002_portfolio.sql` | ✅ | `archived_at`, `listing_media` |
| D1 `003_backfill_archived_at.sql` | ✅ | backfill из `expires_at` |
| API multipart + portfolio handlers | ✅ | `upload_portfolio`, `upload_portfolio_staging`, `get_portfolio` |
| `submit_listing` | ✅ | `listing_id` всегда; `portfolio_enabled` → `deferred_notify` |
| Frontend `catalog.html` | ✅ | форма, popup, paid staging |
| `portfolio.html` + Pages workflow | ✅ | admin Web App |
| Модерация, cron purge, rules | ✅ | фаза 5 |
| `DEPLOY_GUIDE_CF.md` | ✅ | R2, миграции 002+003, smoke §13 (промпт 6) |
| Smoke регрессии (29.05.2026) | ✅ | `GET /`, `get_listings` + `has_portfolio`, `get_pin_prices`, `getLikes` unauthorized, webhook dedup |

**Worker deploy (фаза 6):** Version `b6db5d6e-4b38-4d88-adf5-87de7ac921f4` (29.05.2026).
