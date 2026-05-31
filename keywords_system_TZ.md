# Техническое задание: ключевые слова резюме (до 5 слов)

**Версия:** 1.1  
**Дата:** 31.05.2026  
**Статус:** к реализации  
**Источник правды:** этот файл, `worker/`, `catalog.html`, `worker/src/config.ts` (`STOP_WORDS`), `rules.md` / `rules.html`

**Контекст проекта:** Cloudflare Worker + D1 (`worker/src/handlers/listings.ts`), фронт — Telegram Mini App (`catalog.html`). Стоп-слова уже проверяются в `validateListingForm` для поля «О себе и услугах» (`worker/src/utils/validation.ts`).

> **Changelog 1.1:** зафиксированы решения заказчика (§12); UI формы — **чекбокс + 5 полей** (как портфолио); длина слова **до 15**, **только буквы**; popup **«О ключевых словах»**; клик в профиле → каталог категории + автозаполнение поиска; поиск — **только exact match**; добавлены промпты §16.

---

## 0. Краткое резюме

| Что | Поведение |
|-----|-----------|
| Форма анкеты | **Опционально** (0–5 слов): чекбокс «Добавить ключевые слова» → блок из **5 полей** (как `#portfolioUploadBlock`) |
| Каталог (экран категории) | Над «Сортировка» — **поле поиска**; **точное** совпадение с одним из keywords анкеты |
| Карточка в каталоге | Внизу — `{#слово}`; клик = **автозаполнение поиска** + фильтр в **той же категории** |
| Мой профиль | Ключевые слова кликабельны → переход в **каталог категории этой анкеты** + автозаполнение поиска выбранным словом |
| Модерация контента | Стоп-слово → popup «нарушает правила „Место встречи“»; submit блокируется |
| Область поиска | **Только текущая категория** |

**Принцип:** keywords — отдельная колонка D1 (JSON-массив). Поиск не идёт по описанию, только по массиву `keywords`.

---

## 1. Пользовательские сценарии

### 1.1. Заполнение анкеты

1. Пользователь заполняет обязательные поля (как сейчас).
2. По желанию включает чекбокс **«Добавить ключевые слова (до 5)»** — появляется блок с 5 input (аналог `#portfolioUploadBlock`).
3. Нажимает **«О ключевых словах»** — popup с правилами (§5.1).
4. Вводит от 1 до 5 слов (если чекбокс включён; см. §4.4).
5. При стоп-слове — popup §5.2; при неверном формате — status под формой.
6. Чекбокс **выключен** → на сервер уходит `keywords: []`, поля игнорируются.
7. Submit → модерация; админ видит строку «Ключевые слова: …».

### 1.2. Поиск в каталоге

1. Пользователь открывает категорию → `get_listings`.
2. Вводит слово в «Поиск по ключевым словам» (debounce 300 ms).
3. Отображаются анкеты, у которых в `keywords` есть **точное** совпадение (после trim + lowercase).
4. Сортировка применяется к отфильтрованному списку; pinned — по текущим правилам page 1.

### 1.3. Клик `{#слово}` на карточке каталога

1. Клик по тегу → `applyKeywordFilter(word)`:
   - `#listingsKeywordSearch`.value = word;
   - `_keywordFilter` = normalized word;
   - `applyListingsSort()` → `showListingsPage(1)`;
   - `scrollTo(0, 0)`.
2. Категория **не меняется** — пользователь уже на экране этой категории.

### 1.4. Клик по ключевому слову в «Мой профиль»

1. В карточке мини-резюме отображаются `{#слово}` (кнопки).
2. Клик → переход на экран каталога **категории этой анкеты** (`l.category` + icon из `CATEGORIES`).
3. После загрузки `get_listings` — **та же логика**, что клик по тегу в каталоге: автозаполнение поиска + фильтр.
4. Реализация: `openListings(category, icon, { keywordFilter: 'дизайн' })` или `_pendingKeywordFilter` до завершения API.

