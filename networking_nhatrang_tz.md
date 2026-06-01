# ТЗ: Нетворкинг Нячанг — Telegram Mini App
### Версия для разработки в Cursor

---

## 0. Текущий статус проекта

| Компонент | Статус |
|---|---|
| Фронтенд — `catalog.html` (каталог специалистов) | ✅ Готово |
| Фронтенд — `index.html` (форма анкеты, `?form=1`) | ✅ Готово |
| Система лайков (`Code.gs` + `catalog.html`) | ✅ Готово — см. §13, детали в `likes_system_TZ.md` |
| **Избранное** (`worker` + `catalog.html`) | ✅ Готово — `favorites_system_TZ.md`, деплой `DEPLOY_GUIDE_CF.md` §D2c |
| **Админ-профиль** (grand_admin + admin, Mini App, D1) | ✅ Готово — `admin_profile_TZ.md` v1.3, деплой `DEPLOY_GUIDE_CF.md` §D2d |
| **Редактирование мини-резюме** (3 правки, `edit_pending`, Worker + D1) | ✅ Готово — `listing_edit_TZ.md` v1.5, деплой `DEPLOY_GUIDE_CF.md` §D2e |
| Платные закреплённые карточки (`Code.gs` + `catalog.html`) | ✅ Готово — см. §15, детали в `pinned_listings_TZ.md` |
| GAS Backend (`Code.gs` — анкеты, модерация, каталог, лайки, закрепления) | ✅ Готово (+ QR, contact admin, pin-flow) |
| Google Sheets (листы users, listings, sessions, logs) | ⏳ Запустить `setupSheets()` в GAS |
| Google Sheets (лист `Likes`) | ✅ Создаётся автоматически при первом лайке (`ensureLikesSheet()`) |
| Google Sheets (колонки pin в `listings`, `session_type` в `sessions`) | ✅ Миграция — `migratePinColumns()` (см. §15) |
| Script Properties + деплой Web App | ⏳ См. DEPLOY_GUIDE_RU.md (+ `PIN_PRICE_*` из §15) |
| Cloudflare Worker + Telegram Webhook | ⏳ `installCloudflareWebhook()` (см. §6) |
| GitHub Pages + MINI_APP_URL | ⏳ `catalog.html` + `index.html` на GitHub, BotFather |
| Триггер `dailyListingsMaintenance` | ⏳ `installDailyTrigger()` в GAS (заменяет `archiveExpiredListings`) |
| Деплой и E2E-тест лайков | ⏳ См. §13 и DEPLOY_GUIDE_RU.md §F |
| Деплой и E2E-тест закреплений | ⏳ См. §15 и `pinned_listings_TZ.md` §5–6 |
| Полный E2E-тест | ⬜ После деплоя |

**Доставка сообщений (май 2026):** webhook через Cloudflare Worker → GAS `/exec`. Polling **не используется**. `setupBotDelivery()`, `startFastPolling()`, `installPollingTrigger()` — **не запускать**.

---

## 1. Архитектура проекта

```
[Пользователь]
      │
      ▼
[Telegram Mini App — GitHub Pages]
      │
      ├── catalog.html — каталог специалистов + лайки ❤️ + закрепления 📌
      │     │  POST → get_listings, get_my_listings, archive_listing, get_pin_prices, select_pin_payment_method …
      │     │  GET  → getLikes, toggleLike (через doGet)
      │     └── Фаза 1: карточки → Фаза 2: лайки (фоном, ≤5 сек) → pin-flow из профиля
      │
      └── index.html?form=1 — форма анкеты
            │  POST → submit_listing, check_listing_status …
            ▼
[Cloudflare Worker]  ◄── [Telegram Webhook — только сообщения бота]
      │  POST (proxy update)
      ▼
[Google Apps Script — Code.gs]
      │
      ├── doPost(e) — webhook Telegram, Mini App POST-запросы
      │     ├── handleTelegramUpdate (модерация, QR, /start)
      │     ├── handleFormSubmission (анкета)
      │     ├── handleGetListings / handleGetMyListings (каталог)
      │     └── …
      │
      └── doGet(e) — GET-запросы Mini App (лайки)
            ├── ?action=getLikes&initData=…
            ├── ?action=toggleLike&initData=…&cardId=…&type=like|unlike
            └── без action → OK (health check)
      │
      ▼
[Google Sheets]
      users | listings | sessions | logs | Likes
      │
      └── CacheService: ключ likes_all (180 сек, инвалидируется при лайке)
                │
                ▼
        [Telegram Bot — уведомления, модерация]
```

**Стек:**
- **БД:** Google Sheets (5 листов, включая `Likes`)
- **Бэкенд:** Google Apps Script (GAS) — `doPost` + `doGet`
- **Кэш:** `CacheService` для счётчиков лайков
- **Блокировки:** `LockService` при записи лайка (защита от гонок)
- **Бот:** Telegram Bot API (GAS + Cloudflare Worker как webhook-прокси)
- **Фронтенд:** `catalog.html` + `index.html` на GitHub Pages
- **Безопасность лайков:** подписанный `initData` (HMAC-SHA256 + `BOT_TOKEN`), не `initDataUnsafe`

---

## 2. Структура Google Sheets

Создать одну таблицу с четырьмя листами:

### Лист 1: `users`

| Столбец | Тип | Описание |
|---|---|---|
| `tg_id` | Число (ключ) | Уникальный Telegram ID |
| `username` | Текст | Никнейм без @ (может быть пустым) |
| `first_name` | Текст | Имя из Telegram |
| `reg_date` | Дата/Время | Дата первого запуска |
| `free_used` | TRUE/FALSE | Использовано ли бесплатное размещение |

