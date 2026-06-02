# Пошаговый запуск: Нетворкинг Нячанг (для новичка)

> **УСТАРЕЛО (архив, GAS + Google Sheets).**  
> Актуальный бэкенд — **Cloudflare Worker + D1**. Канонический гайд: **[`DEPLOY_GUIDE_CF.md`](DEPLOY_GUIDE_CF.md)** (`wrangler deploy`, `API_URL` / `WEBAPP_SECRET` в `catalog.html`).  
> Этот файл оставлен только как историческая справка по Google Apps Script. Не используйте его для новых деплоев.

> **Где что лежит в репозитории:**
> - **`networking_nhatrang_tz.md`** — архитектура, структура Sheets, логика бэкенда, чеклисты
> - **`likes_system_TZ.md`** — детальное ТЗ системы лайков (промпты 1–8)
> - **`DEPLOY_GUIDE_RU.md`** (этот файл) — **архив:** пошаговый деплой GAS (не актуален)
> - **`DEPLOY_GUIDE_CF.md`** — **актуальный** деплой Worker + D1 + GitHub Pages

Два разных URL — не путайте:

| Название в Properties | Что это | Пример |
|---------------------|---------|--------|
| **WEBAPP_URL** | URL **деплоя Google Apps Script** (бэкенд, webhook) | `https://script.google.com/macros/s/XXXX/exec` |
| **MINI_APP_URL** | URL **Mini App** на GitHub Pages (`catalog.html`) | `https://user.github.io/networking/` |

---

## Часть A. Google Таблица