### 1.5. Сброс фильтра

- Кнопка ✕ у поля поиска или очистка input → показать все анкеты категории.

---

## 2. Архитектура узла

### 2.1. Место в системе

```
catalog.html
  ├─ FORM: checkbox keywords_enabled → #keywordsBlock (5 inputs)
  ├─ POPUP: «О ключевых словах», keywordStopPopup
  ├─ LISTINGS: search + getFilteredListingsRaw + applyKeywordFilter
  ├─ CARD: {#kw} → applyKeywordFilter
  └─ PROFILE: {#kw} → openListings(cat, icon, keyword)

Worker
  ├─ validateKeywords() — letters, length, stop words
  ├─ submit_listing / paid → INSERT keywords JSON
  └─ get_listings / get_my_listings → keywords[]

D1: listings.keywords TEXT DEFAULT '[]'
```

### 2.2. Единая функция фильтра

```javascript
function normalizeKeywordFilter(raw) {
  return String(raw || '').trim().toLowerCase();
}

function applyKeywordFilter(rawKeyword) {
  var kw = normalizeKeywordFilter(rawKeyword);
  _keywordFilter = kw;
  var input = document.getElementById('listingsKeywordSearch');
  if (input) input.value = kw;
  updateKeywordClearVisibility();
  applyListingsSort();
  showListingsPage(1);
}

function getFilteredListingsRaw() {
  if (!_keywordFilter) return _categoryListingsRaw;
  return _categoryListingsRaw.filter(function (l) {
    var list = l.keywords || [];
    return list.some(function (k) { return k === _keywordFilter; });
  });
}
```

Используется из: input поиска, клик на карточке, переход из профиля.

### 2.3. Фильтр на клиенте (v1)

`get_listings` возвращает всю категорию; фильтрация локальная — без нового API. v2: `keyword` в SQL при росте базы.

---

## 3. Модель данных

### 3.1. Миграция D1

Файл: `worker/src/db/migrations/004_keywords.sql`

```sql
ALTER TABLE listings ADD COLUMN keywords TEXT NOT NULL DEFAULT '[]';
```

Обновить `worker/src/db/schema.sql`.

**Формат:**

```json
["дизайн", "брендинг", "логотип"]
```

- 0–5 элементов.
- Каждый: trim + **lowercase** перед сохранением.
- Пустые поля и дубликаты (case-insensitive) отбрасываются.
- Порядок — как заполнил пользователь.

### 3.2. API

| Поле | Тип | Пример |
|------|-----|--------|
| `keywords` | `string[]` | `["дизайн", "макет"]` |

Request `submit_listing`: `keywords_enabled: boolean`, `keywords: string[]` (если enabled).

Handlers: `handleGetListings`, `handleGetMyListings`, `handleSubmitListing`, paid insert в `payment.ts`.

---

## 4. Правила валидации

### 4.1. Формат одного слова (заказчик)

| Правило | Значение |
|---------|----------|
| Количество | **0–5** слов на анкету |
| Длина | **1–15 символов** (после trim) |
| Символы | **Только буквы** (латиница и кириллица, включая `ё`) |
| Цифры | **Запрещены** |
| Спецсимволы | **Запрещены** (`-`, `_`, `#`, пробел и т.д.) |
| Пробелы | **Запрещены** (одно слово на поле) |
| Регистр | При сохранении → **lowercase** |
| Дубликаты | Удалять (case-insensitive) |
| Стоп-слова | Как `checkStopWords`: подстрока `word.includes(STOP_WORDS[i])` |
| Ссылки | `containsLink(keyword)` → `links_forbidden` |
| Отображение | `{#слово}` — `#` только в UI |

**Regex (бэкенд и фронт):**

```typescript
// worker/src/utils/keywords.ts
const KEYWORD_LETTERS_RE = /^[a-zA-Zа-яА-ЯёЁ]+$/;
const KEYWORD_MAX_LEN = 15;
```

