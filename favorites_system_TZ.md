# ТЗ: Избранное — Нетворкинг Нячанг
### Feature Spec для Cursor · Версия 1.3

**Статус: ✅ Реализовано** (31.05.2026)  
**Стек:** Cloudflare Worker + D1 + KV · фронт `catalog.html`  
**Контекст проекта:** `networking_nhatrang_tz.md`, миграция — `migration_to_cf_d1_TZ.md`  
**Аналог по паттерну:** система лайков — `likes_system_TZ.md`, код — `worker/src/handlers/likes.ts`

> **Changelog 1.3:** патч по ревью v1.2 — убран лишний GET `getFavorites` (`myFavorites` из `getFavoriteCounts`); FK на `users` убран (как у `likes`); `ensureUser` перед INSERT; `tg_id` POST из initData; `purgeListing` + KV; unfavorite на экране «Избранные»; layout 📌/⭐; `previousFavorited`; in-flight lock; уточнены подписи сортировки.
>
> **Changelog 1.2:** правки по ревью — сортировка только на фронте; контракты API (POST `get_favorites` через `buildPayload`); отдельные `renderFavoritesNavigation` / `bindFavoritesCardEvents`; empty state `inactiveCount`; убран phantom KV `favorites:{tg_id}`; export `mapCatalogListing`; auth GET vs POST; toggle `unfavorite` без проверки `active`.
>
> **Changelog 1.1:** зафиксированы решения заказчика — «Избранные»; очистка `favorites` при архивации/удалении карточки; сортировка по `created_at`; поиск по ключевым словам на экране избранного; счётчик «В избранном: N» на карточке; эмодзи ☆/⭐.

---

## 0. Краткое описание фичи

Пользователь может **добавлять карточки специалистов в избранное** (иконка ⭐ на карточке в каталоге). Избранное хранится **персонально** — привязка `tg_id` пользователя ↔ `listing_id` карточки.

На **титульном экране** под кнопкой «Профиль» — кнопка **«Избранные»**, открывающая отдельный экран со списком избранных карточек.

| Требование | Детали |
|---|---|
| Иконка на карточке | Эмодзи: неактивная **☆** (полупрозрачная); активная **⭐** (жёлтая, класс `.is-favorited`) |
| Запись в БД | При нажатии — toggle избранного для текущего пользователя |
| Счётчик на карточке | **«В избранном: N»** — число пользователей, добавивших карточку (аналог «Рекомендуют» у лайков) |
| Экран «Избранные» | Те же карточки, что в каталоге; **20 на страницу**; сортировка по **`created_at` анкеты** (не по `favorited_at`); **поиск по ключевым словам** |
| Фильтр статуса | В списке — **только `status = 'active'`**; при архивации/удалении карточки — **удалять строки из `favorites`** |

### Решения заказчика (v1.1)

| # | Решение |
|---|---|
| 1 | Название: **«Избранные»** (кнопка и заголовок экрана) |
| 2 | Неактивные карточки **скрывать** в UI; записи в `favorites` **удалять** при архивации или удалении карточки |
| 3 | Сортировка: **`created_at` анкеты** (подписи UI: «Сначала новые анкеты» / «Сначала старые анкеты») |
| 4 | **Поиск по ключевым словам** на экране избранного — как в каталоге |
| 5 | **Счётчик «В избранном: N»** на каждой карточке (сколько пользователей добавили в избранное) |
| 6 | Иконка: **эмодзи ☆ / ⭐** (вариант A из §6.3) |

---

## 1. Функциональные требования

### 1.1 Звезда и счётчик на карточке каталога

- На **каждой** карточке в каталоге и на экране «Избранные» — кнопка-звезда + подпись со счётчиком.
- **Не в избранном у текущего пользователя:** ☆ — полупрозрачная (`opacity: 0.45`, `filter: grayscale(1)`).
- **В избранном у текущего пользователя:** ⭐ — полная непрозрачность, класс `.is-favorited`.
- Рядом со звездой (или под ней в той же зоне) — текст **«В избранном: N»**, где `N` — общее число пользователей, добавивших карточку.
- Клик по звезде **не** открывает портфолио и **не** копирует контакт — `stopPropagation`.
- Клик по звезде **не** влияет на лайк («Рекомендуют») — независимые действия.
- Optimistic UI для звезды и счётчика; при ошибке — rollback (как у лайков).

**Расположение:** правый верхний угол обычной карточки; на `.is-pinned` — **левый** верхний (чтобы не перекрывать 📌, см. §6.3).

### 1.2 Кнопка «Избранные» на главном экране

- Расположение: **под** кнопкой «👤 Профиль» в колонке `.hero-actions` внутри `.hero-top`.
- **Миграция вёрстки:** сейчас `#profileBtn` лежит прямо в `.hero-top` — обернуть обе кнопки в новый `<div class="hero-actions">` (см. §6.1).
- Стиль: `.profile-btn`.
- Текст: **«⭐ Избранные»**.
- По нажатию — `showScreen('favorites')` → экран `#screenFavorites`.

### 1.3 Экран «Избранные»

