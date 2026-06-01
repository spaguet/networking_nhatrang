# ТЗ: Администраторский профиль — Нетворкинг Нячанг
### Feature Spec для Cursor · Версия 1.3

**Статус: ✅ Реализовано** (31.05.2026, промпты 1–7; E2E — `tests/admin-profile-e2e.md`)  
**Стек:** Cloudflare Worker + D1 + KV · фронт `catalog.html` · модерация в боте  
**Контекст проекта:** `networking_nhatrang_tz.md`, миграция — `migration_to_cf_d1_TZ.md`  
**Связанные узлы:** `pinned_listings_TZ.md`, `payment.ts` / `pins.ts`, бан — `006_banned.sql`

> **Changelog 1.3:** §3.6 / §5 — уведомления payment+pin proof всем admins; `isAdmin` + `users.banned`; контракт `adminToken` в body; `getConfigWithSettings` + QR mapping; промпты 2–5 уточнены.
>
> **Changelog 1.2:** аудит ТЗ (§14), исправления несостыковок в §1.1 / §1.2 A1 / §1.7 / §4.2, таблица ключей `app_settings`, детальные промпты §13.
>
> **Changelog 1.1:** решения заказчика — **две роли** (grand_admin / admin), пароль **только через UI** и D1, первичная установка пароля grand-admin popup, матрица прав, TTL сессии sliding 8h, ban metadata обязательна, уведомление при разбане, modal подтверждения цен, бот `/qr*` только для grand_admin.
>
> **Changelog 1.0:** первичное ТЗ.

---

## 0. Краткое описание фичи

В проекте появляется **система администраторов** с двумя ролями:

| Роль | Кто | Права |
|---|---|---|
| **grand_admin** | Текущий `ADMIN_TG_ID` из env (единственный) | Всё: настройки (цены, QR), управление админами, модерация и бан **в боте**, разбан **в Mini App** |
| **admin** | Добавляется grand_admin по Telegram ID | Только модерация и бан **в боте** (как grand_admin), разбан **в Mini App**; **без** цен, QR и добавления админов |

**Mini App** (`catalog.html`):
- Кнопка **«🛠 Админ»** — видна всем, чей `tg_id` есть в таблице `admins`.
- Вход — **пароль через UI** (хеш в D1, не Worker secret).
- **Первый запуск:** у grand_admin нет пароля в БД → **popup** «Установка пароля» (два поля + «Подтвердить пароль»).
- Экран админа **зависит от роли** (см. §1.5).

**Бот:** одобрение/отклонение анкет, pin, contact reply, бан — для **обеих** ролей. Загрузка QR и команды `/qr*` — **только grand_admin**.

---

## 1. Функциональные требования

### 1.1 Роли и матрица прав

| Действие | grand_admin | admin |
|---|---|---|
| Вход в Mini App (пароль) | ✅ | ✅ |
| Модерация анкет в **боте** | ✅ | ✅ |
| Бан пользователя в **боте** | ✅ | ✅ |
| Список забаненных + «Простить» в Mini App | ✅ | ✅ |
| Изменение цен размещения / закреплений | ✅ | ❌ |
| Загрузка QR (Mini App) | ✅ | ❌ |
| Добавление / удаление admin | ✅ | ❌ |
| Смена **своего** пароля (Mini App) | ✅ | ✅ |
| Смена пароля другого admin | ✅ (при добавлении / сбросе) | ❌ |
| Бот `/qr`, `/qr_help`, `/qr_status`, фото QR | ✅ | ❌ |
| Забанить grand_admin | ❌ (guard) | ❌ |
| Забанить admin | ✅ (grand_admin) | ❌ (**исправлено v1.2:** только grand_admin) |
| «Простить» admin / grand_admin | ❌ (guard) | ❌ |

**Единственный grand_admin:** роль `grand_admin` **не назначается** через UI — только seed из `env.ADMIN_TG_ID` при миграции. В таблице `admins` может быть **ровно одна** строка с `role = 'grand_admin'`.

### 1.2 Доступ и аутентификация

| # | Требование |
|---|---|
| A1 | **Кнопка «Админ»** — если `initData` валиден и `user.id` есть в `admins` (пароль может быть не задан — см. §1.3). **Admin API** (кроме `admin_check_access`, `admin_setup_password`, `admin_login`) — только с валидным `adminToken` + `assertAdminSession`. |
| A2 | Пароль хранится в D1 как **PBKDF2-SHA256** (Web Crypto, salt per user, ≥ 100 000 iterations). Plaintext **нигде** не хранится. |
| A3 | Минимум пароля: **12 символов**, минимум **1 буква** и **1 цифра**. |
| A4 | После успешного login — **admin session token** (32 байт hex) в KV. |
| A5 | **TTL сессии (решение v1.1):** sliding **8 часов** — продлевается при каждом успешном admin API-запросе; **жёсткий предел 24 часа** от момента первого login (`session.createdAt`). По истечении — re-login. |
| A6 | Token привязан к `{ tgId, role, createdAt, lastActivityAt }` в KV `admin_session:{token}`. |
| A7 | Все admin actions (кроме §1.2 A1): `validateMiniAppRequest` + поле body **`adminToken`** (hex из KV) + `assertAdminSession`. В `sessionStorage` — ключ **`adminSessionToken`** (то же значение, другое имя — см. §14.2 G4). |
| A8 | **5 неудачных** попыток login за 15 мин → блокировка login для `tg_id` на **30 мин** (KV). |
| A9 | Кнопка **«Выйти»** — удаляет KV token и `sessionStorage.adminSessionToken` (+ `adminRole`). |
| A10 | Grand_admin **не может** быть забанен / разбанен через UI (backend guard). |

**Устарело:** `wrangler secret put ADMIN_PASSWORD_HASH` — **не используется**.

### 1.3 Первичная установка пароля grand_admin (popup)

**Условие показа:** `admin_check_access` возвращает `{ isAdmin: true, role: 'grand_admin', needsPasswordSetup: true }` — когда строка grand_admin в `admins` существует, но `password_hash IS NULL`.

**UI:** modal `#adminSetupPasswordModal` (не отдельный экран — блокирующий popup поверх Mini App):

| Элемент | Id / текст |
|---|---|
| Заголовок | «Установка пароля администратора» |
| Поле 1 | «Новый пароль» — `type="password"` |
| Поле 2 | «Повторите пароль» — `type="password"` |
| Кнопка | **«Подтвердить пароль»** |
| Ошибки | «Пароли не совпадают», «Минимум 12 символов…», inline под полями |