После нормализации (lowercase) проверять длину и regex.

### 4.2. Поиск в каталоге

- **Только exact match** по нормализованному токену: `k === _keywordFilter`.
- Поле поиска: пользователь может ввести что угодно; для сравнения — `trim().toLowerCase()`.
- Частичное совпадение, substring, fuzzy — **не используются**.

### 4.3. Чекбокс и обязательность (как портфolio)

| Состояние | Поведение |
|-----------|-----------|
| `keywords_enabled === false` | `keywords: []`, блок скрыт |
| `keywords_enabled === true`, все 5 полей пусты | Ошибка: «Укажите хотя бы одно ключевое слово или снимите галочку „Ключевые слова“» (аналог `portfolio_required`) |
| `keywords_enabled === true`, 1–5 непустых валидных полей | OK |

Итого: **0–5 слов на анкету**, но если блок включён — минимум **1** слово.

### 4.4. Коды ошибок

| error | message (RU) |
|-------|----------------|
| `keyword_stop_word` | Данное слово нарушает правила пользования «Место встречи». |
| `keywords_invalid` | Ключевое слово: только буквы, одно слово, до 15 символов. |
| `keywords_required` | Укажите хотя бы одно ключевое слово или снимите галочку «Ключевые слова». |
| `keywords_limit` | Не более 5 ключевых слов. |

Добавить в `ERRORS` в `catalog.html`.

### 4.5. Сервер

```typescript
// worker/src/utils/keywords.ts
export function parseKeywordsJson(value: string | null | undefined): string[];
export function serializeKeywords(keywords: string[]): string;
export function normalizeKeywordToken(raw: string): string;
export function isValidKeywordToken(token: string): boolean;

export function validateKeywords(
  enabled: boolean,
  raw: unknown,
): { error: null; keywords: string[] } | ListingFormError;
```

- `validateListingForm` / submit: если `keywords_enabled !== true` → `keywords: []` без проверки полей.
- Если `true` → `validateKeywords(true, body.keywords)`.

---

## 5. Изменения UI (`catalog.html`)

### 5.1. Форма — чекбокс + 5 полей (как портфolio)

**Расположение:** после «О себе и услугах», до «Тип контакта» (можно после контактов, перед портфолио — на усмотрение реализации; **рекомендация:** перед портфолио).

```html
<div class="field-item field-keywords">
  <label class="keywords-toggle" id="keywordsToggleLabel">
    <span class="keywords-check-wrap">
      <input type="checkbox" id="keywords_enabled" name="keywords_enabled" class="keywords-check-native" />
      <span class="like-checkbox" aria-hidden="true"></span>
    </span>
    <span class="keywords-toggle-text">Добавить ключевые слова (до 5)</span>
  </label>
  <p class="field-hint">
    <button type="button" class="keywords-about-link" id="keywordsAboutBtn">О ключевых словах</button>
  </p>
  <div id="keywordsBlock" hidden>
    <div class="keywords-inputs">
      <input type="text" id="keyword_1" name="keyword_1" maxlength="15" placeholder="Слово 1" autocomplete="off" />
      <input type="text" id="keyword_2" name="keyword_2" maxlength="15" placeholder="Слово 2" autocomplete="off" />
      <input type="text" id="keyword_3" name="keyword_3" maxlength="15" placeholder="Слово 3" autocomplete="off" />
      <input type="text" id="keyword_4" name="keyword_4" maxlength="15" placeholder="Слово 4" autocomplete="off" />
      <input type="text" id="keyword_5" name="keyword_5" maxlength="15" placeholder="Слово 5" autocomplete="off" />
    </div>
  </div>
</div>
```

**JS (как portfolio):**