### Лист 2: `listings`

| Столбец | Тип | Описание |
|---|---|---|
| `listing_id` | Текст (ключ) | Уникальный ID: `tg_id + "_" + timestamp` |
| `tg_id` | Число | Telegram ID автора |
| `display_name` | Текст | Имя для отображения в витрине |
| `category` | Текст | Профессиональная категория (из списка ниже) |
| `description` | Текст | Текст анкеты / описание специализации |
| `experience` | Текст | Опыт / стаж (необязательно) |
| `contact_type` | Текст | Тип контакта: Telegram / Whatsapp / Email |
| `contacts` | Текст | Контакты (TG-ссылка, email, WhatsApp) |
| `status` | Текст | `on_moderation` / `active` / `rejected` / `archived` / `edit_pending` *(черновик правки, только D1; см. `listing_edit_TZ.md`)* |
| `payment_status` | Текст | `free` / `pending_check` / `paid` |
| `created_at` | Дата | Дата публикации (ставится при одобрении) |
| `expires_at` | Дата | Дата архивации (created_at + 30 дней) |
| `submitted_at` | Дата/Время | Дата отправки формы |
| `avatar_emoji` | Текст | Эмодзи-аватар карточки |
| `pin_status` | Текст | `regular` / `pinned` — статус закрепления (по умолчанию `regular`) |
| `pinned_at` | Дата / пусто | Дата установки закрепления (при одобрении модератором) |
| `pin_expires_at` | Текст | ISO-дата / `'lifetime'` / `''` — срок закрепления |
| `edits_remaining` | Число / пусто | Остаток правок на активной анкете (`3…0`; только D1, см. `listing_edit_TZ.md`) |
| `replaces_listing_id` | Текст / пусто | У черновика `edit_pending` — `listing_id` родительской **active** анкеты |

### Лист 3: `sessions`

> Хранит состояние диалога бота между сообщениями (GAS — stateless).

| Столбец | Тип | Описание |
|---|---|---|
| `tg_id` | Число (ключ) | Telegram ID |
| `state` | Текст | `await_payment_proof` / `await_pin_proof` / `contact_admin` |
| `draft` | Текст | JSON: `listing_id` (+ для pin: `pin_duration`, `price_label`) |
| `updated_at` | Дата/Время | Время последнего обновления |
| `session_type` | Текст | `payment` / `pin` / `contact` (если колонки нет — считать `payment`) |

### Лист 4: `logs`

| Столбец | Тип | Описание |
|---|---|---|
| `timestamp` | Дата/Время | Время события |
| `tg_id` | Число | Кто совершил действие |
| `action` | Текст | Описание (submit_form, approve, reject, archive, error) |
| `details` | Текст | Доп. данные (listing_id, текст ошибки) |

### Лист 5: `Likes` *(система лайков, создаётся автоматически)*

> Не входит в `setupSheets()`. Лист и заголовки создаёт `ensureLikesSheet()` при первом лайке.

| Столбец | Тип | Описание |
|---|---|---|
| `CardID` | Текст (ключ) | `listing_id` карточки из каталога |
| `TotalLikes` | Число | Количество лайков (= длина списка UserIDs) |
| `UserIDs` | Текст | Telegram ID через запятую: `123456789,987654321` |

**Ограничения:** ячейка Google Sheets — до 50 000 символов (~4 500 лайков на карточку). При `UserIDs.length > 4000` — предупреждение в лог GAS.

---

## 3. Профессиональные категории

> ⚠️ Уточни и замени список под свою реальную структуру из 12 категорий.

```javascript
const CATEGORIES = [
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
  'Другое'
];
```

---

## 4. Список стоп-слов

```javascript
const STOP_WORDS = [
  // Запрещённый контент
  'секс', 'эскорт', 'порно', 'интим', 'наркотики', 'вещества', 'закладки',
  'оружие', 'казино', 'ставки', 'вулкан', 'скам', 'развод', 'схема',
  'заработок 100к', 'заработок 200к', 'пассивный доход без вложений',
  // Запрет на вакансии (только анкеты специалистов, не работодателей)
  'вакансия', 'требуется сотрудник', 'ищем в команду', 'открыта позиция',
  'нужен специалист', 'работодатель', 'нанимаем'
];
```

---

## 5. Безопасное хранение секретов

**Никогда не вставлять токены в код.** Все чувствительные данные — через `PropertiesService`.

Пример обращения в коде:
```javascript
const BOT_TOKEN = PropertiesService.getScriptProperties().getProperty('BOT_TOKEN');
```

Полный список ключей Script Properties — в §6 (таблица переменных).

---

## 6. Архитектура доставки сообщений Telegram (актуальная)

### Статус
Webhook через Cloudflare Worker. Polling НЕ используется.
`setupBotDelivery()`, `startFastPolling()`, `installPollingTrigger()` — **НЕ ЗАПУСКАТЬ**.

---

### Переменные (Script Properties в GAS)