**Поток:**
1. Grand_admin открывает Mini App → `initAdminAccess()`.
2. Если `needsPasswordSetup` → показать popup **до** доступа к «Админ» (кнопку «Админ» можно показать, но клик тоже ведёт в popup, если пароль не задан).
3. `POST admin_setup_password { password, passwordConfirm }` — только grand_admin, только если hash пустой.
4. Успех → закрыть popup, toast «Пароль установлен», далее обычный login не нужен в этой сессии — **сразу выдать adminToken** (auto-login после setup).

> **Рекомендация:** после setup отправить grand_admin сообщение в **бот**: «Пароль администратора установлен. Храните его в надёжном месте.»

### 1.4 Вход по паролю (`#screenAdminLogin`)

Для admin и grand_admin с уже заданным паролем:

- Заголовок: **«Вход администратора»**.
- Поле пароля + **«Войти»**.
- Ссылка **«Сменить пароль»** → `#screenAdminChangePassword` (требует текущий пароль + новый × 2).
- «←» — главный экран.

**Ошибки:** `invalid_password`, `too_many_attempts`, `session_expired`, `not_admin`.

### 1.5 Экран администратора (`#screenAdmin`) — по ролям

#### Общее для обеих ролей

- Шапка: роль («Главный администратор» / «Администратор»), кнопки «Сменить пароль», «Выйти».
- Секция **«Забаненные пользователи»** (§1.7).
- Подсказка: «Модерация анкет — в чате бота».

#### Только grand_admin

| Секция | Содержимое |
|---|---|
| **Цены размещений** | §1.6.1 |
| **Цены закреплений** | §1.6.2 |
| **QR-коды оплаты** | §1.6.3 |
| **Администраторы** | §1.8 |

Секции grand_admin **не рендерятся** для `role === 'admin'` (ни в DOM, ни через API — 403).

### 1.6 Цены и QR (только grand_admin)

#### 1.6.1 Цены платного размещения

| Ключ | Default |
|---|---|
| `payment_amount_vnd` | `200 000 VND` |
| `payment_amount_crypto` | `8 USDT` |

Кнопка **«Сохранить цены размещения»** → открывает **modal подтверждения** (§1.9) → `admin_update_settings`.

#### 1.6.2 Цены закреплений

6 полей (`pin_price_week_vnd` … `pin_price_lifetime_crypto`) — defaults из `config.ts`.

Кнопка **«Сохранить цены закреплений»** → modal подтверждения → API.

> Новые цены — для **новых** сессий оплаты; открытые `sessions.draft` не пересчитываются.

#### 1.6.3 QR-коды оплаты

4 способа (`vnd`, `trc20`, `bybit`, `solana`). Upload → `admin_upload_qr` → `file_id` в `app_settings`.

Env-secrets `QR_*_FILE_ID` — **fallback**, D1 — приоритет.

### 1.7 Забаненные пользователи (grand_admin + admin)

Колонки списка:

| Поле | Источник |
|---|---|
| Telegram ID | `users.tg_id` |
| Имя / @username | `users.first_name`, `users.username` |
| **Дата бана** | `users.banned_at` (ISO, формат `DD.MM.YYYY HH:mm`) |
| **Кто забанил** | `users.banned_by` → lookup: `@username` или `tg_id`, подпись роли если admin |

- Пагинация: 20 / страница.
- Кнопка **«Простить»** → `confirm()` → `admin_unban_user`.
- После разбана — **уведомление пользователю в бот** (§3.5).
- Нельзя простить: себя, любого admin/grand_admin.

### 1.8 Управление администраторами (только grand_admin)

**Форма «Добавить администратора»:**

| Поле | Валидация |
|---|---|
| Telegram ID | число, > 0, не grand_admin, не дубликат |
| Пароль для нового admin | те же правила §1.2 A3 |
| Повтор пароля | совпадение |

Кнопка **«Добавить»** → `admin_add_admin`.

**Список admins** (без grand_admin в списке или с пометкой «Вы»):

| Колонка | |
|---|---|
| tg_id, имя | из `users` / `admins` |
| Дата добавления | `admins.created_at` |
| Кто добавил | `created_by` |
| Действие | **«Удалить»** → confirm → `admin_remove_admin` |

> **Рекомендация (принято в v1.1):** grand_admin может **удалить** обычного admin (отзыв доступа). Grand_admin **не удаляется** через UI.

При добавлении admin — сообщение **новому admin в бот**:

«Вас назначили администратором «Место Встречи». Откройте Mini App → кнопка «Админ» → войдите с паролем, который передал главный администратор.»

### 1.9 Modal подтверждения сохранения цен

После нажатия «Сохранить цены …» — **не** сразу API:

1. Modal `#adminConfirmPricesModal`.
2. Заголовок: «Подтвердите изменение цен».
3. Тело: таблица **было → стало** только для **изменённых** полей.
4. Кнопки: **«Отмена»** | **«Сохранить»** (primary).
5. «Сохранить» в modal → `admin_update_settings` → toast «Сохранено».

---

## 2. Нефункциональные требования

| Категория | Требование |
|---|---|
| **Безопасность** | PBKDF2, rate limit, RBAC на каждом endpoint, audit `logs` |
| **Приватность** | Admin UI hidden для не-admins; секции grand_admin — 403 для admin |
| **Производительность** | `app_settings` KV cache 60 сек |
| **Обратная совместимость** | `ADMIN_TG_ID` остаётся в env как seed grand_admin; модерация в боте сохраняется |
| **Аддитивность** | Новые миграции, `admin.ts`, экраны в `catalog.html`, рефактор проверок в `telegram.ts` |

---

## 3. Архитектура

### 3.1 Общая схема

```
[Telegram Mini App]
  initAdminAccess → admin_check_access → role, needsPasswordSetup
  popup setup password (grand_admin, first time)
  adminLogin → adminToken (KV)
  screenAdmin (role-based sections)
        │
        ▼
[handlers/admin.ts] ── RBAC assertGrandAdmin / assertAdmin
        │
   ┌────┴────┬──────────────┬─────────────┐
   ▼         ▼              ▼             ▼
 D1 admins  D1 app_settings  D1 users.*   KV sessions
        │
        ▼
[telegram.ts] isAdmin(tgId) / isGrandAdmin(tgId)
  moderation callbacks → any admin
  QR upload / /qr*     → grand_admin only
  moderation notify    → all admins (NEW)
```

### 3.2 Поток: bootstrap grand_admin