- `#keywords_enabled` change → `#keywordsBlock.hidden = !checked`.
- При снятии галочки — очистить 5 input (как сброс слотов портфолио).
- `input`/`blur` на каждом поле: запрет пробелов (`replace(/\s/g,'')`), проверка regex, stop words → popup.
- `getFormData()` → `keywords_enabled`, `keywords: string[]` (только непустые нормализованные).
- `validateFormClient()` → если enabled и 0 слов → `keywords_required`; иначе проверка каждого токена.

**CSS:** переиспользовать паттерны `.field-portfolio`, `.portfolio-toggle`, `.like-checkbox`.

### 5.2. Popup «О ключевых словах»

```html
<div id="keywordsAboutPopup" class="popup-overlay" hidden>
  <div class="popup" role="dialog" aria-labelledby="keywordsAboutTitle">
    <div class="popup-icon">🏷️</div>
    <h3 class="popup-title" id="keywordsAboutTitle">О ключевых словах</h3>
    <div class="popup-text">
      <p>Ключевые слова помогают другим участникам найти ваше резюме в каталоге.</p>
      <ul>
        <li>Необязательно: можно не добавлять или указать <strong>от 1 до 5</strong> слов.</li>
        <li>Одно слово в каждом поле, <strong>до 15 букв</strong>.</li>
        <li>Только <strong>буквы</strong> (русские и английские), без цифр, пробелов и символов.</li>
        <li>Слова должны описывать ваши навыки и услуги.</li>
        <li>Запрещены ссылки и слова, нарушающие <strong>правила «Место встречи»</strong>.</li>
        <li>В каталоге поиск работает по <strong>точному совпадению</strong> слова в рамках выбранной категории.</li>
      </ul>
    </div>
    <button type="button" id="keywordsAboutOk" class="btn btn-primary">Понятно</button>
  </div>
</div>
```

### 5.3. Popup стоп-слова

```html
<div id="keywordStopPopup" class="popup-overlay" hidden>
  <div class="popup" role="dialog">
    <div class="popup-icon">⚠️</div>
    <h3 class="popup-title">Слово не допускается</h3>
    <p class="popup-text">
      Данное слово нарушает правила пользования «Место встречи».
    </p>
    <button type="button" id="keywordStopPopupOk" class="btn btn-primary">Понятно</button>
  </div>
</div>
```

### 5.4. Экран категории — поиск

В `#listingsSortBar`, **над** «Сортировка»:

```html
<div class="listings-keyword-search">
  <label for="listingsKeywordSearch">Поиск по ключевым словам</label>
  <div class="listings-keyword-row">
    <input type="search" id="listingsKeywordSearch"
           placeholder="Точное совпадение слова" autocomplete="off" />
    <button type="button" id="listingsKeywordClear" hidden aria-label="Сбросить">✕</button>
  </div>
</div>
```

**Состояние:**

```javascript
var _currentCategory = '';
var _currentCategoryIcon = '';
var _keywordFilter = '';
var _pendingKeywordFilter = ''; // для перехода из профиля
```

**`openListings(category, icon, opts)`:**

```javascript
function openListings(category, icon, opts) {
  opts = opts || {};
  _currentCategory = category;
  _currentCategoryIcon = icon;
  _keywordFilter = '';
  _pendingKeywordFilter = opts.keywordFilter ? normalizeKeywordFilter(opts.keywordFilter) : '';
  // очистить search input, загрузить get_listings...
  // после успеха:
  if (_pendingKeywordFilter) {
    applyKeywordFilter(_pendingKeywordFilter);
    _pendingKeywordFilter = '';
  }
}
```

### 5.5. Карточка каталога

В конце `buildListingCardHtml` — блок `.card-keywords` с кнопками `.keyword-tag`, текст `{#` + esc(word) + `}`.

Клик → `applyKeywordFilter(data-keyword)`.

### 5.6. Мой профиль

```html
<div class="p-keywords">
  <span class="p-keywords-label">Ключевые слова:</span>
  <button type="button" class="p-keyword-tag keyword-tag-profile"
          data-keyword="дизайн" data-category="Дизайн и creative">{#дизайн}</button>
</div>
```