| Ключ | Что хранит | Пример |
|------|-----------|--------|
| `BOT_TOKEN` | Токен бота от @BotFather | `123456:ABC...` |
| `ADMIN_TG_ID` | Числовой Telegram ID администратора | `123456789` |
| `SHEET_ID` | ID Google Таблицы | `1BxiMV...` |
| `WEBAPP_SECRET` | Секрет для проверки запросов из Mini App | `mySecret2026xyz` |
| `WEBAPP_URL` | URL деплоя GAS (/exec) — используется GAS внутри себя | `https://script.google.com/macros/s/XXX/exec` |
| `MINI_APP_URL` | URL GitHub Pages (фронтенд Mini App) | `https://user.github.io/networking/` |
| `PAYMENT_AMOUNT_VND` | Сумма оплаты в донгах | `200 000 VND` |
| `PAYMENT_AMOUNT_CRYPTO` | Сумма оплаты в крипте | `8 USDT` |
| `QR_VND_FILE_ID` | Telegram file_id QR-кода VND | `AgACAgI...` |
| `QR_USDT_TRC20_FILE_ID` | Telegram file_id QR TRC20 | `AgACAgI...` |
| `QR_USDT_BYBIT_FILE_ID` | Telegram file_id QR Bybit | `AgACAgI...` |
| `QR_USDT_SOLANA_FILE_ID` | Telegram file_id QR Solana | `AgACAgI...` |
| `PIN_PRICE_WEEK_VND` | Стоимость закрепления на неделю (VND) | `500 000 VND` |
| `PIN_PRICE_WEEK_CRYPTO` | Стоимость закрепления на неделю (USDT) | `20 USDT` |
| `PIN_PRICE_MONTH_VND` | Стоимость закрепления на месяц (VND) | `1 500 000 VND` |
| `PIN_PRICE_MONTH_CRYPTO` | Стоимость закрепления на месяц (USDT) | `60 USDT` |
| `PIN_PRICE_LIFETIME_VND` | Стоимость пожизненного закрепления (VND) | `5 000 000 VND` |
| `PIN_PRICE_LIFETIME_CRYPTO` | Стоимость пожизненного закрепления (USDT) | `200 USDT` |
| `USE_POLLING` | НЕ ДОЛЖЕН существовать при webhook-режиме | удалить если есть |
| `LAST_UPDATE_ID` | НЕ НУЖЕН при webhook-режиме | удалить если есть |

**Webhook зарегистрирован на URL Cloudflare Worker, НЕ на WEBAPP_URL.**
WEBAPP_URL в setWebhook НЕ передаётся — только через Worker.

---

### Архитектура узла доставки

```
Пользователь → /start или любое сообщение
        ↓
Telegram серверы
        ↓  POST JSON (update)
Cloudflare Worker
  URL: https://<name>.<account>.workers.dev
  - Отвечает Telegram: HTTP 200 OK (мгновенно)
  - Параллельно: fetch(GAS_URL, { redirect: 'follow', body: update })
        ↓  POST JSON (тот же update)
GAS Web App /exec
  URL: https://script.google.com/macros/s/XXX/exec
  - Отвечает Worker: HTTP 302 (редирект) — Worker следует по нему
  - Выполняет: handleTelegramUpdate(update)
  - Пишет в Google Sheets
  - Отвечает пользователю через Telegram API (sendMessage)
        ↓
Пользователь получает ответ бота (1–3 сек)
```

**Почему не напрямую Telegram → GAS:**
GAS Web App при POST всегда отвечает HTTP 302, а не 200.
Telegram требует HTTP 200 от webhook-эндпоинта — иначе считает доставку неудавшейся
и перестаёт слать обновления. Cloudflare Worker решает это: всегда возвращает 200,
независимо от ответа GAS.

---

### Cloudflare Worker — переменные окружения

Настраиваются в: Worker → Settings → Variables → Environment Variables

| Переменная | Значение |
|-----------|---------|
| `GAS_URL` | WEBAPP_URL из Script Properties (тот же `/exec`) |

---

### Код Worker (актуальный, workers.dev)

```js
export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }
    const GAS_URL = env.GAS_URL;
    try {
      const body = await request.text();
      await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        redirect: 'follow'
      });
    } catch (err) {
      // GAS недоступен — Telegram всё равно получает 200
    }
    return new Response('OK', { status: 200 });
  }
};
```

---

### Функция регистрации webhook (GAS, разовая)

```js
function installCloudflareWebhook() {
  const config = getConfig();
  const workerUrl = 'https://<name>.<account>.workers.dev'; // реальный URL Worker'а
  const url = 'https://api.telegram.org/bot' + config.botToken +
    '/setWebhook?url=' + encodeURIComponent(workerUrl) +
    '&drop_pending_updates=false';
  const resp = UrlFetchApp.fetch(url).getContentText();
  Logger.log(resp);
  sendMessage(config.adminTgId, '🔗 Webhook → Cloudflare:\n' + resp);
  PROPS.deleteProperty('USE_POLLING');
  PROPS.deleteProperty('LAST_UPDATE_ID');
  removePollingTriggers();
}
```

Запускается **один раз** после смены Worker URL или BOT_TOKEN.

Проверка: `checkWebhook()` — в Telegram придёт JSON; `"url"` должен указывать на Worker, не на GAS.

---

### Триггеры GAS (актуальные)

| Функция | Расписание | Назначение |
|---------|-----------|-----------|
| `dailyListingsMaintenance` | Ежедневно 07:00 (Asia/Ho_Chi_Minh) | Архивация анкет + снятие истёкших pin + предупреждения за сутки |
| `archiveExpiredListings` | *(устарело)* | Обёртка → вызывает `dailyListingsMaintenance()` для совместимости |

**pollTelegramUpdates — триггера НЕТ и быть не должно.**

---

### Что НЕ делать (Cursor, не предлагай это)

- НЕ запускать `setupBotDelivery()` — она переключит на polling
- НЕ запускать `startFastPolling()` / `installPollingTrigger()` — polling не нужен
- НЕ регистрировать webhook на WEBAPP_URL напрямую — GAS даёт 302
- НЕ добавлять триггер `pollTelegramUpdates`
- НЕ устанавливать `USE_POLLING = true` в Script Properties

