# E2E: Администраторский профиль (admin_profile_TZ.md v1.3 §8.6)

> **Стек:** Worker `tg-networking-nhatrang` · D1 `007`–`008` · `catalog.html` · бот  
> **Деплой:** `DEPLOY_GUIDE_CF.md` §D2d  
> **Авто-smoke API:** `worker/scripts/admin-api-smoke.ps1`

Перед прогоном:

- [ ] Миграции `006_banned`, `007_admins_and_settings`, `008_ban_metadata` на remote D1
- [ ] `ADMIN_TG_ID` в `wrangler secret` / env Worker
- [ ] Seed grand_admin: `.\scripts\seed-grand-admin.ps1 -Remote` **или** первый `admin_check_access` от grand_admin (bootstrap)
- [ ] `catalog.html` с admin UI задеплоен на GitHub Pages

---

## Автоматические проверки (без Telegram initData)

| Проверка | Команда / скрипт | Ожидание |
|---|---|---|
| API 401 без initData | `admin-api-smoke.ps1` | `Invalid initData` / 401 |
| Grand-only без сессии | `admin-api-smoke.ps1` | `session_expired` / 401 |
| Регрессия каталога | `get_listings` + secret | `{ ok: true, listings: [...] }` |

---

## Ручной чеклист (20 сценариев §8.6)

| # | Сценарий | Шаги | Ожидание | ✓ |
|---|---|---|---|---|
| 1 | Обычный user | Открыть Mini App не из `admins` | Нет кнопки «🛠 Админ» | ☐ |
| 2 | Grand_admin, нет пароля | Первый вход после seed, `password_hash` NULL | Popup «Установка пароля» → dashboard full | ☐ |
| 3 | Admin login | Grand добавил admin, вход паролем | Только «Забаненные», смена пароля, выход | ☐ |
| 4 | Admin → update_settings | POST / API или UI «Сохранить цены» | `403` / `forbidden` | ☐ |
| 5 | Admin → upload_qr | Загрузка QR в Mini App | `403` / `forbidden` | ☐ |
| 6 | Admin → add_admin | Форма «Добавить администратора» | `403` / `forbidden` | ☐ |
| 7 | Grand → add admin | tg_id + пароль ×2 | Новый admin видит «Админ», login OK, сообщение в бот | ☐ |
| 8 | Grand → remove admin | «Удалить» + confirm | Admin: `isAdmin: false`, кнопка скрыта | ☐ |
| 9 | Ban в боте (admin) | Забанить обычного user | `users.banned_by` = tg_id модератора | ☐ |
| 10 | Список banned | Mini App → Забаненные | Дата `DD.MM.YYYY HH:mm` (UTC+7), «кто забанил» | ☐ |
| 11 | Простить | confirm → unban | User получает `UNBAN_MESSAGE` в бот | ☐ |
| 12 | Простить admin | «Простить» staff | Ошибка `cannot_unban_staff` | ☐ |
| 13 | Save prices | Изменить цену → «Сохранить» | Modal было→стало → toast «Сохранено» | ☐ |
| 14 | Session 8h idle | Не трогать Mini App >8 ч (или сброс KV TTL в dev) | Re-login / `session_expired` | ☐ |
| 15 | QR в боте от admin | Admin шлёт фото QR боту | «только главный администратор» / игнор | ☐ |
| 16 | Moderation callback (admin) | Approve/Reject анкеты | Работает как у grand_admin | ☐ |
| 17 | Admin банит admin | Admin пытается забанить другого admin | Guard, только grand_admin | ☐ |
| 18 | Remove admin | После remove — запрос с старым token | `session_expired` / 401 | ☐ |
| 19 | Session 24h | Активность <24 ч от login, но >24 ч от `createdAt` (dev: подмена KV) | Re-login | ☐ |
| 20 | Забаненный admin | `users.banned=1` для admin | Login `user_banned`; модерация в боте блокируется | ☐ |

---

## Smoke matrix API (403 / auth)

Проверяется скриптом `admin-api-smoke.ps1` (частично) и вручную с валидным `initData` + `adminToken`:

| Action | Роль | Ожидание |
|---|---|---|
| `admin_check_access` | любой user | `isAdmin: false` |
| `admin_check_access` | grand_admin | `isAdmin: true`, `role`, `needsPasswordSetup?` |
| `admin_update_settings` | admin + token | `403 forbidden` |
| `admin_upload_qr` | admin + token | `403 forbidden` |
| `admin_add_admin` | admin + token | `403 forbidden` |
| `admin_list_banned` | admin + token | `200`, `users[]` |
| `admin_get_settings` | admin + token | `403 forbidden` |
| `admin_list_banned` | без token | `401 session_expired` |

---

## PR / релиз

При закрытии промпта 7 приложить к PR:

1. Вывод `admin-api-smoke.ps1`
2. Отмеченные строки таблицы выше (или «пропущено: …» с причиной)
3. Версия Worker после `wrangler deploy` (Version ID из вывода)

*Документ: промпт 7, admin_profile_TZ.md v1.3, 31.05.2026.*