- Заголовок: **«Избранные»**.
- Кнопка «←» — возврат на главный экран.
- Панель инструментов (как `listingsSortBar` в каталоге):
  - **Поиск по ключевым словам** — поле + кнопка сброса ✕ (id: `favoritesKeywordSearch`, `favoritesKeywordClear`).
  - **Сортировка:** «Сначала новые анкеты» (`newest`, `created_at DESC`) / «Сначала старые анкеты» (`oldest`, `created_at ASC`) — по дате **публикации анкеты**, не по дате добавления в избранное.
- Карточки: **тот же HTML**, что `buildListingCardHtml()`.
- Пагинация: **20 карточек**, навигация «Назад / N / Далее» — **`renderFavoritesNavigation()`** (отдельная функция; **не** `renderListingsNavigation()` — та привязана к `showListingsPage` и id `listingsNavPrev/Next`).
- **Без** логики закреплённых (`pin_status`) — плоский список (pinned не выносить на первую страницу).
- Сортировка по `created_at` — **только на фронте** (`applyFavoritesSort`); backend отдаёт unsorted raw-list.
- Фильтрация по ключевым словам — **на фронте**, по полю `keywords` (точное совпадение тега, как `getFilteredListingsRaw()` в каталоге).
- События карточек — **`bindFavoritesCardEvents()`** (отдельно от `bindListingCardEvents`: keyword-теги вызывают `applyFavoritesKeywordFilter`, а не `applyKeywordFilter` каталога).
- Пустые состояния (по полям ответа `get_favorites`, см. §5.1):
  - `totalCount === 0` — «У вас пока нет избранных» + «Нажмите ⭐ на карточке в каталоге».
  - `totalCount > 0`, `listings.length === 0`, `inactiveCount > 0` — «Нет активных избранных карточек» (есть записи в `favorites`, но все карточки не `active`; до `purgeFavoritesForListing`).
  - Пустой результат keyword-фильтра — «Нет анкет с ключевым словом «…»».
- **Unfavorite на этом экране:** после успешного `unfavorite` (или optimistic UI) — удалить карточку из `_favoritesListingsRaw`, уменьшить `_favoritesTotalCount`, пересчитать фильтр/сортировку и вызвать `showFavoritesPage` (если текущая страница пуста — `page - 1`, минимум 1). При `totalCount === 0` — empty state «У вас пока нет избранных».

### 1.4 Правила фильтрации и очистки данных

| Статус карточки | Можно добавить в избранное? | Показывать в «Избранных»? | Запись в `favorites` |
|---|---|---|---|
| `active` | ✅ Да | ✅ Да | Хранить |
| `on_moderation` | ❌ Нет (нет в каталоге) | ❌ Нет | — (добавить нельзя; записей быть не должно) |
| `archived` | ❌ Нет | ❌ Нет | **Удалить** (`purgeFavoritesForListing`) |
| `rejected` | ❌ Нет | ❌ Нет | **Удалить** (`purgeFavoritesForListing`) |

**Очистка `favorites` обязательна при:**
- ручной архивации (`handleArchiveListing`);
- автоархивации в `dailyMaintenance`;
- отклонении модератором (`status = 'rejected'`);
- hard delete listing (`purgeListing` в `portfolio-db.ts` — CASCADE в D1 + **явная** инвалидация KV `favorites_all`).

```sql
DELETE FROM favorites WHERE listing_id = ?;
```

Вызывать **сразу после** смены статуса / удаления, до ответа клиенту. Инвалидировать KV-кэш **`favorites_all`** (§5.4).

---

## 2. Нефункциональные требования

- **Безопасность:** все операции — с валидным `initData`. **GET** `/api?action=…` — `validateTelegramInitData`; `tg_id` берётся **только** из результата валидации, не из query/body. **POST** `/api` (`get_favorites`) — `validateMiniAppRequest(body, env)` + **`tg_id` из initData** (не доверять `body.tg_id` без сверки — см. §5.1).
- **Производительность:** двухфазная загрузка — карточки → фоном **`getFavoriteCounts`** (+ `getLikes`); отдельный GET `getFavorites` **не нужен** — `myFavorites` строится из `favoritedByMe` (как `myLikes` из `getLikes`).
- **Optimistic UI:** мгновенная смена звезды и ±1 к счётчику; rollback при ошибке.
- **Обратная совместимость:** не ломать лайки, закрепления, портфolio, профиль, форму.
- **Аддитивность:** новая миграция D1, новый handler, новый экран.

---

## 3. Архитектура

### 3.1 Общая схема

```
[Telegram Mini App — catalog.html]
        │
        ├── Каталог (screenListings)
        │     ├── POST get_listings
        │     ├── GET  getFavoriteCounts   → favoriteCountState + myFavorites (favoritedByMe)
        │     └── GET  toggleFavorite      → add/remove + newCount
        │
        └── Избранные (screenFavorites)
              ├── POST get_favorites       → raw listings + totalCount/inactiveCount
              ├── keyword filter (frontend)
              └── sort + pagination (frontend only, created_at)
                        │
                        ▼
              [Cloudflare Worker]
                        │
        favorites.ts ←→ D1 (favorites, listings)
        listings.ts  ←→ cleanup on archive
        KV CACHE: favorites_all (180 сек)
```

### 3.2 Поток: toggle избранного