Если бот молчит — запустить `installCloudflareWebhook()` и `checkWebhook()`.

---

## 7. Точки входа GAS: doPost и doGet

### doPost(e) — webhook и POST Mini App

`doPost` обрабатывает JSON-тело POST-запросов:

| action / тип | Обработчик |
|---|---|
| `update_id` (Telegram webhook) | `handleTelegramUpdate` |
| `submit_listing` | `handleFormSubmission` |
| `get_listings` | `handleGetListings` |
| `get_my_listings` | `handleGetMyListings` |
| `archive_listing` | `handleArchiveListing` |
| `get_pin_prices` | `handleGetPinPrices` |
| `select_pin_payment_method` | `handleSelectPinPaymentMethod` |
| … | см. `Code.gs` |

### doGet(e) — GET Mini App (лайки)

Лайки идут **отдельными GET-экшенами**, существующий `doPost` не затрагивается:

```javascript
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'toggleLike') {
    return jsonResponse(handleLike(e.parameter));
  }
  if (action === 'getLikes') {
    return jsonResponse(getLikesForUser(e.parameter.initData));
  }
  return textOutput('OK'); // health check
}
```

**Ключевые функции лайков в `Code.gs`:**

| Функция | Назначение |
|---|---|
| `validateTelegramInitData(initData, botToken)` | HMAC-SHA256, `auth_date` ≤ 3600 сек |
| `handleLike(params)` | like/unlike + LockService + запись в лист `Likes` |
| `getLikesForUser(initData)` | Счётчики из кэша/листа + флаг `likedByMe` |
| `ensureLikesSheet()` | Создание листа `Likes` при необходимости |

---

## 8. Флоу отправки формы (`handleFormSubmission`)

```
1. Получить данные из body (display_name, category, description, contacts, tg_id, initData)
2. Валидировать initData (подпись от Telegram)
3. Проверить стоп-слова в description
4. Проверить дубль: нет ли у этого tg_id активной / на модерации анкеты
5. Найти пользователя в листе users:
   - Если нет → создать запись
6. Проверить free_used:
   - FALSE → записать со статусом on_moderation, payment_status = free
   - TRUE → записать со статусом on_moderation, payment_status = pending_check
             + отправить пользователю реквизиты для оплаты
7. Уведомить админа с инлайн-кнопками [✅ Одобрить] [❌ Отклонить]
8. Вернуть JSON-ответ форме: { ok: true, message: "Анкета отправлена на модерацию" }
```

---

## 9. Флоу модерации (`handleTelegramUpdate` → callback_query)

```
1. Получить callback_data:
   - "approve_<listing_id>" / "reject_<listing_id>" — модерация анкеты
   - "pin_approve_<listing_id>_<duration>" / "pin_reject_<listing_id>" — закрепление (см. §15)
2. Проверить, что нажал именно ADMIN_TG_ID
3. Найти строку с listing_id в листе listings
4. Если Одобрить (анкета):
   - status = active
   - created_at = сегодня
   - expires_at = сегодня + 30 дней
   - Если payment_status = free → в листе users: free_used = TRUE
   - Уведомить пользователя: "Ваша анкета опубликована!"
5. Если Отклонить:
   - status = rejected
   - Уведомить пользователя: "Анкета отклонена. Причина: [причина]"
6. Убрать инлайн-кнопки у сообщения админа (editMessageReplyMarkup)

Pin-одобрение (§15): pin_status = pinned, pinned_at, pin_expires_at; уведомление о сроке закрепления.
```

---

## 10. Ежедневное обслуживание листингов (`dailyListingsMaintenance`)

Запускается ежедневно в **07:00** (Asia/Ho_Chi_Minh) через `installDailyTrigger()`. Заменяет отдельный триггер `archiveExpiredListings`.

```
Блок A — автоархивация (как раньше):
  status === 'active' и expires_at <= now → status = 'archived', уведомление пользователю

Блок B — снятие истёкшего закрепления:
  pin_status === 'pinned', pin_expires_at !== 'lifetime' и дата <= now
  → pin_status = 'regular', очистить pinned_at / pin_expires_at, уведомление

Блок C — предупреждение за ~24 ч до снятия pin:
  pin_expires_at через 20–28 ч → одно уведомление пользователю
```

**Установка триггера:** `installDailyTrigger()` — удаляет старые триггеры `dailyListingsMaintenance` / `archiveExpiredListings` и создаёт новый.

**Миграция колонок pin:** `migratePinColumns()` — добавляет `pin_status`, `pinned_at`, `pin_expires_at` в существующий лист `listings`, проставляет `regular` старым строкам.

**Важно:** не читать `getRange()` внутри цикла — один `getValues()`, изменения батчить; `pin_expires_at = 'lifetime'` — строка, не дата.

---

## 11. Cursor — промпты для разработки

> Каждый промпт — отдельный файл или отдельная задача в Cursor.  
> Перед каждым промптом открывай `Code.gs` в Cursor.  
> Подставляй реальные значения вместо плейсхолдеров в `<угловых скобках>`.

---

### Промпт 1 — Инициализация: константы, helpers, структура файла

