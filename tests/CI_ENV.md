# Переменные окружения для тестов (CI и локально)

## Обязательно для CI

| Переменная | Назначение |
|------------|------------|
| `ADMIN_API_URL` | Базовый URL **staging** Worker (без завершающего `/`). Без неё Playwright integration-тесты **пропускаются**, production по умолчанию не используется. |

Пример для CI:

```bash
export ADMIN_API_URL="https://tg-networking-staging.example.workers.dev"
```

## Unit-тесты Worker (без деплоя)

Запуск из корня репозитория:

```bash
cd worker && npm run test
```

или `npm run test:unit` из корня.

Переменные не требуются — проверяются `validateInitData`, `authenticateMiniAppUser` (сверка `tg_id` с `initData`), `rejectUnlessValidTelegramWebhookSecret`.

## Playwright integration (staging)

Все `tests/*.spec.ts` требуют `ADMIN_API_URL`. Дополнительные переменные по сценарию:

| Переменная | Когда нужна |
|------------|-------------|
| `BOT_TOKEN` | IDOR regression, likes smoke, messaging/admin с валидным `initData` |
| `WEBAPP_SECRET` | Если на staging задан и отличается от `getting_more_money` |
| `TELEGRAM_WEBHOOK_SECRET` | Позитивный smoke webhook с корректным header |
| `TEST_ADMIN_TG_ID`, `TEST_ADMIN_PASSWORD` | `admin-profile.spec.ts` |
| `TEST_MESSAGING_*`, `TEST_RANDOM_TG_ID` | Полный блок messaging integration |

### Защита от случайного prod

Если `ADMIN_API_URL` совпадает с production URL (`https://tg-networking-nhatrang.albertkoall.workers.dev`), тесты **пропускаются**, пока не задано:

```bash
export ALLOW_PROD_INTEGRATION_TESTS=1
```

## Рекомендуемый порядок в CI

```bash
cd worker && npm run typecheck && npm run test
cd .. && ADMIN_API_URL="$STAGING_WORKER_URL" npx playwright test
```

## Локально

```powershell
$env:ADMIN_API_URL = "https://<your-staging>.workers.dev"
$env:BOT_TOKEN = "<same as staging Worker BOT_TOKEN>"
npm run test:unit
npm run test:integration
```

Скрипты в корневом `package.json`: `test:unit`, `test:integration`, `test` (unit + integration).