Обработчик:

```javascript
// data-category = l.category; icon из CATEGORIES.find
openListings(category, icon, { keywordFilter: keyword });
```

Если `keywords` пуст — блок не показывать.

### 5.7. Republish

В `data-action="republish"`: `data-keywords-enabled`, `data-keywords` (JSON массив).  
`goToForm` → включить чекбокс, показать блок, заполнить поля 1..5.

---

## 6. Изменения бэкенда

| Файл | Действие |
|------|----------|
| `worker/src/db/migrations/004_keywords.sql` | ALTER TABLE |
| `worker/src/db/schema.sql` | колонка `keywords` |
| `worker/src/utils/keywords.ts` | parse, serialize, validate |
| `worker/src/utils/validation.ts` | интеграция validateKeywords |
| `worker/src/handlers/listings.ts` | SELECT/INSERT/map, текст модерации |
| `worker/src/handlers/payment.ts` | paid INSERT |

Текст модерации (добавить строку):

```
🏷 Ключевые слова: дизайн, брендинг, логотип
```

(или «—» если массив пуст)

---

## 7. STOP_WORDS на фронте

Константа `STOP_WORDS` в `catalog.html` — **sync with `worker/src/config.ts`**.

```javascript
function keywordViolatesStopWords(word) {
  var lower = normalizeKeywordFilter(word);
  if (!lower) return false;
  for (var i = 0; i < STOP_WORDS.length; i++) {
    if (lower.indexOf(STOP_WORDS[i]) !== -1) return true;
  }
  return false;
}
```

---

## 8. План реализации

| Этап | Содержание | Промпт |
|------|------------|--------|
| 1 | D1 + Worker API + validation | Промпт 1 |
| 2 | Форма: чекбокс, 5 полей, popups, submit | Промпт 2 |
| 3 | Каталог: поиск, фильтр, теги на карточках | Промпт 3 |
| 4 | Профиль: отображение + переход с фильтром | Промпт 4 |
| 5 | rules, DEPLOY_GUIDE, QA | Промпт 5 |

---

## 9. CSS (ориентиры)

```css
.field-keywords { /* как .field-portfolio */ }
.keywords-about-link {
  background: none; border: none; padding: 0;
  color: var(--accent); text-decoration: underline; cursor: pointer;
  font-size: inherit;
}
.keywords-inputs { display: flex; flex-direction: column; gap: 8px; }
.keywords-inputs input { width: 100%; }

.listings-keyword-search { margin-bottom: 12px; }
.listings-keyword-row { display: flex; gap: 8px; align-items: center; }
.listings-keyword-row input { flex: 1; }

.card-keywords, .p-keywords {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border);
}
.keyword-tag, .p-keyword-tag {
  font-size: 12px; padding: 4px 10px; border-radius: 999px;
  background: var(--surface-2, #f0f0f0); border: none; cursor: pointer;
  color: var(--accent, #2563eb);
}
```

---

## 10. Безопасность

- Escaping в `{#слово}` — только через `esc()`.
- Keywords не интерпретируются как HTML/URL.
- Профиль: `data-category` только из серверного `l.category`.

---

## 11. Обратная совместимость

- Существующие listings: `keywords = '[]'`.
- Нет `keywords_enabled` в старом клиенте → сервер трактует как `false`.
- Деплой: **миграция D1 → Worker → catalog.html**.

---

## 12. Решения заказчика (зафиксировано 31.05.2026)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Обязательность | **0–5** слов; блок опционален (чекбокс) |
| 2 | UI формы | **Как портфолио:** чекбокс → 5 полей |
| 3 | Клик в профиле | Переход в **каталог категории анкеты** + **автозаполнение поиска** (та же логика фильтра) |
| 4 | Формат слова | **До 15 символов**, **только буквы**, одно слово, без пробелов; popup **«О ключевых словах»** |
| 5 | Поиск | **Только exact match** |
| 6 | Модерация | Keywords отдельной строкой у админа (**да**) |
| 7 | Старые анкеты | `[]`, без backfill |