```
Контекст: Я разрабатываю бэкенд для Telegram Mini App на Google Apps Script (GAS).
Файл: Code.gs

Задача: Напиши начальную структуру файла Code.gs.

Требования:

1. Все секреты читать через PropertiesService, не хардкодить:
   const PROPS = PropertiesService.getScriptProperties();
   const BOT_TOKEN = PROPS.getProperty('BOT_TOKEN');
   const ADMIN_TG_ID = Number(PROPS.getProperty('ADMIN_TG_ID'));
   const SHEET_ID = PROPS.getProperty('SHEET_ID');

2. Константы:
   const CATEGORIES = ['IT и разработка', 'Дизайн и creative', 'Маркетинг и SMM',
     'Бизнес и финансы', 'Юриспруденция', 'Медицина и здоровье', 'Красота и уход',
     'Туризм и экскурсии', 'Образование и репетиторство', 'Строительство и ремонт',
     'Транспорт и логистика', 'Другое'];

   const STOP_WORDS = ['секс', 'эскорт', 'порно', 'интим', 'наркотики', 'закладки',
     'оружие', 'казино', 'ставки', 'вулкан', 'скам', 'развод',
     'вакансия', 'требуется сотрудник', 'ищем в команду', 'нанимаем'];

3. Helper-функции:
   - sendMessage(chatId, text, replyMarkup) — отправка сообщения через Bot API
   - editMessageReplyMarkup(chatId, messageId, replyMarkup) — убирает кнопки после нажатия
   - getSheet(sheetName) — возвращает лист по имени из таблицы по SHEET_ID
   - generateId(tgId) — генерирует уникальный listing_id: String(tgId) + '_' + Date.now()
   - logAction(tgId, action, details) — пишет строку в лист 'logs'

4. Функция-заглушка doPost(e):
   - Парсит e.postData.contents как JSON
   - Если body.update_id !== undefined → вызывает handleTelegramUpdate(body)
   - Если body.action === 'submit_listing' → вызывает handleFormSubmission(body)
   - Оборачивает всё в try/catch, логирует ошибки
   - Возвращает ContentService.createTextOutput('OK')

5. Функции-заглушки: handleTelegramUpdate(update), handleFormSubmission(body)
   — пока пустые, просто логируют вход.

Никаких лишних комментариев. Код должен быть рабочим и запускаться без ошибок.
```

---

### Промпт 2 — Обработка отправки формы

```
Контекст: Google Apps Script, файл Code.gs. Уже есть константы BOT_TOKEN, ADMIN_TG_ID,
SHEET_ID, STOP_WORDS, CATEGORIES, и helper-функции sendMessage, getSheet, generateId, logAction.

Задача: Напиши функцию handleFormSubmission(body).

Тело body содержит:
  { action, tg_id, username, first_name, display_name, category, description, contacts, initData }

Логика:

1. Валидация initData:
   Проверить подпись initData по алгоритму Telegram (HMAC-SHA256).
   Secret key = HMAC-SHA256("WebAppData", BOT_TOKEN).
   Data string = отсортированные поля initData кроме hash, объединённые через \n.
   Если подпись не совпадает — вернуть { ok: false, error: 'Invalid initData' }.

2. Проверка стоп-слов:
   Привести description к нижнему регистру.
   Если содержит любое из STOP_WORDS — вернуть { ok: false, error: 'stop_words' }.

3. Проверка дубля:
   В листе 'listings' найти строки с этим tg_id и статусом 'on_moderation' или 'active'.
   Если есть — вернуть { ok: false, error: 'duplicate' }.

4. Работа с пользователем (лист 'users'):
   Найти строку по tg_id.
   Если не найдена — добавить: [tg_id, username, first_name, new Date(), false]
   Прочитать значение free_used.

5. Запись анкеты (лист 'listings'):
   listing_id = generateId(tg_id)
   Если free_used = false: payment_status = 'free'
   Если free_used = true:  payment_status = 'pending_check'
   Статус всегда: 'on_moderation'
   submitted_at = new Date()
   created_at и expires_at — пустые (заполнятся при одобрении).
   Добавить строку в лист.

6. Уведомить админа:
   Текст: "📋 Новая анкета на модерации\n\nИмя: {display_name}\nКатегория: {category}\n
   Описание: {description}\nКонтакты: {contacts}\nID: {listing_id}\n
   Оплата: {payment_status === 'free' ? 'Бесплатное (первое)' : 'Ожидает оплату'}"

   Инлайн-кнопки:
   [✅ Одобрить] callback_data: "approve_{listing_id}"
   [❌ Отклонить] callback_data: "reject_{listing_id}"

7. Если payment_status = 'pending_check':
   Дополнительно отправить пользователю (tg_id) сообщение с реквизитами оплаты:
   "Ваша анкета получена. Для публикации переведите <СУММА> на <РЕКВИЗИТЫ>.
   Пришлите скриншот чека в ответ на это сообщение."
   После этого записать в лист 'sessions': [tg_id, 'await_payment_proof', listing_id, new Date()]

8. Вернуть JSON: { ok: true, message: 'Анкета отправлена на модерацию' }

Используй уже написанные helper-функции. Обрабатывай все ошибки через try/catch + logAction.
```

---

### Промпт 3 — Обработка Telegram Webhook (callback_query и фото-чек)