```
[Клик ⭐]
  → if pendingFavorites[listingId] — return (in-flight lock, §8.2)
  → Optimistic UI (звезда + newCount ±1); сохранить previousFavorited + previousCount ДО изменения (урок из likes_system_TZ.md)
  → GET toggleFavorite
      → validateTelegramInitData → tg_id из validation.userId
      → if type=favorite: listing status must be 'active'; ensureUser(tg_id, …) перед INSERT
      → if type=unfavorite: проверку active НЕ применять (можно убрать «зависшую» звезду)
      → INSERT OR IGNORE (favorited_at = ISO) / DELETE
      → SELECT COUNT(*) → newCount
      → invalidate KV favorites_all
  → sync UI from response или rollback
  → если экран «Избранные» и unfavorite OK — removeFromFavoritesScreen(listingId) (§1.3)
```

### 3.3 Поток: загрузка экрана «Избранные»

```
[Клик «Избранные»]
  → POST get_favorites (buildPayload — без sort на backend)
  → _favoritesListingsRaw = data.listings; empty state по totalCount/inactiveCount
  → applyFavoritesKeywordFilter + applyFavoritesSort (frontend)
  → showFavoritesPage(1) + bindFavoritesCardEvents
  → initFavoriteCounts() + initLikes() (myFavorites уже заполнен из favoritedByMe; отдельный initFavorites не нужен)
```

### 3.4 Двухфазная загрузка в каталоге

```
Фаза 1 — POST get_listings → render (☆, счётчик 0)
Фаза 2a — GET getFavoriteCounts → «В избранном: N» + myFavorites из favoritedByMe
Фаза 2b — GET getLikes → «Рекомендуют: N»
(параллельно: Promise.all([initFavoriteCounts(), initLikes()]) после showListingsPage — как syncLikeButtonsFromState)
```

---

## 4. Схема данных (D1)

### 4.1 Таблица `favorites`

Файл: `worker/src/db/migrations/005_favorites.sql`

```sql
CREATE TABLE IF NOT EXISTS favorites (
  listing_id    TEXT NOT NULL,
  tg_id         INTEGER NOT NULL,
  favorited_at  TEXT NOT NULL,
  PRIMARY KEY (listing_id, tg_id),
  FOREIGN KEY (listing_id) REFERENCES listings(listing_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_favorites_tg_id ON favorites(tg_id);
CREATE INDEX IF NOT EXISTS idx_favorites_listing ON favorites(listing_id);
```

> **Без FK на `users`** — как у таблицы `likes`: пользователь может добавить в избранное до строки в `users`. Перед INSERT в `handleToggleFavorite` вызывать `ensureUser(tgId, username, firstName, env.DB)` (данные из initData / `Telegram.WebApp.initDataUnsafe.user`).

### 4.2 Обновить `worker/src/db/schema.sql`

Добавить блок `favorites` после секции `likes`.

---

## 5. Backend — Cloudflare Worker

### 5.1 Файл `worker/src/handlers/favorites.ts`

| Функция | Метод | Endpoint | Описание |
|---|---|---|---|
| `handleGetFavoriteCounts` | GET | `/api?action=getFavoriteCounts&initData=…` | Счётчики по карточкам + `favoritedByMe` → на фронте `myFavorites` и `favoriteCountState` |
| `handleToggleFavorite` | GET | `/api?action=toggleFavorite&initData=…&listingId=…&type=favorite\|unfavorite` | Toggle + `newCount` (+ `isFavorited`). Параметр `listingId` — id карточки (аналог `cardId` у лайков) |
| `handleGetFavoritesListings` | POST | `/api` через `buildPayload('get_favorites')` | Raw active listings для экрана «Избранные» + метаданные empty state |

> **`handleGetFavorites` не реализуем в v1** — дублирует `favoritedByMe` из `getFavoriteCounts` (см. §3.4, §8.1).

#### `handleGetFavoriteCounts` (образец: `handleGetLikes`)

```typescript
// Ответ:
{
  success: true,
  favorites: [
    { listingId: 'abc_123', total: 5, favoritedByMe: true },
    ...
  ]
}
```

Реализация: агрегация `SELECT listing_id, COUNT(*) FROM favorites GROUP BY listing_id` + кэш KV `favorites_all` (TTL 180 сек), как `likes_all` в `likes.ts`.

#### `handleToggleFavorite`