```
[Deploy + migration 007]
  → INSERT admins (tg_id=ADMIN_TG_ID, role='grand_admin', password_hash=NULL, ...)

[Grand_admin opens Mini App]
  → admin_check_access
      { isAdmin: true, role: 'grand_admin', needsPasswordSetup: true }
  → show #adminSetupPasswordModal
  → admin_setup_password
      → hash → UPDATE admins SET password_hash=...
      → createAdminSession → adminToken
  → show #screenAdmin (full)
```

### 3.3 Поток: обычный admin

```
[Grand_admin adds admin tg_id=999]
  → INSERT admins (role='admin', password_hash=..., created_by=grand_tg_id)

[Admin 999 opens Mini App]
  → admin_check_access { isAdmin: true, role: 'admin' }
  → adminLogin → token
  → #screenAdmin: только «Забаненные» + смена пароля + выход
  → модерация в боте (callback guard isAdmin)
```

### 3.4 Поток: изменение цен (grand_admin)

```
[Изменил поля → «Сохранить цены закреплений»]
  → openConfirmPricesModal(diff)
  → user confirms
  → admin_update_settings (assertGrandAdmin)
  → UPSERT app_settings, invalidate cache, log
```

### 3.5 Поток: разбан + уведомление

```
[«Простить» tg_id=12345]
  → confirm
  → admin_unban_user (assertAdmin — обе роли)
      → guard: target not in admins
      → UPDATE users SET banned=0, banned_at=NULL, banned_by=NULL
      → log admin_unban
      → sendMessage(12345, UNBAN_MESSAGE, env)
  → remove row from UI
```

**Текст уведомления (`UNBAN_MESSAGE`):**

«✅ Доступ к «Место Встречи» восстановлен. Вы снова можете пользоваться сервисом.»

### 3.6 Бот: QR и модерация (решение §9.6)

| Функция | Было | Стало |
|---|---|---|
| Callback approve/reject/**pin_***/ban | `fromId === adminTgId` | `isAdmin(fromId)` + ban guards §1.1 |
| `/qr`, `/qr_help`, `/qr_status`, QR photo | `adminTgId` | `isGrandAdmin(fromId)` |
| QR photo upload в боте | hint + wrangler secret | **grand_admin:** сохранять `file_id` в D1 `app_settings` (как Mini App) |
| Уведомления модератору о новой анкете | только `ADMIN_TG_ID` | **всем** `admins` — `sendModerationToAdmins()` (`listings.ts`, `portfolio.ts`) |
| Чек оплаты размещения (`await_payment_proof`) | `config.adminTgId` | **всем admins** — `sendModerationToAdmins()` в `telegram.ts` |
| Чек закрепления (`await_pin_proof`) | `config.adminTgId` | **всем admins** — то же |
| Contact admin messages + Reply | только grand | **всем admins**; Reply — любой `isAdmin(fromId)` + `saveAdminLink` по `message_id` получателя |

**Почему `/qr*` только grand_admin:** дублирование канала upload снижает audit; admin не должен менять QR; grand_admin имеет Mini App как основной UI, бот — **резерв** при недоступности Mini App.

### 3.7 Сессия (TTL)

```
KV admin_session:{token} = {
  tgId, role,
  createdAt,      // login time
  lastActivityAt  // updated each API call
}

Valid if:
  now - lastActivityAt < 8h  AND  now - createdAt < 24h

On each assertAdminSession success → update lastActivityAt, refresh KV TTL = min(8h, 24h - age)
```

---

## 4. Схема данных (D1)

### 4.1 Таблица `admins`

Файл: `worker/src/db/migrations/007_admins_and_settings.sql`

```sql
CREATE TABLE IF NOT EXISTS admins (
  tg_id          INTEGER PRIMARY KEY,
  role           TEXT NOT NULL CHECK (role IN ('grand_admin', 'admin')),
  password_hash  TEXT,              -- NULL только у grand_admin до первого setup
  password_salt  TEXT,
  created_at     TEXT NOT NULL,
  created_by     INTEGER,           -- NULL для seed grand_admin
  updated_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_admins_role ON admins(role);

-- Seed (в migration или отдельный SQL — tg_id подставляется при deploy):
-- INSERT OR IGNORE INTO admins (tg_id, role, password_hash, password_salt, created_at, created_by, updated_at)
-- VALUES ($ADMIN_TG_ID, 'grand_admin', NULL, NULL, datetime('now'), NULL, datetime('now'));
```

> **Deploy note:** seed grand_admin выполнять скриптом миграции с чтением `ADMIN_TG_ID` **или** idempotent INSERT в `007` с комментарием «заполнить вручную один раз» + bootstrap endpoint `admin_ensure_grand_admin` (только если таблица пуста и initData === ADMIN_TG_ID). **Рекомендация:** bootstrap в migration runner / post-deploy hook.

### 4.2 Таблица `app_settings`

```sql
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by INTEGER NOT NULL
);
```

**Ключи `app_settings` (полный список):**

| Ключ D1 | Fallback env | Default (`config.ts`) |
|---|---|---|
| `payment_amount_vnd` | `PAYMENT_AMOUNT_VND` / `PAYMENT_AMOUNT` | `200 000 VND` |
| `payment_amount_crypto` | `PAYMENT_AMOUNT_CRYPTO` | `8 USDT` |
| `pin_price_week_vnd` | `PIN_PRICE_WEEK_VND` | `500 000 VND` |
| `pin_price_week_crypto` | `PIN_PRICE_WEEK_CRYPTO` | `20 USDT` |
| `pin_price_month_vnd` | `PIN_PRICE_MONTH_VND` | `1 500 000 VND` |
| `pin_price_month_crypto` | `PIN_PRICE_MONTH_CRYPTO` | `60 USDT` |
| `pin_price_lifetime_vnd` | `PIN_PRICE_LIFETIME_VND` | `5 000 000 VND` |
| `pin_price_lifetime_crypto` | `PIN_PRICE_LIFETIME_CRYPTO` | `200 USDT` |
| `qr_vnd_file_id` | `QR_VND_FILE_ID` | — |
| `qr_trc20_file_id` | `QR_USDT_TRC20_FILE_ID` | — |
| `qr_bybit_file_id` | `QR_USDT_BYBIT_FILE_ID` | — |
| `qr_solana_file_id` | `QR_USDT_SOLANA_FILE_ID` | — |

Приоритет чтения: **D1 → env → hardcoded default**. `methodKey` в upload (`vnd`, `trc20`, …) маппится на ключ `qr_{methodKey}_file_id`.