```
Контекст: Google Apps Script, файл Code.gs. Все helper-функции и константы уже есть.

Задача: Напиши функцию handleTelegramUpdate(update).

Она должна обрабатывать два типа апдейтов:

--- А) callback_query (нажатие кнопки админом) ---

Проверки:
- update.callback_query существует
- from.id === ADMIN_TG_ID (иначе игнорировать)

Извлечь callback_data. Форматы: "approve_<listing_id>" или "reject_<listing_id>".

Если "approve_<listing_id>":
  1. В листе 'listings' найти строку по listing_id.
  2. Установить: status = 'active', created_at = сегодня, expires_at = сегодня + 30 дней.
  3. Если payment_status = 'free':
     В листе 'users' найти tg_id, установить free_used = TRUE.
  4. Отправить пользователю: "🎉 Ваша анкета прошла модерацию и опубликована в каталоге!
     Она будет активна 30 дней."
  5. Убрать инлайн-кнопки у сообщения админа: editMessageReplyMarkup(adminChatId, messageId, null).
  6. Ответить админу: answerCallbackQuery с текстом "Одобрено ✅".
  7. logAction(tg_id, 'approve', listing_id).

Если "reject_<listing_id>":
  1. В листе 'listings' найти строку, установить status = 'rejected'.
  2. Отправить пользователю: "❌ Ваша анкета отклонена модератором.
     Если вы совершили оплату — свяжитесь с администратором для возврата."
  3. Убрать кнопки, ответить админу "Отклонено ❌".
  4. logAction(tg_id, 'reject', listing_id).

--- Б) message с фото (скриншот чека от пользователя) ---

Проверки:
- update.message.photo существует
- В листе 'sessions' есть запись для этого tg_id со state = 'await_payment_proof'

Если условия выполнены:
  1. Прочитать listing_id из поля draft в sessions.
  2. Переслать фото чека админу с подписью:
     "💳 Скриншот оплаты от @{username}\nАнкета: {listing_id}"
     И кнопками [✅ Одобрить] [❌ Отклонить] (те же callback_data).
  3. Удалить строку из листа 'sessions' (или очистить state).
  4. Отправить пользователю: "Спасибо! Ваш чек получен. Ожидайте подтверждения от модератора."

Все edge-cases оборачивать в try/catch + logAction.
```

---

### Промпт 4 — Автоархиватор

```
Контекст: Google Apps Script, файл Code.gs. Helper-функции уже есть.

Задача: Напиши функцию archiveExpiredListings().

Она будет запускаться ежедневно по триггеру (настраивается вручную в GAS).

Логика:
1. Открыть лист 'listings', получить все данные getValues().
2. Получить индексы столбцов: status, expires_at, tg_id, display_name, category, listing_id.
3. Пройти по строкам (начиная со 2-й, 1-я — заголовки).
4. Если status === 'active' И expires_at <= new Date():
   a. Установить status = 'archived' в этой строке.
   b. Отправить пользователю (tg_id) сообщение:
      "📦 Срок публикации вашей анкеты [{display_name} — {category}] истёк (30 дней).
      Анкета перемещена в архив. Для повторной публикации свяжитесь с администратором."
   c. logAction(tg_id, 'archive', listing_id).
5. После прохода логировать: сколько анкет заархивировано за запуск.

Важно: не прерывать цикл при ошибке одной строки — оборачивать каждую итерацию в try/catch.
```

---

## 12. Чеклист деплоя

```
□ 1. Создать Google Таблицу с листами: users, listings, sessions, logs
     (лист Likes создастся автоматически при первом лайке)

□ 2. Создать Google Apps Script проект
     Вставить готовый Code.gs

□ 3. В Script Properties добавить ключи из §6 (BOT_TOKEN, ADMIN_TG_ID, SHEET_ID, …)

□ 4. Deploy → New Deployment → Web App
     Execute as: Me
     Who has access: Anyone
     Скопировать URL деплоя → записать в WEBAPP_URL

□ 5. Cloudflare Worker: задеплоить код из §6, env GAS_URL = WEBAPP_URL

□ 6. Зарегистрировать webhook на Worker (не на GAS!):
     installCloudflareWebhook() → checkWebhook()
     url в getWebhookInfo должен быть workers.dev, не script.google.com

□ 7. Миграция и триггер закреплений (см. §15):
     migratePinColumns() → installDailyTrigger()
     Script Properties: PIN_PRICE_*_VND, PIN_PRICE_*_CRYPTO (6 ключей, см. §15)

□ 8. GitHub Pages: catalog.html + index.html, GAS_URL = WEBAPP_URL

□ 9. Тест полного флоу (анкеты):
     - Отправить тестовую форму
     - Проверить, что запись появилась в listings со статусом on_moderation
     - Проверить, что бот прислал уведомление с кнопками
     - Нажать "Одобрить" — проверить статус active и уведомление пользователю

□ 10. Тест лайков (см. §13):
     - catalog.html через Telegram Mini App
     - getLikes загружает счётчики
     - toggleLike сохраняет в лист Likes
     - rollback при Offline в DevTools

□ 11. Тест закреплений (см. §15 и `pinned_listings_TZ.md` §6):
     - Профиль → «Закрепить» → выбор срока → оплата → чек боту
     - Админ: [📌 Закрепить] / [❌ Отклонить]
     - Каталог: pin сверху, свечение 📌, только на стр. 1
```

---

## 13. Система лайков (реализовано)

> Полная спецификация, промпты для Cursor и контрольный список — в файле **`likes_system_TZ.md`**.

### Фронтенд (`catalog.html`, блок LIKES MODULE)

| Элемент | Описание |
|---|---|
| `LIKES_ENABLED` | Feature flag (`true` / `false`) — мгновенно отключить запросы без передеплоя GAS |
| `initLikes()` | Фаза 2: GET `getLikes`, таймаут 5 сек, graceful degradation |
| `toggleLike(cardId)` | Optimistic UI + debounce 1.2 сек |
| `sendLike(...)` | POST-like через GET `toggleLike`, rollback при ошибке |
| `myLikes`, `likeCountState` | Состояние на клиенте |

**CardID** = `listing_id` из листа `listings`.

### Поток данных лайка