---

## 13. Рекомендации команды

1. Одна функция `applyKeywordFilter` для поиска, карточки и профиля.
2. `_pendingKeywordFilter` — чтобы фильтр применился после async `get_listings`.
3. При активном фильтре — hint в шапке: «Поиск: дизайн» + ✕.
4. `logAction(tgId, 'keyword_search', category + ' → ' + kw + ' → ' + count)`.
5. Обновить `rules.md` §3 — пункт про ключевые слова (чекбокс, 5 слов, только буквы).
6. PR-чеклист: `config.ts` STOP_WORDS ↔ `catalog.html`.

---

## 14. Связанные файлы

| Файл | Изменение |
|------|-----------|
| `worker/src/db/migrations/004_keywords.sql` | новый |
| `worker/src/db/schema.sql` | колонка |
| `worker/src/utils/keywords.ts` | новый |
| `worker/src/utils/validation.ts` | validateKeywords |
| `worker/src/handlers/listings.ts` | SELECT/INSERT/map |
| `worker/src/handlers/payment.ts` | INSERT |
| `catalog.html` | форма, 3 popup, search, cards, profile |
| `rules.md`, `rules.html` | пункт |
| `DEPLOY_GUIDE_CF.md` | миграция |

---

## 15. QA-чеклист

| # | Сценарий | Ожидание |
|---|----------|----------|
| 1 | Чекбокс off | submit OK, `keywords: []` |
| 2 | Чекбокс on, 0 слов | `keywords_required` |
| 3 | Слово «дизайн123» | `keywords_invalid` |
| 4 | Стоп-слово | popup, submit blocked |
| 5 | Поиск «дизайн» | exact match only |
| 6 | Поиск «диз» | пусто (не substring) |
| 7 | Клик `{#tag}` в каталоге | search autofill + filter |
| 8 | Клик tag в профиле | openListings(cat) + filter |
| 9 | Фильтр в кат. A | нет карточек из кат. B |
| 10 | Republish | чекбокс + поля заполнены |
| 11 | Старые анкеты | без тегов, `keywords: []` |

---

## 16. Промпты для ИИ (по фазам)

> Выполнять **строго по порядку 1 → 5**.  
> Контекст: `@keywords_system_TZ.md` (v1.1), `@catalog.html`, `@worker/src/handlers/listings.ts`, `@worker/src/utils/validation.ts`, `@worker/src/config.ts`.  
> Не менять логику лайков, портфолио, пинов.

---

### Промпт 1 — D1 и Worker (API + validation)

```
Реализуй Фазу 1 из keywords_system_TZ.md v1.1 (§3, §4, §6).

1. worker/src/db/migrations/004_keywords.sql — ALTER listings ADD keywords TEXT NOT NULL DEFAULT '[]'.
2. Обновить worker/src/db/schema.sql.
3. worker/src/utils/keywords.ts:
   - parseKeywordsJson, serializeKeywords, normalizeKeywordToken
   - isValidKeywordToken: только буквы [a-zA-Zа-яА-ЯёЁ], длина 1–15, без пробелов
   - validateKeywords(enabled, raw): enabled=false → []; enabled=true → 1–5 слов, дедуп, stop words, links
4. worker/src/utils/validation.ts — вызов validateKeywords из submit (keywords_enabled + keywords).
5. worker/src/handlers/listings.ts:
   - SELECT keywords в get_listings и get_my_listings
   - mapCatalogListing / mapMyListing → keywords: string[]
   - INSERT keywords в submit_listing
   - строка модерации «🏷 Ключевые слова: …»
6. worker/src/handlers/payment.ts — keywords в paid INSERT.
7. Коды ошибок: keyword_stop_word, keywords_invalid, keywords_required, keywords_limit.

Не трогать catalog.html. npm run build / tsc без ошибок.
Документировать wrangler d1 execute для 004_keywords.sql.
```