**Маппинг QR в `getConfigWithSettings`:** для каждого `QR_PAYMENT_METHODS[].methodKey` — `file_id` из `qr_{methodKey}_file_id` (D1), иначе `env[propertyKey]`. В `AppConfig.qr` v1 сохранить ключи **`methodKey`** (`vnd`, `trc20`, …), чтобы не ломать `telegram.ts` / отправку QR пользователю; при рефакторе v2 — единый словарь.

### 4.3 Расширение `users` (обязательно)

Файл: `worker/src/db/migrations/008_ban_metadata.sql`

```sql
ALTER TABLE users ADD COLUMN banned_at TEXT;
ALTER TABLE users ADD COLUMN banned_by INTEGER;
```

**Обновить `banUser()`:**

```sql
UPDATE users SET banned = 1, banned_at = ?, banned_by = ? WHERE tg_id = ?
```

- `banned_at` — `new Date().toISOString()`
- `banned_by` — `tg_id` модератора (admin или grand_admin)

**Обновить `unbanUser()`:** обнулять `banned`, `banned_at`, `banned_by`.

### 4.4 KV keys

| Key | Value | TTL |
|---|---|---|
| `admin_session:{token}` | `{ tgId, role, createdAt, lastActivityAt }` | до 8 ч sliding |
| `admin_login_fail:{tgId}` | `{ count, windowStart }` | 1800 сек |
| `app_settings_cache` | JSON | 60 сек |

### 4.5 Types

```typescript
export type AdminRole = 'grand_admin' | 'admin';

export interface Admin {
  tg_id: number;
  role: AdminRole;
  password_hash: string | null;
  password_salt: string | null;
  created_at: string;
  created_by: number | null;
  updated_at: string;
}

export interface User {
  // ...
  banned?: number;
  banned_at?: string | null;
  banned_by?: number | null;
}
```

---

## 5. Backend — Cloudflare Worker

### 5.1 `worker/src/handlers/admin.ts`

| Action | RBAC | Описание |
|---|---|---|
| `admin_check_access` | initData | `{ isAdmin, role?, needsPasswordSetup? }`; внутри — **`admin_ensure_grand_admin`** если `tgId === ADMIN_TG_ID` и таблица `admins` пуста (§14.4 B3) |
| `admin_setup_password` | grand_admin, hash empty | первичный пароль + auto session |
| `admin_login` | in admins, hash set | `{ adminToken, role }` |
| `admin_verify_session` | session | `{ valid, role }` |
| `admin_logout` | session | — |
| `admin_change_password` | session | current + new + confirm |
| `admin_get_settings` | **grand_admin** | цены + QR status |
| `admin_update_settings` | **grand_admin** | partial settings |
| `admin_upload_qr` | **grand_admin** | methodKey + image |
| `admin_list_banned` | admin+ | + bannedAt, bannedBy, bannedByLabel |
| `admin_unban_user` | admin+ | + bot notify |
| `admin_list_admins` | **grand_admin** | список role=admin |
| `admin_add_admin` | **grand_admin** | tg_id + password |
| `admin_remove_admin` | **grand_admin** | target tg_id; **удалить KV-сессии** удалённого admin |
| `admin_ensure_grand_admin` | initData === `ADMIN_TG_ID`, таблица `admins` пуста | idempotent seed grand_admin (fallback deploy) |

**Helpers (`worker/src/utils/admin-auth.ts` — NEW):**

```typescript
hashPassword(password, salt?): Promise<{ hash, salt }>
verifyPassword(password, hash, salt): Promise<boolean>
async function isAdmin(db, tgId): Promise<boolean>  // строка в admins И users.banned !== 1
async function isGrandAdmin(db, tgId): Promise<boolean>  // role grand_admin + не banned
async function getAdminRole(db, tgId): Promise<AdminRole | null>
async function assertAdminSession(env, initData, token): Promise<{ tgId, role } | Response>
async function assertGrandAdminSession(...): Promise<...>
async function createAdminSession(env, tgId, role): Promise<string>
async function touchAdminSession(env, token): Promise<void>
async function resolveAdminLabel(db, tgId): Promise<string>  // @user или ID
```

### 5.2 Изменения в существующих файлах

| Файл | Изменение |
|---|---|
| `telegram.ts` | `isAdmin` / `isGrandAdmin`; QR → D1; notify all admins: listings notify, **payment proof**, **pin proof**, contact; callbacks incl. **pin_** |
| `telegram-api.ts` | `sendModerationToAdmins()`, `getAdminIds(db)` — рассылка в каждый chat admin |
| `helpers.ts` | `banUser` + metadata, `unbanUser`, `isStaffTgId(db, tgId)` guard (любой admin/grand_admin) |
| `config.ts` | `getConfigWithSettings()` |
| `listings.ts`, `portfolio.ts` | рассылка модерации всем admins |
| `env.ts` | **убрать** `ADMIN_PASSWORD_HASH` (не добавлять) |

### 5.3 Контракты API (ключевые)

#### `admin_check_access`

```json
{ "ok": true, "isAdmin": true, "role": "grand_admin", "needsPasswordSetup": false }
{ "ok": true, "isAdmin": false }
```

#### `admin_setup_password`

```json
// Request
{ "action": "admin_setup_password", "password": "...", "passwordConfirm": "..." }
// Response (поле API — adminToken; в sessionStorage сохранять как adminSessionToken)
{ "ok": true, "adminToken": "...", "role": "grand_admin" }
// Errors: passwords_mismatch, password_too_weak, already_setup, not_grand_admin
```

#### Общий envelope protected admin API

```json
{
  "action": "admin_list_banned",
  "initData": "<Telegram WebApp initData>",
  "adminToken": "<32-byte hex from login/setup>",
  "page": 1
}
```

Ошибки auth: `Invalid initData`, `session_expired`, `forbidden`, `user_banned`, `too_many_attempts`.

#### `admin_login`

```json
// Request: initData + password (без adminToken)
{ "ok": true, "adminToken": "...", "role": "admin" }
```

#### `admin_list_banned`

```json
{
  "ok": true,
  "users": [{
    "tgId": 123,
    "username": "user",
    "firstName": "Ivan",
    "bannedAt": "2026-05-01T12:00:00.000Z",
    "bannedBy": 456789,
    "bannedByLabel": "@moderator"
  }],
  "total": 3,
  "page": 1
}
```

#### `admin_add_admin`

```json
// Request
{ "action": "admin_add_admin", "adminToken": "...", "targetTgId": 999, "password": "...", "passwordConfirm": "..." }
// Response
{ "ok": true, "added": { "tgId": 999 } }
// Errors: duplicate_admin, invalid_target, cannot_add_grand_admin
```