```
[Клик ❤️] → Optimistic UI → debounce 1.2s
    → GET toggleLike (initData подписан)
    → validateTelegramInitData → LockService → лист Likes
    → CacheService.remove('likes_all')
    → { success, newCount } → синхронизация UI
    │ ошибка → rollback + showAlert
```

### Безопасный порядок выкатки

1. Деплой GAS с функциями лайков (`doGet` + `handleLike` + `getLikesForUser`).
2. Деплой `catalog.html` с `LIKES_ENABLED = false` (UI есть, запросов нет).
3. Проверить бэкенд вручную (`?action=getLikes&initData=…`).
4. Включить `LIKES_ENABLED = true`.

### Файлы проекта

| Файл | Роль |
|---|---|
| `Code.gs` | Бэкенд лайков (конец файла, секция LIKES SYSTEM) |
| `catalog.html` | UI лайков на карточках каталога |
| `likes_system_TZ.md` | Детальное ТЗ, промпты 1–8, чеклист перед деплоем |

---

## 14. Важные технические нюансы для Cursor

- **GAS не поддерживает `crypto` из Node.js.** Для HMAC-SHA256 проверки initData использовать `Utilities.computeHmacSha256Signature()`.
- **`getValues()` в GAS** возвращает двумерный массив `[строка][столбец]`, индексация с 0.
- **Не использовать `SpreadsheetApp.openById()` внутри цикла** — вызывать один раз до цикла.
- **Лимит выполнения GAS — 6 минут.** Архиватор при большом числе строк должен батчить изменения через `setValues()`, а не построчно.
- **Webhook через Cloudflare Worker:** Telegram → Worker (HTTP 200) → GAS `/exec` (HTTP 302). Не регистрировать webhook напрямую на GAS. Polling не использовать — см. §6.
- **Telegram answerCallbackQuery** обязателен при обработке нажатия кнопки — иначе кнопка "крутится" у пользователя бесконечно.
- **CORS:** `doPost` в GAS не требует дополнительных заголовков — Telegram и браузер работают нормально при деплое с параметром "Anyone".
- **Лайки через `doGet`:** GET-запросы Mini App (`getLikes`, `toggleLike`) идут напрямую на `/exec`, минуя Cloudflare Worker. Worker нужен только для webhook Telegram.
- **Лайки: только `initData`, не `userId` в URL.** Никогда не принимать `userId` как GET-параметр — только подписанный `initData` с валидацией на бэкенде.
- **Cold start GAS:** первый запрос после простоя — 3–8 сек. На фронте `fetchWithTimeout(5000)` для `initLikes`; при таймауте карточки работают без лайков.
- **Feature flag:** `LIKES_ENABLED` в `catalog.html` — быстрый откат без передеплоя GAS.

---

## 15. Платные закреплённые карточки (реализовано)

> Полная спецификация, флоу оплаты, E2E-тест и контрольный список — в файле **`pinned_listings_TZ.md`**.

### Назначение

Пользователь может оплатить закрепление активной карточки на неделю, месяц или пожизненно. Закреплённые карточки:
- всегда выше обычных в категории (при любой сортировке);
- визуально выделены (оранжевое свечение + 📌);
- показываются только на первой странице пагинации.

### Поток данных

```
[Профиль → «Закрепить»] → screenPinChoice (срок + цены из get_pin_prices)
    → screenPinPayment (способ оплаты)
    → POST select_pin_payment_method → QR в чат бота, session await_pin_proof
    → пользователь шлёт скриншот → админу кнопки pin_approve_ / pin_reject_
    → pinApproveListing → Sheets: pin_status, pinned_at, pin_expires_at
    → каталог: pinned первыми, is-pinned на карточке
```

### Backend (`Code.gs`)

| Элемент | Статус |
|---|---|
| `HEADERS.listings` — `pin_status`, `pinned_at`, `pin_expires_at` | ✅ |
| `HEADERS.sessions` — `session_type` | ✅ |
| `getConfig()` — `pinPrice*Vnd`, `pinPrice*Crypto` (6 полей) | ✅ |
| `migratePinColumns()` | ✅ |
| `get_pin_prices` → `handleGetPinPrices()` | ✅ |
| `select_pin_payment_method` → `handleSelectPinPaymentMethod()` | ✅ |
| `handlePaymentProofPhoto()` — ветка `await_pin_proof` | ✅ |
| `handleCallbackQuery()` — `pin_approve_`, `pin_reject_` | ✅ |
| `pinApproveListing()`, `pinRejectListing()` | ✅ |
| `handleGetListings()` / `handleGetMyListings()` — поля pin + сортировка | ✅ |
| `dailyListingsMaintenance()` — архивация + pin expiry + предупреждения | ✅ |
| `installDailyTrigger()` (07:00) | ✅ |
| `getPinDurationLabel()`, `getPinExpiresDate()` | ✅ |
| `checkScriptProperties()` — вывод `PIN_PRICE_*_VND` / `PIN_PRICE_*_CRYPTO` | ✅ |

### Frontend (`catalog.html`)

| Элемент | Статус |
|---|---|
| CSS `.is-pinned`, `.pin-btn`, `.p-pin-meta`, `.pin-choice-card` | ✅ |
| `buildListingCardHtml()` — класс `is-pinned` | ✅ |
| `applyListingsSort()` — pinned / regular | ✅ |
| `showListingsPage()` — pin только на стр. 1 (`regStart`) | ✅ |
| HTML `screenPinChoice`, `screenPinPayment` | ✅ |
| JS: `_pinListingId`, `_pinDuration`, `_pinPrices` | ✅ |
| `openPinChoice()`, `updatePinPriceDisplay()`, `selectPinDuration()` — две цены VND/USDT | ✅ |
| `handlePinPaymentMethod()` | ✅ |
| `openProfile()` — кнопка «Закрепить», pin-даты, `is-pinned` на profile-card | ✅ |
| События pin-экранов, `showScreen('pinChoice' \| 'pinPayment')` | ✅ |