- Auth: `validateTelegramInitData` → `tg_id = Number(validation.userId)`.
- `type=favorite`: перед INSERT проверить `listings.status = 'active'`; если не active — `{ success: false, error: 'listing_not_active' }`.
- `type=favorite`: `ensureUser(tg_id, username, firstName, env.DB)` перед INSERT (как в других handler'ах).
- `type=unfavorite`: DELETE без проверки status.
- INSERT: `favorited_at = new Date().toISOString()` (колонка для v2, в v1 не сортируем по ней).
- In-flight: на фронте `pendingFavorites[listingId]` (§8.2); на бэкенде достаточно idempotent INSERT OR IGNORE / DELETE.

Ответ:

```typescript
{ success: true, isFavorited: boolean, newCount: number }
```

После write — `SELECT COUNT(*) AS cnt FROM favorites WHERE listing_id = ?`.

#### `handleGetFavoritesListings`

Auth: `validateMiniAppRequest(body, env)` + **`tg_id` из initData** (распарсить `user.id` из валидного initData; **не** использовать `body.tg_id` для SQL):

```typescript
// helper (favorites.ts — parseInitDataParams уже есть в auth.ts):
function getTgIdFromInitData(initData: string): number | null {
  const params = parseInitDataParams(initData);
  try {
    const user = JSON.parse(params.user || '{}') as { id?: number };
    return user.id ? Number(user.id) : null;
  } catch {
    return null;
  }
}
```

```typescript
// Request — через buildPayload('get_favorites') на фронте:
{
  action: 'get_favorites',
  tg_id: number,
  initData: string,
  secret: string,
  username?: string,
  first_name?: string
}

// Response — POST-стиль проекта (ok, не success):
{
  ok: true,
  listings: [ /* mapCatalogListing */ ],
  totalCount: number,      // COUNT(*) FROM favorites WHERE tg_id = ?
  inactiveCount: number    // totalCount - listings.length (записи без active listing)
}
```

SQL (без ORDER BY — сортировка на фронте):

```sql
SELECT l.listing_id, l.display_name, l.category, l.description, l.experience,
       l.contact_type, l.contacts, l.avatar_emoji, l.created_at, l.expires_at,
       l.pin_status, l.pinned_at, l.pin_expires_at, l.keywords,
       EXISTS(
         SELECT 1 FROM listing_media lm
         WHERE lm.listing_id = l.listing_id AND lm.status = 'active'
       ) AS has_portfolio,
       (SELECT COUNT(*) FROM listing_media lm
        WHERE lm.listing_id = l.listing_id AND lm.status = 'active') AS portfolio_count
FROM favorites f
INNER JOIN listings l ON l.listing_id = f.listing_id AND l.status = 'active'
WHERE f.tg_id = ?
```

`totalCount` / `inactiveCount` — отдельным запросом или подзапросом к `favorites`.

**Mapper:** экспортировать `mapCatalogListing` из `listings.ts` (сейчас private) или вынести в `worker/src/utils/catalog-listing.ts`.

#### `purgeFavoritesForListing(listingId, env)` — shared helper

```typescript
export async function purgeFavoritesForListing(listingId: string, env: Env): Promise<void> {
  await env.DB.prepare('DELETE FROM favorites WHERE listing_id = ?').bind(listingId).run();
  await env.CACHE.delete(FAVORITES_CACHE_KEY);
}
```

### 5.2 Очистка при архивации / отклонении

**`worker/src/handlers/listings.ts` — `handleArchiveListing`:**

После `UPDATE listings SET status = 'archived'`:

```typescript
await purgeFavoritesForListing(listingId, env);
```

**`worker/src/handlers/maintenance.ts` — автоархив:**

После каждого `UPDATE … status = 'archived'`:

```typescript
await purgeFavoritesForListing(listingId, env);
```

**`worker/src/handlers/telegram.ts` — reject модерации:**

После `UPDATE listings SET status = 'rejected'`:

```typescript
await purgeFavoritesForListing(listingId, env);
```

**`worker/src/services/portfolio-db.ts` — `purgeListing` (hard delete):**

Перед `DELETE FROM listings` — явно очистить избранное и KV (CASCADE в D1 сработает, но KV без этого устареет до TTL):

```typescript
await purgeFavoritesForListing(listingId, env);
// затем существующий batch: DELETE likes, listing_media, admin_links, listings
```

> Заодно при hard delete инвалидировать `likes_all` (существующий gap — см. §8.6).

### 5.3 Роутинг

**`worker/src/index.ts`** (GET `/api`):

```typescript
if (action === 'getFavoriteCounts') return handleGetFavoriteCounts(request, env);
if (action === 'toggleFavorite') return handleToggleFavorite(request, env);
```

**`worker/src/handlers/api.ts`:**

```typescript
case 'get_favorites':
  return handleGetFavoritesListings(body, env);
```

### 5.4 Кэш KV

| Ключ | TTL | Содержимое |
|---|---|---|
| `favorites_all` | 180 сек | `[{ listingId, total, userIds[] }]` — агрегат для счётчиков |

Инвалидация: `toggleFavorite`, `purgeFavoritesForListing`.

---

## 6. Frontend — `catalog.html`

### 6.1 HTML — главный экран

Заменить одиночную кнопку `#profileBtn` в `.hero-top` на блок:

```html
<div class="hero-top">
  <div>
    <div class="logo-badge">Нячанг · Вьетнам</div>
    <div class="logo-title">Место<br><span>Встречи</span></div>
  </div>
  <div class="hero-actions">
    <button class="profile-btn" id="profileBtn">👤 Профиль</button>
    <button class="profile-btn" id="favoritesBtn">⭐ Избранные</button>
  </div>
</div>
```

### 6.2 HTML — экран избранного

```html
<div id="screenFavorites" class="screen" hidden>
  <div class="screen-header">
    <button class="back-btn" id="backFromFavorites">←</button>
    <span class="screen-title">Избранные</span>
  </div>
  <div class="listings-sort-bar" id="favoritesSortBar">
    <div class="listings-keyword-search">
      <label for="favoritesKeywordSearch">Поиск по ключевым словам</label>
      <div class="listings-keyword-row">
        <input type="search" id="favoritesKeywordSearch"
               placeholder="Поиск по ключевому слову" autocomplete="off" />
        <button type="button" id="favoritesKeywordClear" hidden aria-label="Сбросить">✕</button>
      </div>
    </div>
    <div class="listings-sort-row">
      <label for="favoritesSortSelect">Сортировка</label>
      <select id="favoritesSortSelect">
        <option value="newest">Сначала новые анкеты</option>
        <option value="oldest">Сначала старые анкеты</option>
      </select>
    </div>
  </div>
  <div id="favoritesContainer"></div>
</div>
```

### 6.3 CSS — звезда (только эмодзи)

```css
.hero-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex-shrink: 0;
}

.listing-card { position: relative; }

.favorite-wrap {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
}

/* На закреплённых карточках 📌 — top-right; звезда — top-left (§8.4) */
.listing-card.is-pinned .favorite-wrap {
  left: 10px;
  right: auto;
}

.favorite-btn {
  background: rgba(255,255,255,0.85);
  border: none;
  border-radius: 50%;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.15rem;
  cursor: pointer;
  padding: 0;
  line-height: 1;
  transition: transform .15s;
}
.favorite-btn:active { transform: scale(0.92); }

.favorite-btn .star-icon { opacity: 0.45; filter: grayscale(1); }
.favorite-btn.is-favorited .star-icon { opacity: 1; filter: none; }

.favorite-count-label {
  font-size: 0.62rem;
  font-weight: 600;
  color: rgba(0,0,0,0.45);
  white-space: nowrap;
  background: rgba(255,255,255,0.8);
  padding: 1px 5px;
  border-radius: 8px;
}
```

### 6.4 JavaScript — модуль FAVORITES

```javascript
var FAVORITES_ENABLED = true;
var myFavorites = new Set();
var favoriteCountState = {};   // { listingId: number }
var pendingFavorites = {};     // { listingId: true } — in-flight lock
var _favoritesListingsRaw = [];
var _favoritesListings = [];   // после keyword filter + sort
var _favoritesTotalCount = 0;  // для empty state и unfavorite на экране
var _favoritesKeywordFilter = '';
var _favoritesSortMode = 'newest';
var _favoritesCurrentPage = 1;
```

| Функция | Назначение |
|---|---|
| `initFavoriteCounts()` | GET `getFavoriteCounts` → `favoriteCountState` + `myFavorites` из `favoritedByMe` |
| `renderFavoriteButton(listingId, isFavorited, count)` | ☆/⭐ + «В избранном: N» |
| `syncFavoriteButtonsFromState()` | Обновить все `.favorite-btn` на странице |
| `toggleFavorite(listingId)` | in-flight lock + optimistic UI + GET `toggleFavorite`; на экране избранного — `removeFromFavoritesScreen` |
| `removeFromFavoritesScreen(listingId)` | Удалить из `_favoritesListingsRaw`, `--_favoritesTotalCount`, re-filter + `showFavoritesPage` |
| `getFilteredFavoritesRaw()` | Фильтр по `_favoritesKeywordFilter` (копия логики каталога) |
| `applyFavoritesKeywordFilter(keyword)` | Как `applyKeywordFilter` |
| `applyFavoritesSort()` | `created_at` newest/oldest |
| `openFavorites()` | POST `buildPayload('get_favorites')` → raw + empty state |
| `showFavoritesPage(page)` | Пагинация 20 в `#favoritesContainer` |
| `renderFavoritesNavigation(total, page, totalPages)` | Nav bar с id `favoritesNavPrev` / `favoritesNavNext` |
| `bindFavoritesCardEvents()` | copy/portfolio/like/favorite/keyword — keyword → `applyFavoritesKeywordFilter` |

### 6.5 Изменение `buildListingCardHtml`

```javascript
var favoriteBlock = cardId
  ? '<div class="favorite-wrap">' +
      '<button type="button" id="favorite-btn-' + cardId + '" class="favorite-btn" ' +
        'aria-label="В избранное" aria-pressed="false">' +
        '<span class="star-icon" aria-hidden="true">☆</span>' +
      '</button>' +
      '<span class="favorite-count-label">В избранном: ' +
        '<span id="favorite-count-' + cardId + '">0</span></span>' +
    '</div>'
  : '';
```

При рендере звезды: класс `.is-favorited` на `.favorite-btn` **и** смена emoji в `.star-icon` (`☆` ↔ `⭐`) — оба шага обязательны (CSS §6.3 стилизует `.is-favorited .star-icon`).

```javascript
function renderFavoriteButton(listingId, isFavorited, count) {
  var btn = document.getElementById('favorite-btn-' + listingId);
  var countEl = document.getElementById('favorite-count-' + listingId);
  if (!btn || !countEl) return;
  var icon = btn.querySelector('.star-icon');
  if (isFavorited) {
    btn.classList.add('is-favorited');
    btn.setAttribute('aria-pressed', 'true');
    if (icon) icon.textContent = '⭐';
  } else {
    btn.classList.remove('is-favorited');
    btn.setAttribute('aria-pressed', 'false');
    if (icon) icon.textContent = '☆';
  }
  countEl.textContent = String(count);
}
```

### 6.6 Поиск по ключевым словам (избранное)

Переиспользовать `normalizeKeywordFilter()`. Привязки:

```javascript
document.getElementById('favoritesKeywordSearch').addEventListener('input', debouncedApply);
document.getElementById('favoritesKeywordClear').addEventListener('click', clearFavoritesKeywordFilter);
```

Логика идентична каталогу: фильтр по `l.keywords`, затем `applyFavoritesSort()` → `showFavoritesPage(1)`.

### 6.7 Привязка событий и `showScreen`

Добавить в `showScreen(name)`:

```javascript
document.getElementById('screenFavorites').hidden = (name !== 'favorites');
```

```javascript
document.getElementById('favoritesBtn').addEventListener('click', openFavorites);
document.getElementById('backFromFavorites').addEventListener('click', function () {
  showScreen('main');
});
```

### 6.8 Навигация и события карточек (экран избранного)

**Не переиспользовать** `renderListingsNavigation()` / обработчики `listingsNavPrev` — они вызывают `showListingsPage`.

```javascript
function renderFavoritesNavigation(totalCount, currentPage, totalPages) {
  if (totalCount <= LISTINGS_PER_PAGE) return '';
  return (
    '<nav class="navigation_bar" aria-label="Навигация по страницам">' +
      '<button type="button" class="nav-bar-btn" id="favoritesNavPrev"' +
        (currentPage <= 1 ? ' disabled' : '') + '>Назад</button>' +
      '<span class="nav-page-circle">' + currentPage + '</span>' +
      '<button type="button" class="nav-bar-btn" id="favoritesNavNext"' +
        (currentPage >= totalPages ? ' disabled' : '') + '>Далее</button>' +
    '</nav>'
  );
}

function bindFavoritesCardEvents() {
  // copy-btn, portfolio-btn, like-btn — как в bindListingCardEvents
  document.querySelectorAll('#favoritesContainer .favorite-btn').forEach(function (btn) {
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var cardId = btn.id.slice('favorite-btn-'.length);
      if (cardId) toggleFavorite(cardId);
    });
  });
  document.querySelectorAll('#favoritesContainer .keyword-tag').forEach(function (btn) {
    btn.addEventListener('click', function () {
      applyFavoritesKeywordFilter(btn.getAttribute('data-keyword'));
    });
  });
  // card-desc-toggle — как в каталоге
}
```

В `showFavoritesPage` после рендера — `bindFavoritesCardEvents()` и listeners на `favoritesNavPrev/Next` → `showFavoritesPage(page ± 1)`.

```javascript
function removeFromFavoritesScreen(listingId) {
  if (!document.getElementById('screenFavorites') || document.getElementById('screenFavorites').hidden) return;
  _favoritesListingsRaw = _favoritesListingsRaw.filter(function (l) {
    return String(l.listing_id || '') !== listingId;
  });
  _favoritesTotalCount = Math.max(0, _favoritesTotalCount - 1);
  myFavorites.delete(listingId);
  applyFavoritesKeywordFilter(_favoritesKeywordFilter);
  var filtered = getFilteredFavoritesRaw();
  var totalPages = Math.max(1, Math.ceil(filtered.length / LISTINGS_PER_PAGE));
  var page = Math.min(_favoritesCurrentPage, totalPages);
  showFavoritesPage(page);
}
```

Вызывать из `toggleFavorite` после optimistic unfavorite (или после OK ответа) — §1.3, §3.2.

---

## 7. План реализации (фазы)

| Фаза | Задачи | Оценка |
|---|---|---|
| **1. D1** | `005_favorites.sql`, `schema.sql`, migrate remote | 30 мин |
| **2. Backend GET** | getFavoriteCounts, toggleFavorite + KV + ensureUser | 2 ч |
| **3. Backend POST + cleanup** | get_favorites; purge в archive/reject/maintenance/purgeListing | 2 ч |
| **4. Frontend UI** | hero-actions, screenFavorites + keyword bar, CSS | 1.5 ч |
| **5. Frontend logic** | FAVORITES MODULE, buildListingCardHtml, counts | 3 ч |
| **6. Frontend favorites screen** | sort, keyword filter, `renderFavoritesNavigation`, `bindFavoritesCardEvents` | 1.5 ч |
| **7. Deploy + E2E** | wrangler deploy, smoke, docs | 1 ч |

**Итого:** ~1.5 рабочих дня.

---

## 8. Рекомендации

### 8.1 Паттерн «как лайки» — что копировать, что отличается

**Копировать из `likes.ts`:**
- KV `favorites_all` (аналог `likes_all`), TTL 180 сек, инвалидация на write;
- optimistic ±1 + `newCount` в ответе toggle;
- rollback через `previousCount` / `previousFavorited` **до** optimistic update.

**Намеренные отличия от лайков:**
- Один GET `getFavoriteCounts` (как `getLikes`) — счётчики + `favoritedByMe`; отдельный `getFavorites` **не нужен**;
- Toggle: `listingId` + `type=favorite|unfavorite` (у лайков `cardId` + `like|unlike`);
- Debounce toggle **не** нужен — in-flight lock `pendingFavorites` (§8.2);
- `toggleFavorite` при `favorite` проверяет `status=active` + `ensureUser`; `unfavorite` — нет;
- POST `get_favorites` возвращает `{ ok }`, GET — `{ success }` (конвенция проекта);
- Unfavorite на экране «Избранные» удаляет карточку из списка (§1.3).

### 8.2 Debounce и in-flight lock

Для toggle — **без debounce**; вместо него `pendingFavorites[listingId] = true` на время fetch (ignore повторных кликов). Для keyword search — debounce input 300 мс (как в каталоге, если есть).

### 8.3 Сортировка только по `created_at`

Не использовать `favorited_at` для сортировки (решение заказчика). Колонку `favorited_at` всё равно заполнять при INSERT — для возможной сортировки в v2.

### 8.4 Закреплённые в избранном

Не выносить pinned на первую страницу — обычная сортировка по `created_at`. На `.is-pinned` карточках звезда слева (CSS §6.3), 📌 справа — E2E на узком экране.

### 8.5 Тестирование

| # | Сценарий | Ожидание |
|---|---|---|
| 1 | Добавить active в избранное | ⭐, счётчик +1, запись в D1 |
| 2 | Убрать из избранного | ☆, счётчик −1, DELETE |
| 3 | «Избранные» + сортировка | 20/стр, newest/oldest по created_at |
| 4 | Поиск по keyword | Фильтр как в каталоге |
| 5 | Архивация карточки | Не в списке; `favorites` очищены |
| 6 | Отклонение модератором | `favorites` очищены |
| 7 | Счётчик «В избранном: N» | Совпадает с числом записей в D1 |
| 8 | Offline toggle | Rollback звезды, счётчика, alert |
| 9 | `inactiveCount > 0` | Сообщение «Нет активных избранных карточек» |
| 10 | Keyword-тег на экране избранного | Фильтрует избранное, не каталог |
| 11 | Unfavorite на экране «Избранные» | Карточка исчезает из списка без перезагрузки |
| 12 | Pinned + звезда | 📌 справа, ⭐ слева, без перекрытия |
| 13 | `purgeListing` (hard delete) | `favorites` удалены; KV `favorites_all` инвалидирован |

### 8.6 Сопутствующий fix (не блокер избранного)

`purgeListing` сейчас не инвалидирует `likes_all` — при hard delete добавить `env.CACHE.delete(LIKES_CACHE_KEY)` (анalogично `purgeFavoritesForListing`).

---

## 9. Вопросы — статус (закрыто v1.1)

| # | Вопрос | **Решение** |
|---|---|---|
| 1 | «Избранные» или «Избранное»? | ✅ **Избранные** |
| 2 | Удалять записи при архивации? | ✅ **Скрывать в UI + удалять из `favorites`** при архивации/удалении/reject |
| 3 | Сортировка | ✅ **`created_at`** |
| 4 | Поиск по ключевым словам | ✅ **Да**, на экране избранного |
| 5 | Счётчик добавивших | ✅ **«В избранном: N»** на каждой карточке |
| 6 | Эмодзи vs SVG | ✅ **Эмодзи ☆ / ⭐** |

### На будущее (v2+)

- Badge на кнопке «Избранные» с числом активных избранных пользователя.
- Push «Карточка из избранного скоро архивируется».
- Сортировка по `favorited_at` («Недавно добавленные»).

---

## 10. Промпты для Cursor (по узлам)

> Выполнять **последовательно**. Стек: Worker + D1.

---

### Промпт 1 — Миграция D1: таблица `favorites`

```
Контекст: favorites_system_TZ.md v1.3 §4
1. worker/src/db/migrations/005_favorites.sql — таблица favorites + индексы + FK ON DELETE CASCADE (listing_id); БЕЗ FK на users
2. worker/src/db/schema.sql — тот же блок после likes
3. Из каталога worker/: npx wrangler d1 execute networking_nhatrang --remote --file=src/db/migrations/005_favorites.sql
```

---

### Промпт 2 — Backend: GET handlers + KV cache

```
Контекст: favorites_system_TZ.md v1.3 §5.1, образец worker/src/handlers/likes.ts

Создай worker/src/handlers/favorites.ts:

1. handleGetFavoriteCounts — { success, favorites: [{ listingId, total, favoritedByMe }] } + KV favorites_all TTL 180
2. handleToggleFavorite — favorite/unfavorite; tg_id из validateTelegramInitData; favorite only if active + ensureUser; unfavorite always; favorited_at on INSERT;
   return { success, isFavorited, newCount }
3. export purgeFavoritesForListing(listingId, env) — DELETE + invalidate favorites_all

Роуты в worker/src/index.ts: getFavoriteCounts, toggleFavorite (getFavorites НЕ добавлять)
```

---

### Промпт 3 — Backend: POST get_favorites + cleanup on archive

```
Контекст: favorites_system_TZ.md v1.3 §5.1–5.2

1. handleGetFavoritesListings — validateMiniAppRequest; tg_id из initData (getTgIdFromInitData); JOIN favorites+listings active only;
   response { ok, listings, totalCount, inactiveCount }; SQL без ORDER BY
2. Экспорт mapCatalogListing из listings.ts (или worker/src/utils/catalog-listing.ts)
3. api.ts case 'get_favorites'
4. handleArchiveListing — после archive вызвать purgeFavoritesForListing
5. maintenance.ts — после auto-archive вызвать purgeFavoritesForListing
6. telegram.ts reject handler — purgeFavoritesForListing
7. portfolio-db.ts purgeListing — purgeFavoritesForListing перед DELETE listings (+ likes_all cache delete, §8.6)
```

---

### Промпт 4 — Frontend: разметка и стили

```
Файл: catalog.html, favorites_system_TZ.md v1.3 §6.1–6.3, §6.7

1. .hero-top (только screenMain): обернуть profileBtn + favoritesBtn в .hero-actions
2. screenFavorites с favoritesKeywordSearch, favoritesKeywordClear, favoritesSortSelect, favoritesContainer
3. CSS: .hero-actions, .favorite-wrap, .listing-card.is-pinned .favorite-wrap, .favorite-btn, .is-favorited, .favorite-count-label
4. showScreen: добавить screenFavorites; favoritesBtn → openFavorites; backFromFavorites → main
```

---

### Промпт 5 — Frontend: FAVORITES MODULE + карточка

```
Файл: catalog.html, образец LIKES MODULE, favorites_system_TZ.md v1.3 §6.4–6.5

1. FAVORITES MODULE: myFavorites, favoriteCountState, pendingFavorites, initFavoriteCounts (→ myFavorites из favoritedByMe),
   renderFavoriteButton (is-favorited + ☆/⭐), syncFavoriteButtonsFromState,
   toggleFavorite (previousCount/previousFavorited до optimistic; in-flight lock; rollback; newCount; removeFromFavoritesScreen на экране избранного)
2. buildListingCardHtml — favorite-wrap (справа; на .is-pinned — CSS слева)
3. bindListingCardEvents — .favorite-btn click + stopPropagation (каталог)
4. После showListingsPage: initFavoriteCounts() параллельно initLikes(); syncFavoriteButtonsFromState
```

---

### Промпт 6 — Frontend: экран «Избранные» + keyword search

```
Файл: catalog.html, favorites_system_TZ.md v1.3 §6.6–6.8

1. openFavorites — buildPayload('get_favorites'); _favoritesTotalCount; totalCount/inactiveCount для empty states
2. getFilteredFavoritesRaw, applyFavoritesKeywordFilter, clearFavoritesKeywordFilter, removeFromFavoritesScreen
3. applyFavoritesSort — created_at newest/oldest (frontend only)
4. showFavoritesPage — 20 карточек, renderFavoritesNavigation, bindFavoritesCardEvents
5. favoritesSortSelect + favoritesKeywordSearch listeners
6. НЕ использовать renderListingsNavigation / bindListingCardEvents для keyword-тегов
```

---

### Промпт 7 — E2E, деплой, документация

```
1. Из worker/: npx wrangler deploy
2. Smoke: toggleFavorite newCount; getFavoriteCounts favoritedByMe; inactiveCount empty state;
   archive → favorites purged; purgeListing → KV invalidated; unfavorite на экране избранного; pinned+star layout; favoritesNavPrev/Next
3. DEPLOY_GUIDE_CF.md — миграция 005, actions getFavoriteCounts/toggleFavorite/get_favorites
4. networking_nhatrang_tz.md — строка «Избранное»
5. Чеклист §11
```

---

## 11. Контрольный список перед деплоем

- [x] Миграция `005_favorites.sql` на remote D1 (без FK на `users`)
- [x] `getFavoriteCounts` → `{ success, favorites[] }` с `favoritedByMe`; GET auth — `validateTelegramInitData`
- [x] `getFavoriteCounts` / `toggleFavorite` — только с valid `initData`; toggle: `ensureUser` на favorite
- [x] `toggleFavorite` → `{ isFavorited, newCount }`; `favorite` only `active`; `unfavorite` без проверки status; in-flight lock на фронте
- [x] `get_favorites` — `validateMiniAppRequest` + `tg_id` из initData; `{ ok, listings, totalCount, inactiveCount }`; sort на фронте
- [x] `purgeFavoritesForListing` при archive (manual + cron), reject и `purgeListing`
- [x] Unfavorite на экране «Избранные» — `removeFromFavoritesScreen`
- [x] `.listing-card.is-pinned .favorite-wrap` — звезда слева, 📌 справа
- [x] `renderFavoritesNavigation` + `bindFavoritesCardEvents` (не listings-варианты)
- [x] `showScreen` знает `'favorites'`
- [x] Счётчик «В избранном: N» на карточках
- [x] Эмодзи ☆ / ⭐
- [x] Поиск по ключевым словам на экране избранного
- [x] Сортировка по `created_at`
- [x] Пагинация 20
- [x] Optimistic UI + rollback
- [x] `wrangler deploy` + smoke API (§8.5; полный E2E — в Telegram Mini App)

---

## 12. Связанные файлы

| Файл | Изменение |
|---|---|
| `worker/src/db/migrations/005_favorites.sql` | **NEW** |
| `worker/src/db/schema.sql` | favorites |
| `worker/src/handlers/favorites.ts` | **NEW** |
| `worker/src/handlers/api.ts` | `get_favorites` |
| `worker/src/handlers/listings.ts` | purge on archive; export `mapCatalogListing` |
| `worker/src/handlers/maintenance.ts` | purge on auto-archive |
| `worker/src/handlers/telegram.ts` | purge on reject |
| `worker/src/services/portfolio-db.ts` | purgeListing → purgeFavoritesForListing + likes_all KV |
| `worker/src/index.ts` | GET routes |
| `catalog.html` | UI + FAVORITES MODULE |
| `DEPLOY_GUIDE_CF.md` | docs |
| `networking_nhatrang_tz.md` | статус |

---

*Документ: 31.05.2026 · v1.3 (патч по ревью v1.2) · v1.2 · v1.1*