1. [sheets.google.com](https://sheets.google.com) → Создать таблицу.
2. Скопировать ID из адресной строки:  
   `https://docs.google.com/spreadsheets/d/ **ВОТ_ЭТОТ_ID** /edit`
3. В GAS → **Script Properties** → `SHEET_ID` = этот ID.

---

## Часть B. Google Apps Script (бэкенд)

### B1. Проект

1. В таблице: **Расширения → Apps Script**.
2. Удалить код по умолчанию, вставить весь **Code.gs** из репозитория.
3. Сохранить (Ctrl+S).

### B2. Script Properties

**Проект → Настройки проекта (шестерёнка) → Свойства скрипта → Добавить свойство**

| Ключ | Значение |
|------|----------|
| `BOT_TOKEN` | Токен от @BotFather |
| `ADMIN_TG_ID` | Ваш числовой Telegram ID (узнать: @userinfobot) |
| `SHEET_ID` | ID таблицы |
| `WEBAPP_SECRET` | Любая длинная случайная строка (например `mySecret2026xyz`) |
| `PAYMENT_AMOUNT_VND` | Например `200 000 VND` |
| `PAYMENT_AMOUNT_CRYPTO` | Например `8 USDT` |
| `WEBAPP_URL` | Пока пусто — заполните после шага B4 |

`MINI_APP_URL` — после GitHub (часть D).

### B3. Заголовки листов

1. В редакторе GAS выберите функцию **`setupSheets`**.
2. **Выполнить** (▶).
3. Первый раз: **Разрешить доступ** ко всем пунктам.
4. В таблице появятся листы: `users`, `listings`, `sessions`, `logs`, `admin_links`.

### B4. Деплой Web App (это и есть WEBAPP_URL)

1. **Развернуть → Новое развертывание**.
2. Тип: **Веб-приложение**.
3. **Выполнять как:** Я (ваш email).
4. **У кого есть доступ:** **Все** (Anyone / любой пользователь, **не** «только с аккаунтом Google»).
5. **Развернуть** → скопировать **URL веб-приложения** (оканчивается на `/exec`).

> **Важно:** URL `googleusercontent.com/macros/echo` даёт **HTTP 405** на POST — Telegram через него **не работает**.  
> Запустите **`setupBotDelivery`**: если `/exec` не принимает POST (302), включится **POLLING** — постоянный триггер **`pollTelegramUpdates`** раз в минуту.
6. В Properties добавить **`WEBAPP_URL`** = этот URL (без пробелов).

При каждом изменении Code.gs: **Развернуть → Управление развертываниями → ✏️ → Версия: Новая → Развернуть**.

### B5. Проверка бота (без webhook)

1. Функция **`sendTestPing`** → Выполнить.
2. В Telegram бот должен прислать «Бот отвечает».

### B6. Webhook — что это

**Webhook** — Telegram сам отправляет сообщения боту на ваш URL GAS (`WEBAPP_URL`).  
Без webhook бот в GAS **не видит** ваши сообщения и не отвечает на QR.

После того как **`WEBAPP_URL`** записан:

1. Функция **`registerWebhook`** (или `installWebhook`) → Выполнить.
2. Функция **`checkWebhook`** → в Telegram придёт JSON; должно быть `"url": "https://script.google.com/..."`.

Ошибка `Set WEBAPP_URL` = вы запустили registerWebhook **до** шага B4.

### B7. QR-коды (file_id) — если бот не отвечает

**Способ 1 — через webhook (когда B6 готов):**  
Отправить боту 4 фото с подписями: `qr_vnd`, `qr_trc20`, `qr_bybit`, `qr_solana`.  
Бот ответит с `file_id`.

**Способ 2 — для новичка (надёжно):**

1. **`step1_disableWebhookForQrSetup`** → Выполнить.
2. В Telegram отправить боту **4 фото** с подписями выше (по одному).
3. **`step2_collectQrFromUpdates`** → Выполнить.  
   В Telegram придёт список сохранённых `file_id`.
4. **`checkScriptProperties`** — проверка, что все QR ✅.

### B7b. Скорость ответа бота

| Задержка | Причина |
|----------|---------|
| **до ~60 сек** | Polling (HTTP 302 на webhook) — норма для GAS, триггер раз в минуту |
| **сразу** | Webhook HTTP **200** на `/exec` — `fixWebAppAccess` → `setupBotDelivery` |

После обновления кода: **`installPollingTrigger`** (или **`setupBotDelivery`** при HTTP 302). Создаётся постоянный триггер «каждую 1 мин» — бот работает 24/7 без обрыва цепочки и без перерасхода квоты GAS.

Сообщения «Polling установлен» / «HTTP 302» — от запуска функций в редакторе GAS, **не** от команды `/start` в чате.

### B8. Триггер архивации

**Способ 1 (рекомендуется):** в редакторе GAS запустите функцию **`installArchiveTrigger`** — создаст ежедневный триггер на 03:00.

**Способ 2 (вручную):** **Триггеры → Добавить триггер:**

- Функция: `archiveExpiredListings`
- Источник: По времени
- Если есть только «каждые 6 / 12 часов» — выберите **6 часов** (это нормально).
- Если есть «Ежедневно» / Day timer — можно раз в сутки (например 3:00–4:00).

---

## Часть C. GitHub Pages (Mini App)

1. Аккаунт GitHub → **New repository** (например `networking-nhatrang`).
2. Загрузить файлы **`catalog.html`** (каталог + лайки) и **`index.html`** (форма анкеты).
3. В обоих файлах заменить:
   - `GAS_URL` = ваш **WEBAPP_URL** (тот же `/exec`);
   - `WEBAPP_SECRET` = тот же секрет, что в Properties (где используется).
4. **Settings → Pages → Source: Deploy from branch → main / root**.
5. Подождать 1–3 мин. URL вида:  
   `https://ВАШ_ЛОГИН.github.io/networking-nhatrang/`
6. В GAS Properties: **`MINI_APP_URL`** = этот URL (без `catalog.html` — бот сам открывает `/catalog.html`).

> Каталог: `MINI_APP_URL/catalog.html`  
> Форма анкеты: `MINI_APP_URL/index.html?form=1` или `catalog.html?form=1`

---

## Часть D. BotFather

1. @BotFather → ваш бот → **Bot Settings → Menu Button → Configure**  
   или команда `/setmenubutton`.
2. Тип: **Web App**.
3. URL: **`MINI_APP_URL`** (GitHub Pages, не GAS).
4. Текст кнопки: например «Открыть каталог» или «Анкета».

Команда `/start` в боте покажет кнопки (анкета + написать админу).

---

## Часть E. Порядок «с нуля» (чеклист)

```
□ Таблица + SHEET_ID
□ Code.gs в Apps Script
□ Properties: BOT_TOKEN, ADMIN_TG_ID, WEBAPP_SECRET, PAYMENT_AMOUNT_VND, PAYMENT_AMOUNT_CRYPTO
□ setupSheets()
□ Deploy Web App → WEBAPP_URL
□ sendTestPing — бот пишет вам
□ registerWebhook → checkWebhook (url не пустой)
□ QR: step1 → 4 фото → step2 ИЛИ фото с подписью при работающем webhook
□ checkScriptProperties — все ✅
□ GitHub Pages → MINI_APP_URL в Properties
□ catalog.html + index.html: GAS_URL + WEBAPP_SECRET
□ BotFather: Web App URL = MINI_APP_URL (или catalog.html — см. Code.gs)
□ Триггер archiveExpiredListings
□ Тест: /start → Mini App → отправить анкету → модерация в Telegram
□ installArchiveTrigger() — автоархивация раз в сутки
□ Часть F — деплой и тест лайков
```

---

## Часть F. Система лайков (catalog.html + doGet)

> Детали архитектуры — `networking_nhatrang_tz.md` §13, промпты — `likes_system_TZ.md`.

### F1. Что нужно на бэкенде

1. **`BOT_TOKEN`** уже должен быть в Script Properties (используется для валидации `initData`).
2. В **Code.gs** реализованы: `validateTelegramInitData`, `handleLike`, `getLikesForUser`, роутинг в **`doGet`**.
3. Лист **`Likes`** создаётся автоматически при первом лайке — `setupSheets()` его не создаёт.

### F2. Деплой GAS (новая версия, не перезаписывать старую вслепую)

1. **Развернуть → Управление развертываниями → ✏️ → Версия: Новая → Развернуть**.
2. Убедиться, что `catalog.html` → `GAS_URL` указывает на актуальный `/exec`.

### F3. Деплой фронтенда (безопасный порядок)

1. В `catalog.html` установить **`LIKES_ENABLED = false`** → задеплоить на GitHub Pages.
2. Открыть каталог через Telegram — сердечки видны, запросов к GAS нет.
3. После проверки бэкенда — **`LIKES_ENABLED = true`** → снова задеплоить.

### F4. Проверка бэкенда

| Тест | Ожидание |
|------|----------|
| `GET /exec` (без параметров) | `OK` |
| `GET /exec?action=getLikes&initData=…` | JSON `{ success: true, likes: [...] }` |
| Лайк в Mini App | Строка в листе `Likes`, счётчик обновился |
| DevTools → Network → Offline → лайк | Rollback UI + alert «Не удалось сохранить» |

> `initData` можно скопировать из консоли: `window.Telegram.WebApp.initData` (только внутри Telegram Mini App).

### F5. Feature flag

```javascript
const LIKES_ENABLED = true;  // false — UI есть, запросов нет
```

При проблемах на проде: выставить `false`, закоммитить — GAS трогать не нужно.

---

## Частые ошибки

| Проблема | Решение |
|----------|---------|
| `Set WEBAPP_URL` | Сначала деплой Web App, потом registerWebhook |
| Бот молчит на сообщения | Нет webhook/polling; запустите `installPollingTrigger` или `diagnoseBotSilence` |
| QR не сохраняются | Нет подписи к фото; используйте step1/step2 |
| Форма не отправляется | В index.html неверный GAS_URL или не совпадает WEBAPP_SECRET; после нового деплоя GAS обновите GAS_URL на GitHub Pages |
| «Не удалось отправить…» сразу после кнопки | Старый GAS_URL на GitHub или CORS (в index.html не должно быть `Content-Type: application/json` в fetch) |
| Mini App не открывается | В BotFather указан GAS URL вместо GitHub |
| Лайки не загружаются | Старый GAS_URL; не задеплоена новая версия с `doGet`; нет `BOT_TOKEN` |
| Лайк не сохраняется | Открыто не через Telegram (нет `initData`); `LIKES_ENABLED = false` |
| Счётчик откатился | Норма при ошибке сети — rollback; проверить лог GAS / lock_timeout |

---

## Ваши функции в GAS (шпаргалка)

| Функция | Когда запускать |
|---------|-----------------|
| `setupSheets` | Один раз в начале |
| `sendTestPing` | Проверка токена |
| `registerWebhook` | После WEBAPP_URL (то же, что `setupBotDelivery`) |
| `setupBotDelivery` | Webhook или polling — автоматически по HTTP-коду /exec |
| `installPollingTrigger` | Включить/восстановить polling (триггер раз в минуту) |
| `diagnoseBotSilence` | Бот не отвечает на /start |
| `checkWebhook` | Проверка webhook |
| `step1_disableWebhookForQrSetup` | Настройка QR без ответов бота |
| `step2_collectQrFromUpdates` | После 4 фото |
| `checkScriptProperties` | Общая диагностика |
| `installArchiveTrigger` | Один раз — ежедневный архиватор |
| `archiveExpiredListings` | Вручную для теста; обычно — триггер |