---

### Промпт 2 — Форма catalog.html (чекбокс + 5 полей + popups)

```
Реализуй Фазу 2 из keywords_system_TZ.md v1.1 (§5.1–5.3, §5.7, §7).

1. Блок field-keywords по образцу field-portfolio (§5.1):
   - checkbox #keywords_enabled → #keywordsBlock (5 input maxlength=15)
   - кнопка «О ключевых словах» → #keywordsAboutPopup (§5.2)
   - #keywordStopPopup (§5.3)
2. STOP_WORDS в catalog.html — sync with worker/src/config.ts.
3. JS: toggle block; strip пробелов; regex только буквы; blur/input → stop word popup.
4. getFormData: keywords_enabled, keywords[]; validateFormClient: keywords_required если on и 0 слов.
5. submit_listing / paid payload с keywords_enabled и keywords.
6. ERRORS: keyword_stop_word, keywords_invalid, keywords_required.
7. Republish: data-keywords-enabled, data-keywords; goToForm prefill.

Не трогать listings search и карточки — Фаза 3.
```

---

### Промпт 3 — Каталог: поиск, фильтр, теги на карточках

```
Реализуй Фазу 3 из keywords_system_TZ.md v1.1 (§2.2, §5.4, §9).

1. listingsSortBar: поле «Поиск по ключевым словам» НАД «Сортировка», кнопка сброса.
2. State: _currentCategory, _keywordFilter, _pendingKeywordFilter.
3. openListings(category, icon, opts?) — сброс/применение pending filter после get_listings.
4. getFilteredListingsRaw + рефактор applyListingsSort (фильтр до sort).
5. applyKeywordFilter(raw) — единая точка: input.value, _keywordFilter, sort, page 1.
6. Debounce input 300ms; exact match only (§4.2).
7. buildListingCardHtml: внизу .card-keywords с {#word}; bindListingCardEvents → applyKeywordFilter.
8. Empty state при 0 результатов фильтра.
9. CSS §9.

Не менять форму и профиль — Фазы 2 и 4.
```

---

### Промпт 4 — Мой профиль: ключевые слова + переход в каталог

```
Реализуй Фазу 4 из keywords_system_TZ.md v1.1 (§1.4, §5.6).

1. В profile-card (openProfile): блок .p-keywords с кнопками .keyword-tag-profile {#word}.
2. data-keyword, data-category=l.category; icon из CATEGORIES.
3. Клик → openListings(category, icon, { keywordFilter: keyword }) — автозаполнение поиска и фильтр после загрузки.
4. Переиспользовать applyKeywordFilter / _pendingKeywordFilter из Фазы 3.

Не менять validateKeywords и форму.
```

---

### Промпт 5 — Правила, деплой, регрессия

```
Реализуй Фазу 5 из keywords_system_TZ.md v1.1 (§13, §15).

1. rules.md и rules.html — пункт §3: ключевые слова опционально, до 5, только буквы, правила «Место встречи».
2. DEPLOY_GUIDE_CF.md — шаг миграции 004_keywords.sql (local + remote).
3. keywords_system_TZ.md §17 — отметить фазы по мере выполнения.
4. Ручной QA по §15; регрессия: get_listings, likes, portfolio, pin без поломок.
```

---

## 17. Журнал выполнения

| Фаза | Промпт | Статус | Дата | Примечание |
|------|--------|--------|------|------------|
| 1 | D1 + Worker | ✅ | 31.05.2026 | миграция 004 применена на remote D1 |
| 2 | Форма | ✅ | 31.05.2026 | чекбокс, 5 полей, popups, submit/republish |
| 3 | Каталог search + tags | ⬜ | | |
| 4 | Профиль + navigation | ⬜ | | |
| 5 | Rules + deploy + QA | ⬜ | | |

---

*Документ v1.1 — решения заказчика зафиксированы; промпты §16 для пошаговой реализации в Cursor.*
