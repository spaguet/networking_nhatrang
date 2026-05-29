# Деплой: Нетворкинг Нячанг → Cloudflare Workers + D1

> **Связанные документы:**
> - `migration_to_cf_d1_TZ.md` — полное ТЗ миграции, API-контракт, промпты
> - `portfolio_TZ.md` — портфолио v1.3 (R2, D1 `listing_media`, multipart upload)
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
```

Ожидаемые таблицы: `users`, `listings`, `sessions`, `logs`, `likes`, `admin_links`, **`listing_media`**.  
В `listings` — колонка **`archived_at`** (для purge архива > 90 дней).

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
| `ADMIN_TG_ID` | Числовой Telegram ID админа |
| `WEBAPP_SECRET` | **Тот же** ключ, что в `catalog.html` (`WEBAPP_SECRET`) |
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

Проверка списка секретов (без значений):

```powershell
npx wrangler secret list
```

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

Текущий webhook уже указывает на корень Worker (`POST /`). После деплоя **перерегистрация не обязательна**, если URL не менялся.

Проверить webhook:

```powershell
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

Опционально явный путь `/webhook`:

```powershell
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://tg-networking-nhatrang.albertkoall.workers.dev/webhook"
```

---

## Часть C. Frontend (GitHub Pages)

В `catalog.html` (корень репо):

```javascript
var API_URL = 'https://tg-networking-nhatrang.albertkoall.workers.dev';
```

- POST: `fetch(API_URL + '/api', { method: 'POST', body: JSON.stringify(payload) })`
- GET лайки: `API_URL + '/api?action=getLikes&initData=...'`
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
$payload = '{"action":"get_listings","category":"services","secret":"<WEBAPP_SECRET>"}'
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

**POST /api** — `get_pin_prices` (регрессия pin):

```powershell
$payload = '{"action":"get_pin_prices"}'
Invoke-WebRequest -Uri "https://tg-networking-nhatrang.albertkoall.workers.dev/api" -Method POST -Body $payload -ContentType "application/json" -UseBasicParsing
# Ожидание: { "ok": true, "week": {...}, "month": {...}, "lifetime": {...} }
```

**POST /api** — `get_listings` с полями портфолио:

```powershell
$payload = '{"action":"get_listings","category":"Другое","secret":"<WEBAPP_SECRET>"}'
# Ожидание: { "ok": true, "listings": [{ ..., "has_portfolio": false|true, "portfolio_count": N }] }
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
npx wrangler deploy
```

Затем push `catalog.html` и пройти E2E §D.

---

*Создано в рамках миграции GAS → CF (Промпт 12, `migration_to_cf_d1_TZ.md`). Обновлено 29.05.2026 — портфолио v1.3 (R2, D1 002+003, smoke §13).*