#### `admin_update_settings`

```json
// grand_admin only
{ "ok": false, "error": "forbidden" }  // для role=admin
```

### 5.4 Логирование

| action | details |
|---|---|
| `admin_setup_password` | grand_admin tg_id |
| `admin_login` | success / fail |
| `admin_change_password` | tg_id |
| `admin_add_admin` | target tg_id |
| `admin_remove_admin` | target tg_id |
| `admin_settings_update` | changed keys |
| `admin_qr_upload` | methodKey |
| `admin_unban` | target tg_id, by tg_id |

---

## 6. Frontend — `catalog.html`

### 6.1 Кнопка «Админ»

- Показывать при `isAdmin === true` (любая роль).
- Клик: `needsPasswordSetup` → popup; иначе login или dashboard.

### 6.2 Экраны и modals

| id | Назначение |
|---|---|
| `#adminSetupPasswordModal` | Первичный пароль grand_admin |
| `#screenAdminLogin` | Вход |
| `#screenAdminChangePassword` | Смена пароля |
| `#screenAdmin` | Панель (role-based) |
| `#adminConfirmPricesModal` | Подтверждение цен |

### 6.3 JS-модуль ADMIN

```javascript
var _adminSessionToken = sessionStorage.getItem('adminSessionToken') || '';
var _adminRole = sessionStorage.getItem('adminRole') || '';  // только для UI; RBAC — на backend
```

async function initAdminAccess()
function showAdminSetupPasswordModal()
async function adminSetupPassword(p1, p2)
async function adminLogin(password)
async function adminChangePassword(current, p1, p2)
function renderAdminDashboard()  // hide/show sections by _adminRole
function openConfirmPricesModal(changedFields, onConfirm)
async function adminAddAdmin(tgId, p1, p2)
async function adminRemoveAdmin(tgId)
// ... loadBannedUsers, unbanUser, saveSettings, uploadQr
```

### 6.4 Role-based UI

```javascript
function renderAdminDashboard() {
  var isGrand = _adminRole === 'grand_admin';
  document.querySelectorAll('[data-admin-grand-only]').forEach(function (el) {
    el.hidden = !isGrand;
  });
}
```

Секции grand-only помечать `data-admin-grand-only` в HTML.

---

## 7. План реализации (фазы)

| Фаза | Задачи | Оценка |
|---|---|---|
| **1. D1** | `007_admins_and_settings`, `008_ban_metadata`, seed grand_admin, types | 1.5 ч |
| **2. admin-auth** | PBKDF2, sessions, RBAC helpers | 2 ч |
| **3. admin API** | все actions §5.1 | 3 ч |
| **4. telegram refactor** | isAdmin/isGrandAdmin, notify all, QR→D1 | 2.5 ч |
| **5. settings + QR** | getConfigWithSettings, payment/pins | 2 ч |
| **6. Frontend** | popup setup, login, role UI, modals, banned, admins CRUD | 4 ч |
| **7. E2E + docs** | чеклист, DEPLOY_GUIDE | 1.5 ч |

**Итого:** ~2.5–3 рабочих дня.

---

## 8. Рекомендации команды

### 8.1 Один grand_admin — намеренно

Делегирование через role `admin`, а не второй grand_admin — проще audit и защита настроек/QR. Смена grand_admin (передача проекта) — **ручная операция в D1** + смена `ADMIN_TG_ID` в env (v2: процедура в DEPLOY_GUIDE).

### 8.2 Пароль нового admin задаёт grand_admin

Передача пароля — **вне полосы** (лично / Signal). В v2: одноразовая ссылка или forced change on first login. v1: grand_admin задаёт пароль в форме добавления.

### 8.3 Модерация остаётся в боте для обеих ролей

Mini App для admin — **разбан и смена пароля**, не дубликат inline-кнопок модерации.

### 8.4 Уведомления всем admins

Иначе добавленный admin не увидит новые анкеты. Дублирование сообщений — приемлемая цена; v2 — «дежурный модератор».

### 8.5 Не показывать hash / token в UI

После add admin — только «Администратор добавлен», без повторного показа пароля.

### 8.6 E2E (расширенный)

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | Обычный user | Нет кнопки «Админ» |
| 2 | Grand_admin, нет пароля | Popup setup, затем dashboard |
| 3 | Admin login | Только секция «Забаненные» |
| 4 | Admin → update_settings | 403 |
| 5 | Admin → upload_qr | 403 |
| 6 | Admin → add_admin | 403 |
| 7 | Grand_admin → add admin | Admin видит кнопку, login OK |
| 8 | Grand_admin → remove admin | Admin теряет доступ |
| 9 | Ban в боте admin | `banned_by` = admin tg_id |
| 10 | Список banned | Дата + кто забанил |
| 11 | Простить | User получает сообщение в бот |
| 12 | Простить admin | Guard, ошибка |
| 13 | Save prices | Modal было→стало → save |
| 14 | Session 8h idle | Re-login |
| 15 | QR в боте от admin | Игнор / «только главный администратор» |
| 16 | Moderation callback от admin | Работает |
| 17 | Admin банит другого admin в боте | Guard, только grand_admin |
| 18 | Remove admin | KV-сессии удалённого admin недействительны |
| 19 | Session 24h от login | Re-login даже при активности |
| 20 | Забаненный admin (users.banned=1) | Login 403, модерация в боте блокируется |

---

## 9. Решения заказчика (зафиксировано 31.05.2026)

| # | Вопрос | **Решение** |
|---|---|---|
| 1 | Сколько админов | ✅ **Один grand_admin** + добавляемые **admin**; grand_admin добавляет admin в UI |
| 2 | Пароль | ✅ **Через UI**; grand_admin — popup при отсутствии hash в БД; **без** wrangler secret |
| 3 | TTL сессии | ✅ **Sliding 8 ч**, max **24 ч** от login (безопасность > удобство) |
| 4 | Дата / кто забанил | ✅ **Обязательно** (`banned_at`, `banned_by`) |
| 5 | Уведомление при разбане | ✅ **Да**, сообщение в бот |
| 6 | Бот `/qr*` | ✅ **Только grand_admin**; upload пишет в D1; admin — модерация в боте без QR |
| 7 | Подтверждение цен | ✅ **Modal** после «Сохранить» с diff было→стало |

### Открыто на v2 (не блокирует v1)

| # | Тема | Рекомендация |
|---|---|---|
| R1 | Принудительная смена пароля admin при первом входе | Одноразовый флаг `must_change_password` |
| R2 | Передача роли grand_admin | Runbook в DEPLOY_GUIDE, не UI |
| R3 | Badge «N новых на модерации» в Mini App | После стабилизации v1 |
| R4 | Proxy preview QR в Mini App | `/api/admin/qr-preview` |

---

## 10. Риски и ограничения

| Риск | Митигация |
|---|---|
| Потеря пароля grand_admin | Recovery только через D1 reset + доверенный доступ к Cloudflare (runbook) |
| Спам модерации N admins | Приемлемо в v1; v2 — routing |
| PBKDF2 CPU на Worker | 100k iterations, rate limit login |
| Seed grand_admin не выполнен | Bootstrap check при `admin_check_access` для ADMIN_TG_ID |

---

## 11. Контрольный список перед деплоем

- [ ] `wrangler d1 migrations apply` (007, 008)
- [ ] Проверен seed grand_admin (`ADMIN_TG_ID`)
- [ ] Grand_admin: popup setup → login → все секции
- [ ] Admin: ограниченный UI + модерация в боте
- [ ] Smoke все admin API + 403 matrix
- [ ] Обновить `networking_nhatrang_tz.md`, `DEPLOY_GUIDE_CF.md`

---

## 12. Связанные файлы

| Файл | Роль |
|---|---|
| `catalog.html` | Admin UI, modals, role-based sections |
| `worker/src/handlers/admin.ts` | **NEW** |
| `worker/src/utils/admin-auth.ts` | **NEW** — hash, session, RBAC |
| `worker/src/handlers/telegram.ts` | isAdmin, multi-notify, QR D1 |
| `worker/src/services/telegram-api.ts` | `sendModerationToAdmins` |
| `worker/src/utils/helpers.ts` | ban/unban metadata |
| `worker/src/db/migrations/007_admins_and_settings.sql` | **NEW** |
| `worker/src/db/migrations/008_ban_metadata.sql` | **NEW** |

---

## 13. Промпты для Cursor (детальные)

> Выполнять **по порядку**. Каждый промпт — отдельная сессия / PR. Перед стартом прочитать `admin_profile_TZ.md` v1.3 целиком и связанные файлы из §12.
>
> **Итого промптов: 8** (промпты 1–7 — обязательные; промпт 8 — опционально, Playwright).

---

### Промпт 1 — D1: migrations 007–008, types, ban metadata

```
Реализуй фазу 1 из admin_profile_TZ.md v1.3 §4 и §7.