### Script Properties (дополнительно к §6)

| Ключ | Пример |
|---|---|
| `PIN_PRICE_WEEK_VND` | `500 000 VND` |
| `PIN_PRICE_WEEK_CRYPTO` | `20 USDT` |
| `PIN_PRICE_MONTH_VND` | `1 500 000 VND` |
| `PIN_PRICE_MONTH_CRYPTO` | `60 USDT` |
| `PIN_PRICE_LIFETIME_VND` | `5 000 000 VND` |
| `PIN_PRICE_LIFETIME_CRYPTO` | `200 USDT` |

> Старые `PIN_PRICE_WEEK` / `PIN_PRICE_MONTH` / `PIN_PRICE_LIFETIME` не используются.

### Деплой после выката кода

1. Задеплоить `Code.gs`, добавить 6 ключей `PIN_PRICE_*_VND` / `PIN_PRICE_*_CRYPTO` в Script Properties.
2. Запустить `migratePinColumns()` — проверить лог `done, N rows updated`.
3. Запустить `installDailyTrigger()` — триггер `dailyListingsMaintenance` на 07:00.
4. Обновить `catalog.html` на GitHub Pages.
5. E2E по чеклисту в `pinned_listings_TZ.md` §6.

### Файлы проекта

| Файл | Роль |
|---|---|
| `Code.gs` | Pin-flow, модерация pin, `dailyListingsMaintenance` |
| `catalog.html` | UI закрепления, визуал pinned-карточек, пагинация |
| `pinned_listings_TZ.md` | Детальное ТЗ, E2E, технические нюансы |

### Технические нюансы (pin)

- **`pin_status` с фронта не принимается** — только чтение/запись в Sheets на бэкенде.
- **`pin_expires_at = 'lifetime'`** — строка; в триггере сначала проверять `!== 'lifetime'`.
- **Коллизия сессий:** при фото сначала `session_type === 'pin'` (`await_pin_proof`), затем `payment`.
- **`callback_data`:** `pin_approve_{listing_id}_{duration}` укладывается в лимит 64 байта.
- **Пожизненный pin** не продлевает `expires_at` размещения (30 дней архивации как раньше).
- **`setupSheets()` не трогать** для миграции pin — только `migratePinColumns()`.

**Не в scope (следующий этап):** продление без снятия, статистика pin, админ-экран всех закреплённых.

---

## 16. Мульти-админ (Cloudflare Worker + Mini App)

> Детальное ТЗ: **`admin_profile_TZ.md`** v1.3 · деплой: **`DEPLOY_GUIDE_CF.md`** §D2d · E2E: **`tests/admin-profile-e2e.md`**

### Роли

| Роль | Источник | Mini App | Бот |
|---|---|---|---|
| **grand_admin** | Один: seed из `ADMIN_TG_ID` (D1 `admins`) | Цены, QR, CRUD admins, разбан | Модерация, бан, `/qr*` |
| **admin** | Добавляет grand_admin по Telegram ID | Только «Забаненные», смена своего пароля | Модерация, бан (без цен и QR) |

### Аутентификация

- Пароль — **только UI**, PBKDF2 в D1 (`password_hash` / `password_salt`). Секрет `ADMIN_PASSWORD_HASH` **не используется**.
- Первый вход grand_admin без пароля → popup «Установка пароля» → `admin_setup_password` → `adminToken` в `sessionStorage` как `adminSessionToken`.
- Сессия: KV `admin_session:{token}`, sliding **8 ч**, жёсткий предел **24 ч** от login.
- Модерация анкет, pin, чеков оплаты — **в боте** для обеих ролей; уведомления уходят **всем** строкам в `admins`.

### Данные

- D1: `admins`, `app_settings` (цены и `qr_*_file_id`), `users.banned_at` / `banned_by`.
- Настройки: приоритет **D1 → env → default** (`getConfigWithSettings`).

### Ограничения v1

- Ровно один `grand_admin`; смена владельца — ручная операция в D1 + `ADMIN_TG_ID` (runbook в `DEPLOY_GUIDE_CF.md`).
- Admin не может менять цены, QR, добавлять admins; не может банить другого admin (только grand_admin).

---

## 17. Редактирование мини-резюме (Cloudflare Worker + D1)

> Детальное ТЗ: **`listing_edit_TZ.md`** v1.5 · деплой: **`DEPLOY_GUIDE_CF.md`** §D2e · QA: §10 в `listing_edit_TZ.md`

### Статусы (D1)

| Статус | Каталог | Мой профиль | Поиск |
|---|---|---|---|
| `active` | да | да | да |
| `edit_pending` | **нет** | **нет** (hint на родителе) | **нет** |
| `on_moderation` | нет | да | нет |

### Правила v1

- Редактировать можно только **`active`** анкету; **3 правки** на цикл публикации (`edits_remaining`, выдаётся при approve).
- Submit edit создаёт черновик `edit_pending`; в каталоге до approve — **старая версия** на том же `listing_id`.
- Счётчик уменьшается при **submit**, не при approve; отклонение **не возвращает** попытку.
- Одновременно не более **одного** `edit_pending` на пользователя.
- Миграция D1: **`010_listing_edit.sql`** — колонки `edits_remaining`, `replaces_listing_id`, backfill active → 3.