Контекст:
- Последняя миграция: worker/src/db/migrations/006_banned.sql (только колонка banned).
- banUser сейчас: worker/src/utils/helpers.ts — UPDATE users SET banned=1 без metadata.
- types User: worker/src/types.ts — нет banned/banned_at/banned_by.

Задачи:
1. Создать worker/src/db/migrations/007_admins_and_settings.sql:
   - таблицы admins и app_settings (схема §4.1–4.2);
   - seed grand_admin НЕ в SQL (D1 не читает env) — см. п.3.
2. Создать worker/src/db/migrations/008_ban_metadata.sql:
   - ALTER users ADD banned_at, banned_by.
3. Post-deploy seed: wrangler script или handler admin_ensure_grand_admin (§5.1) —
   INSERT OR IGNORE grand_admin из env.ADMIN_TG_ID, password_hash=NULL.
4. Обновить worker/src/types.ts: Admin, AdminRole, расширить User.
5. Обновить banUser(tgId, username, firstName, bannedBy, db):
   banned_at=ISO, banned_by=moderator tg_id.
6. Добавить unbanUser(tgId, db) — обнулить banned, banned_at, banned_by.
7. Добавить isStaffTgId(db, tgId): true если tg_id в admins (любая роль).

Не трогать: telegram.ts, catalog.html, admin API.

Критерии готовности:
- wrangler d1 migrations apply проходит на локальной/remote D1.
- banUser пишет banned_at/banned_by; unbanUser очищает их.
- TypeScript компилируется без ошибок.
```

---

### Промпт 2 — admin-auth: PBKDF2, KV-сессии, rate limit

```
Реализуй worker/src/utils/admin-auth.ts по admin_profile_TZ.md v1.3 §1.2, §3.7, §5.1.

Задачи:
1. hashPassword / verifyPassword — PBKDF2-SHA256, Web Crypto, salt 16 байт random,
   iterations ≥100_000, хранение: password_salt=base64, password_hash=base64(PBKDF2 output).
2. Валидация пароля §1.2 A3: min 12, ≥1 буква, ≥1 цифра.
3. createAdminSession → token 32 байт hex; KV admin_session:{token} =
   { tgId, role, createdAt, lastActivityAt }; TTL = min(8h, 24h - age).
4. assertAdminSession(env, initData, adminSessionToken):
   validateMiniAppRequest + проверка KV + sliding 8h + hard 24h + touch lastActivityAt.
5. assertGrandAdminSession — assertAdminSession + role==='grand_admin'.
6. Rate limit login: KV admin_login_fail:{tgId}, 5 fails / 15 min → block 30 min.
7. deleteAdminSessionsForTgId(env, tgId) — для admin_remove_admin.
8. resolveAdminLabel(db, tgId) — @username или String(tgId).
9. isAdmin / isGrandAdmin / getAdminRole — D1 admins; isAdmin/isGrandAdmin = false если users.banned=1 (§14.2 G2).
10. При login/setup: reject если users.banned=1 (error: user_banned).

Не регистрировать actions в api.ts — только utils + unit smoke в комментарии.

Критерии: assertAdminSession возвращает 401 session_expired / 403 forbidden;
rate limit возвращает too_many_attempts.
```

---

### Промпт 3 — admin API handler + routing

```
Создай worker/src/handlers/admin.ts и подключи в worker/src/handlers/api.ts
все actions из admin_profile_TZ.md v1.3 §5.1–5.4.

Зависимости: admin-auth.ts (промпт 2), migrations 007–008 (промпт 1).

Actions:
- admin_check_access (initData only): { isAdmin, role?, needsPasswordSetup? };
  в начале handler — вызов admin_ensure_grand_admin (idempotent seed)
- admin_ensure_grand_admin: seed если admins пуста и tgId===ADMIN_TG_ID; guard COUNT(role=grand_admin)<=1
- admin_setup_password: grand_admin, hash empty, initData, auto session
- admin_login / admin_logout / admin_verify_session / admin_change_password
- admin_get_settings / admin_update_settings (grand_admin)
- admin_upload_qr (grand_admin): methodKey + base64/file → Telegram sendPhoto/getFile → file_id в app_settings
- admin_list_banned (paginated 20): bannedAt, bannedBy, bannedByLabel
- admin_unban_user: guard not staff/self; unbanUser; sendMessage UNBAN_MESSAGE §3.5; log
- admin_list_admins / admin_add_admin / admin_remove_admin (grand_admin)
  add: hash password, created_by, ensureUser(targetTgId) для имени в списке, notify bot;
  remove: DELETE + deleteAdminSessionsForTgId

RBAC: admin role → 403 { ok:false, error:'forbidden' } на grand-only endpoints.

Логирование: logAction для всех операций §5.4.

Контракты ответов — §5.3. Ошибки: passwords_mismatch, password_too_weak,
already_setup, duplicate_admin, invalid_target, cannot_add_grand_admin,
cannot_unban_staff, cannot_unban_self, forbidden, too_many_attempts.

Критерии: smoke matrix §8.6 сценарии 4–8, 12 через curl/Playwright API calls.
```

---

### Промпт 4 — telegram refactor: isAdmin, notify all, QR→D1

```
Рефактор worker/src/handlers/telegram.ts и worker/src/services/telegram-api.ts
по admin_profile_TZ.md v1.3 §3.6.

Сейчас везде config.adminTgId / env.ADMIN_TG_ID — единственный админ.

Задачи:
1. telegram-api.ts: getAdminIds(db), sendModerationToAdmins(db, env, text, keyboard?),
   sendToAllAdmins(db, env, text) для contact messages.
2. Заменить проверки callback модерации: isAdmin(fromId, db) вместо fromId===adminTgId.
3. QR /qr, /qr_help, /qr_status, photo upload — isGrandAdmin(fromId, db) only;
   admin upload → ответ «только главный администратор».
4. QR photo upload grand_admin → сохранять file_id в D1 app_settings (ключ qr_{methodKey}_file_id),
   не только env hint.
5. banUserByAdmin / askBanUserConfirmation: guard isStaffTgId(target) — нельзя банить staff;
   только grand_admin может банить admin (admin не может банить admin) — §1.1 v1.2.
6. banUser(..., bannedBy=fromId) — metadata.
7. listings.ts submit_listing moderation notify → sendModerationToAdmins (не env.ADMIN_TG_ID).
8. portfolio deferred moderation (telegram.ts) — тоже sendModerationToAdmins.
9. telegram.ts: payment proof (await_payment_proof) и pin proof (await_pin_proof) → sendModerationToAdmins (не config.adminTgId).
10. Contact admin: forward + Reply — isAdmin(fromId); рассылка contact всем admins §3.6.
11. isAdmin(fromId): false если users.banned=1 (модерация и Reply заблокированы).

Сохранить: ADMIN_TG_ID в env для seed grand_admin, не удалять.

Критерии: E2E §8.6 #9, #15, #16, #17, #20.
```

---

### Промпт 5 — getConfigWithSettings + payment/pins

```
Реализуй динамические настройки admin_profile_TZ.md v1.3 §1.6, §4.2, §2.

Задачи:
1. worker/src/services/app-settings.ts (NEW):
   - loadAppSettings(env): D1 → KV cache app_settings_cache TTL 60s → merge с env defaults §4.2.
   - invalidateAppSettingsCache(env) после admin_update_settings / QR upload.
2. config.ts: getConfigWithSettings(env) — async AppConfig; qr[methodKey] из D1 qr_{methodKey}_file_id
   или env[propertyKey] (§4.2 маппинг).
3. Обновить payment.ts, pins.ts, telegram.ts QR send — await getConfigWithSettings(env).
4. get_pin_prices — отдавать актуальные цены из merged config.

Не ломать: открытые payment sessions не пересчитывать (§1.6.2).

Критерии: изменение цены через admin_update_settings отражается в get_pin_prices ≤60s;
QR из D1 используется при отправке пользователю.
```

---

### Промпт 6 — Frontend catalog.html: admin UI

```
Добавь admin UI в catalog.html по admin_profile_TZ.md v1.3 §1.3–1.9, §6.

Задачи:
1. initAdminAccess() при загрузке: admin_check_access → показать/скрыть кнопку «🛠 Админ».
2. Modals/screens §6.2: setup password, login, change password, dashboard, confirm prices.
3. sessionStorage: adminSessionToken, adminRole; в API body отправлять adminToken (§5.3 envelope).
4. renderAdminDashboard(): data-admin-grand-only для секций grand_admin.
5. Banned list: pagination, DD.MM.YYYY HH:mm (timezone Asia/Ho_Chi_Minh или UTC+7 — зафиксировать в UI).
6. Grand_admin: цены (2+6 полей), QR upload×4, admins CRUD.
7. Confirm prices modal: diff было→стало только изменённых полей.
8. admin_verify_session при resume Mini App если token есть.
9. Обработка ошибок §1.4: invalid_password, too_many_attempts, session_expired, forbidden.

Стиль: match existing catalog.html patterns (var API, buildPayload, showScreen).

Критерии: §8.6 сценарии 1–8, 12–14 визуально в Telegram Mini App test.
```

---

### Промпт 7 — E2E, docs, deploy checklist

```
Завершение admin profile по admin_profile_TZ.md v1.3 §8.6, §11, §10.

1. Пройти чеклист §8.6 (20 сценариев) — Playwright или ручной test plan в комментарии PR.
2. Обновить DEPLOY_GUIDE_CF.md:
   - migrations 007–008, seed grand_admin, первый вход popup setup;
   - runbook потери пароля grand_admin (D1 UPDATE password_hash=NULL + reset KV);
   - ADMIN_TG_ID остаётся обязательным env.
3. Обновить networking_nhatrang_tz.md — секция про multi-admin (кратко).
4. Smoke: admin API 403 matrix, обычный user без кнопки «Админ».

Не коммитить secrets. node_modules не включать.
```

---

### Промпт 8 (опционально) — Playwright API smoke

```
Напиши tests/admin-profile.spec.ts (Playwright) для admin_profile_TZ.md v1.3 §8.6.

Mock или test env с известным ADMIN_TG_ID. Покрыть:
- admin_check_access isAdmin false для random user
- admin_login wrong password → too_many_attempts после 5 попыток
- admin_update_settings forbidden для role admin
- admin_list_banned pagination shape

Использовать существующий playwright setup в репозитории если есть.
```

---

## 14. Аудит ТЗ (анализ v1.2 → дополнение v1.3)

> Дата аудита: 31.05.2026. Сверка с кодом: migrations 001–006, `telegram.ts`, `helpers.ts`, `config.ts`, `catalog.html`, `api.ts`.

### 14.1 Критические несостыковки (исправлены в v1.2)

| # | Проблема | Было | Исправление |
|---|---|---|---|
| C1 | Видимость кнопки «Админ» | §1.2 A1 требовал непустой `password_hash`; §0/§1.3 — показывать до setup | A1 разделён: кнопка по записи в `admins`; API — по session token |
| C2 | Бан admin обычным admin | §1.1: admin ✅ «Забанить admin» | Только **grand_admin** может банить admin |
| C3 | Битая ссылка | §1.7 → «§3.6» (там QR/модерация) | → **§3.5** (разбан) |
| C4 | Битая ссылка | §4.2 «см. v1.0 §4.1» — секции нет | Добавлена полная таблица ключей `app_settings` |
| C5 | Bootstrap endpoint | Упомянут в deploy note, не в API §5.1 | Добавлен `admin_ensure_grand_admin` в §5.1 |

### 14.2 Пробелы в ТЗ (закрыты в v1.2)

| # | Пробел | Решение / где зафиксировано |
|---|---|---|
| G1 | `admin_remove_admin` не инвалидировал сессии | §5.1 + промпт 2 `deleteAdminSessionsForTgId` |
| G2 | Забаненный admin (`users.banned=1`) — поведение не описано | Login 403; `isAdmin` в боте проверяет и `users.banned` |
| G3 | Admin без строки в `users` — имя в списке admins | `admin_add_admin`: `ensureUser(targetTgId, …)` или placeholder «—» |
| G4 | Коллизия имени `adminToken` | Portfolio использует `body.token` для preview; session → **`adminSessionToken`** |
| G5 | Коллизия `isAdmin` vs helpers | Helpers: **`isStaffTgId`**; admin-auth: `isAdmin` / `isGrandAdmin` |
| G6 | Формат PBKDF2 в D1 | Промпт 2: salt/hash base64, iterations ≥100k |
| G7 | Timezone даты бана в UI | Asia/Ho_Chi_Minh (UTC+7) — промпт 6 |
| G8 | E2E не покрывал 24h limit, remove admin sessions | §8.6 #18–20 |
| G9 | Payment/pin proof шли только на `config.adminTgId` | §3.6 + промпт 4 п.9 |
| G10 | Контракт body `adminToken` vs sessionStorage | §5.3 envelope + A7 |
| G11 | `AppConfig.qr` ключи env vs D1 methodKey | §4.2 маппинг + промпт 5 |

### 14.3 Расхождения ТЗ ↔ текущий код (ожидаемо, не баг ТЗ)

| Компонент | Сейчас в коде | Целевое по ТЗ |
|---|---|---|
| `006_banned.sql` | Только `banned INTEGER` | + `008`: `banned_at`, `banned_by` |
| `banUser()` | `SET banned=1` | + metadata, `bannedBy` param |
| `unbanUser()` | **отсутствует** | Добавить в helpers |
| `telegram.ts` | ~25 проверок `config.adminTgId` | `isAdmin` / `isGrandAdmin` из D1 |
| `listings.ts:278` | `sendMessage(env.ADMIN_TG_ID, …)` | `sendModerationToAdmins` |
| `telegram.ts` payment/pin proof | `sendPhoto/Message(config.adminTgId, …)` | `sendModerationToAdmins` |
| `config.ts` | Только env | `getConfigWithSettings` + D1 |
| `catalog.html` | Нет admin UI | §6 |
| `api.ts` | Нет admin actions | §5.1 |
| QR в боте | `logAction` + hint в env | grand_admin → D1 `app_settings` |

### 14.4 Потенциальные баги при реализации (watchlist)

| # | Риск | Митигация |
|---|---|---|
| B1 | PBKDF2 100k iter на Worker — latency/login timeout | Один hash на login; не блокировать event loop дольше 500ms без await между |
| B2 | KV TTL ≠ sliding logic | При touch пересчитывать TTL = `min(8h, 24h - (now - createdAt))`; при `now - createdAt ≥ 24h` — reject |
| B3 | `admin_check_access` до seed | Вызывать `admin_ensure_grand_admin` внутри check для `ADMIN_TG_ID` |
| B4 | Grand_admin меняет `ADMIN_TG_ID` в env без D1 | Два grand_admin или ноль — документировать: env и D1 должны совпадать |
| B5 | Спам модерации N admins | Принято v1; dedup по `listing_id` в v2 |
| B6 | `admin_upload_qr` — большие изображения | Лимит размера base64; отправка через Bot API getFile |
| B7 | Race: два grand_admin seed | UNIQUE на role невозможен в SQLite просто — guard «COUNT grand_admin ≤ 1» в коде |
| B8 | Смена пароля не инвалидирует другие сессии того же admin | v1: допустимо; v2: delete all sessions on password change |

### 14.5 Рекомендации (не блокируют v1)

1. **Не использовать `sessionStorage.adminToken`** — конфликт с portfolio admin preview tokens (`portfolio.ts` / `portfolio-auth.ts`).
2. **При `admin_remove_admin`** — DELETE из `admins` + purge KV sessions + опционально bot notify «доступ отозван».
3. **При `admin_add_admin`** — не показывать пароль повторно в UI (§8.5); передача out-of-band.
4. **`getConfigWithSettings`** — единая точка для payment, pins, QR; не дублировать merge в handlers.
5. **Guard бана в боте** — три уровня: self → staff (grand_admin неприкосновенен) → admin может банить только non-staff; grand_admin может банить admin.
6. **Логи** — `admin_login` fail не логировать пароль; только tg_id + IP если есть.
7. **Миграция seed** — предпочтительно `wrangler d1 execute` post-deploy с `$ADMIN_TG_ID`, не hardcode в SQL.
8. **validateMiniAppRequest** — в проекте смешаны `'Invalid initData'` и `'Invalid_initData'`; новые admin endpoints: **`'Invalid initData'`** (как payment.ts).

### 14.6 Статус документа

| Раздел | Готовность к реализации |
|---|---|
| Роли и матрица §1.1 | ✅ после правок v1.2 |
| Auth / session §1.2 | ✅ |
| UI flows §1.3–1.9 | ✅ |
| Архитектура §3 | ✅ |
| Схема D1 §4 | ✅ (ключи app_settings полные) |
| API §5 | ✅ (+ admin_ensure_grand_admin) |
| Frontend §6 | ✅ |
| Промпты §13 | ✅ 8 шт. (7 + 1 opt.) |
| E2E §8.6 | ✅ расширен до 20 сценариев |

**Вердикт v1.3:** критических противоречий нет; можно начинать реализацию с **Промпта 1**.
