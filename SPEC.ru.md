# TRAIL — Tracking Records Across Isolated Logs

## Спецификация

**Версия:** 2.1
**Дата:** 2026-04-05
**Статус:** Черновик
**Авторы:** timoncool

---

## Аннотация

TRAIL — легковесный протокол без внешних зависимостей для отслеживания контента через изолированные [MCP](https://modelcontextprotocol.io/)-серверы. Каждый сервер ведёт свой append-only лог; LLM-оркестратор читает все логи и связывает записи по универсальному Content ID. TRAIL обеспечивает дедупликацию, отладку пайплайнов, восстановление после сбоев и аудит — без общего состояния и межсерверной коммуникации.

---

## Проблема

MCP-серверы изолированы по дизайну — каждый сервер не видит другие серверы. Когда несколько MCP-серверов участвуют в контент-пайплайне (например: получить из источника → запостить в мессенджер → кросс-постить в соцсеть), нет стандартного способа:

- Отслеживать какой контент куда был опубликован
- Предотвращать дублирование публикаций
- Отлаживать сломанные пайплайны
- Аудировать полный жизненный цикл контента
- Восстанавливаться после падения оркестратора посреди пайплайна

Спецификация MCP намеренно не описывает коммуникацию между серверами. **Хост** (LLM-агент) — единственный оркестратор. TRAIL использует эту архитектуру: каждый сервер ведёт свой лог, оркестратор читает все логи и связывает их воедино.

---

## Принципы дизайна

1. **Каждый сервер владеет своим логом.** Никакого общего состояния, центральной базы, межсерверной коммуникации.
2. **Оркестратор связывает всё воедино.** LLM читает логи всех серверов и отслеживает контент по `content_id`.
3. **Только дозапись.** Логи — неизменяемый аудит-трейл. Никогда не редактировать и не удалять записи.
4. **Самодокументируемость.** Имена полей читаемы. Лог понятен без обращения к спеке.
5. **Конвенция вместо конфигурации.** Одинаковое имя файла, одинаковый формат, одинаковые поля везде.
6. **Ноль зависимостей.** JSONL + стандартная библиотека. Никаких внешних пакетов.
7. **Готовность к корреляции.** Записи можно связывать в трейсы через опциональный `trace_id`, что обеспечивает интеграцию с OpenTelemetry.

---

## Файл

```
<корень-mcp-сервера>/data/trail.jsonl
```

- **Формат:** JSONL (JSON Lines) — один JSON-объект на строку, UTF-8, `\n` перенос строки
- **Режим записи:** Только дозапись (append-only)
- **Конкурентность:** Сериализовать запись (mutex/lock). Чтение без блокировок.
- **Максимум строки:** 64 КБ (записи больше этого СЛЕДУЕТ обрезать в `details`)

---

## Схема записи

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00.123Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","server":"telegram-mcp","details":{"platform":"telegram","message_id":42}}
```

### Обязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `version` | `int` | Версия протокола. `2` для этой спецификации. |
| `timestamp` | `string` | Временная метка ISO 8601 в UTC с миллисекундами. Когда произошло действие. Пример: `"2026-04-05T14:07:00.123Z"` |
| `content_id` | `string` | Универсальный Content ID. Следует за контентом через все серверы. Формат: `source:type:id`. См. [Content ID](#content-id). |
| `action` | `string` | Выполненное действие. См. [Стандартные действия](#стандартные-действия). |
| `requester` | `string` | Воркфлоу, шедулер-таск или пользователь, инициировавший действие. Совпадает с task ID шедулера. |

### Необязательные поля

| Поле | Тип | Описание |
|------|-----|----------|
| `details` | `object` | Платформенные данные. См. [Поле Details](#поле-details). |
| `trace_id` | `string` | Группирует связанные записи между серверами в один трейс. См. [Корреляция трейсов](#корреляция-трейсов). |
| `server` | `string` | Идентификатор MCP-сервера, записавшего эту запись. См. [Поле Server](#поле-server). |
| `entry_id` | `string` | Уникальный ID записи. Формат: UUIDv7 или `{server}:{timestamp_ms}:{seq}`. См. [Entry ID](#entry-id). |
| `caused_by` | `string` | `entry_id` записи, которая непосредственно вызвала эту. См. [Цепочка причинности](#цепочка-причинности). |
| `tags` | `string[]` | Свободные метки для фильтрации и категоризации. Пример: `["nsfw", "priority:high", "batch:2026-04-05"]` |

---

### Content ID

Формат: `source:type:id`

```
civitai:image:12345
unsplash:photo:abc-def
youtube:video:dQw4w9WgXcQ
runware:image:550e8400
custom:article:my-slug
```

Правила:
- `source` — платформа-источник, lowercase, буквенно-цифровые и дефисы, без двоеточий. Максимум 32 символа.
- `type` — тип контента на источнике. Стандартные типы: `image`, `video`, `audio`, `model`, `prompt`, `post`, `article`, `document`. Допускаются кастомные, lowercase. Максимум 32 символа.
- `id` — идентификатор на источнике, как есть (строка или число). Максимум 256 символов. Не должен содержать переводы строк.
- Content ID **назначается на источнике** и **передаётся без изменений** через каждый сервер в пайплайне

**Regex для валидации:** `^[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,31}:[^\n:]{1,256}$`

---

### Стандартные действия

| Действие | Значение |
|----------|----------|
| `fetched` | Контент получен из источника (список кандидатов) |
| `selected` | Выбран из кандидатов оркестратором |
| `posted` | Успешно опубликован на этой платформе |
| `failed` | Попытка публикации не удалась. Детали в `details.error` |
| `skipped` | Намеренно пропущен. Причина в `details.reason` |
| `retrying` | Предыдущая попытка провалилась, планируется повтор. `details.attempt` — номер попытки |
| `transformed` | Контент модифицирован (ресайз, транскодинг, перевод). `details.transformation` описывает что изменилось |
| `moderated` | Контент прошёл или не прошёл модерацию. `details.result`: `"pass"` или `"reject"`, `details.reason` объясняет почему |
| `expired` | Контент больше не актуален (TTL истёк, источник удалён) |
| `delivered` | Доставка подтверждена платформой (вебхук, уведомление о прочтении) |
| `delegated` | Контент/задача делегирована другому агенту или серверу. `details.delegate_to` — цель, `details.delegation_reason` — причина |
| `received` | Контент получен от другого сервера или агента (пара к `delegated`). `details.received_from` — источник |
| `evaluated` | Оценка качества или релевантности контента. `details.score` — результат (0.0–1.0), `details.evaluator` — метод |
| `guarded` | Контент проверен гардрейлом. `details.guardrail` — имя, `details.passed` — булево, `details.reason` — объяснение |
| `acknowledged` | Подтверждение человеком (human-in-the-loop). `details.acknowledged_by` — кто, `details.decision` — `"approve"` или `"reject"` |

Серверы МОГУТ определять дополнительные действия для внутреннего использования (например, `drafted`, `reviewed`, `voted`). Кастомные действия ДОЛЖНЫ быть в lowercase, одним словом или через дефис, максимум 32 символа.

---

### Поле Details

Поле `details` — открытый объект. Каждый сервер определяет что хранить. Однако некоторые подполя имеют стандартное значение:

#### Стандартные подполя Details

| Поле | Тип | Когда |
|------|-----|-------|
| `details.error` | `object` | При действиях `failed` или `retrying` |
| `details.error.type` | `string` | Категория ошибки: `rate_limit`, `auth`, `validation`, `network`, `server`, `timeout`, `unknown` |
| `details.error.message` | `string` | Человекочитаемое описание ошибки |
| `details.error.retry_after` | `int` | Секунд до повтора (для rate limit) |
| `details.reason` | `string` | Почему контент `skipped` или `moderated` |
| `details.platform` | `string` | Идентификатор целевой платформы (например, `"telegram"`, `"facebook"`) |
| `details.platform_id` | `string` | ID созданного ресурса на целевой платформе |
| `details.url` | `string` | URL опубликованного контента |
| `details.attempt` | `int` | Номер попытки (с 1), для `retrying` и `failed` |
| `details.transformation` | `string` | Какая трансформация применена (например, `"resize:1024x1024"`, `"translate:en→ru"`) |
| `details.result` | `string` | Результат модерации: `"pass"` или `"reject"` |
| `details.cost` | `object` | Информация о стоимости. См. [Трекинг стоимости](#трекинг-стоимости). |
| `details.content` | `object` | Метаданные контента. См. [Метаданные контента](#метаданные-контента). |
| `details.duration_ms` | `int` | Сколько заняло действие в миллисекундах |
| `details.delegate_to` | `string` | Целевой сервер/агент для `delegated` |
| `details.delegation_reason` | `string` | Причина делегации |
| `details.received_from` | `string` | Сервер/агент-источник для `received` |
| `details.score` | `number` | Оценка (0.0–1.0) для `evaluated` |
| `details.evaluator` | `string` | Метод оценки (`"llm-judge"`, `"heuristic"`, `"human"`) |
| `details.guardrail` | `string` | Имя гардрейла для `guarded` |
| `details.passed` | `boolean` | Прошёл ли гардрейл |
| `details.acknowledged_by` | `string` | Кто подтвердил (для `acknowledged`) |
| `details.decision` | `string` | Решение человека: `"approve"` или `"reject"` |

#### Примеры

**Сервер-источник (агрегатор контента):**
```json
{"details": {"url": "https://civitai.com/images/12345", "content": {"type": "image", "width": 1024, "height": 1024, "model": "Flux.1"}}}
```

**Мессенджер (Telegram, Slack, Discord):**
```json
{"details": {"platform": "telegram", "platform_id": "42", "chat_id": "-100273..."}}
```

**Соцсеть (Facebook, VK, Reddit):**
```json
{"details": {"platform": "vk", "platform_id": "99", "url": "https://vk.com/wall-123_99"}}
```

**При ошибке:**
```json
{"details": {"error": {"type": "rate_limit", "message": "429 Too Many Requests", "retry_after": 30}}}
```

**При пропуске:**
```json
{"details": {"reason": "nsfw_detected"}}
```

**При модерации:**
```json
{"details": {"result": "reject", "reason": "copyright_claim", "duration_ms": 1200}}
```

**При делегации:**
```json
{"details": {"delegate_to": "image-optimizer-mcp", "delegation_reason": "image_too_large"}}
```

**При оценке:**
```json
{"details": {"score": 0.87, "evaluator": "llm-judge", "duration_ms": 450}}
```

**При гардрейле:**
```json
{"details": {"guardrail": "nsfw-filter", "passed": false, "reason": "explicit_content_detected"}}
```

**При подтверждении человеком:**
```json
{"details": {"acknowledged_by": "editor@company.com", "decision": "approve"}}
```

---

### Трекинг стоимости

Когда действие публикации имеет связанную стоимость, она ДОЛЖНА записываться в `details.cost`:

```json
{
  "details": {
    "cost": {
      "tokens_in": 150,
      "tokens_out": 50,
      "usd": 0.003,
      "credits": 1
    }
  }
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `tokens_in` | `int` | Потреблённые входные токены |
| `tokens_out` | `int` | Сгенерированные выходные токены |
| `usd` | `number` | Стоимость в долларах США |
| `credits` | `number` | Потреблённые кредиты платформы |

Все поля стоимости необязательны. Включайте те, которые доступны.

---

### Метаданные контента

Когда метаданные контента известны, они ДОЛЖНЫ записываться в `details.content`:

```json
{
  "details": {
    "content": {
      "type": "image",
      "width": 1024,
      "height": 1024,
      "size_bytes": 245000,
      "mime_type": "image/jpeg",
      "model": "Flux.1 [dev]",
      "title": "Cyberpunk cityscape"
    }
  }
}
```

| Поле | Тип | Описание |
|------|-----|----------|
| `type` | `string` | `image`, `video`, `audio`, `text`, `document` |
| `width` | `int` | Ширина в пикселях |
| `height` | `int` | Высота в пикселях |
| `duration_sec` | `number` | Длительность в секундах (видео/аудио) |
| `size_bytes` | `int` | Размер файла в байтах |
| `mime_type` | `string` | MIME-тип |
| `model` | `string` | AI-модель, использованная для генерации |
| `title` | `string` | Заголовок или подпись контента |
| `nsfw` | `boolean` | NSFW-контент или нет |

---

### Поле Server

Необязательное поле `server` идентифицирует MCP-сервер, записавший запись. Хотя оркестратор может определить сервер по пути к файлу (каждый сервер имеет свой `trail.jsonl`), поле `server` делает записи **самоописывающими** — это критично для агрегированных логов, OTel-экспорта и кросс-серверной отладки.

**Формат:** Lowercase, буквенно-цифровые и дефисы, максимум 64 символа.

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","server":"telegram-mcp","details":{"platform":"telegram","platform_id":"42"}}
```

Реализации ДОЛЖНЫ устанавливать `server` автоматически при каждом вызове `append()`.

---

### Корреляция трейсов

Необязательное поле `trace_id` группирует связанные записи между серверами в один логический трейс. Это позволяет:

- Восстанавливать полный пайплайн для одного запуска оркестратора
- Интегрироваться с OpenTelemetry (использовать `trace_id` как OTel trace ID)
- Связывать записи одного батча/воркфлоу

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00Z","content_id":"civitai:image:12345","action":"selected","requester":"daily-post","trace_id":"d4c5f6a7-8b9c-4d0e-a1f2-b3c4d5e6f7a8"}
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","trace_id":"d4c5f6a7-8b9c-4d0e-a1f2-b3c4d5e6f7a8","details":{"platform":"telegram","platform_id":"42"}}
```

**Формат:** UUID (v4 или v7) или любая строка до 64 символов. При мосте в OpenTelemetry используйте 32-символьную lowercase hex строку (формат W3C Trace Context).

Оркестратор ДОЛЖЕН генерировать один `trace_id` на запуск пайплайна и передавать его всем серверам.

---

### Entry ID

Необязательный `entry_id` уникально идентифицирует каждую запись. Это позволяет ссылки через `caused_by` и дедупликацию повторных записей.

**Рекомендуемые форматы:**
- UUIDv7 (сортируемый по времени): `019576a0-7c00-7000-8000-000000000001`
- Составной: `{server}:{timestamp_ms}:{seq}` — например, `telegram:1743861600123:1`

---

### Цепочка причинности

Необязательное поле `caused_by` связывает записи в цепочку причинности. Оно ссылается на `entry_id` записи, которая непосредственно привела к данной.

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00Z","content_id":"civitai:image:12345","action":"selected","requester":"daily-post","entry_id":"civitai:1743861620000:1"}
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","entry_id":"telegram:1743861625000:1","caused_by":"civitai:1743861620000:1","details":{"platform":"telegram","platform_id":"42"}}
```

Это полезно для:
- Отслеживания какой именно выбор привёл к какой публикации
- Понимания цепочек повторов (failed → retrying → posted)
- Построения DAG-визуализаций пайплайна

---

## Стандартные инструменты (tools)

Каждый MCP-сервер, реализующий TRAIL, ДОЛЖЕН предоставлять эти инструменты:

### `get_trail`

Запрос лога с фильтрами.

**Параметры:**

| Параметр | Тип | По умолч. | Описание |
|----------|-----|-----------|----------|
| `content_id` | `string` | — | Фильтр по content ID. Точное совпадение или префикс (например, `civitai:image:` найдёт все картинки с Civitai). |
| `action` | `string` | — | Фильтр по действию. |
| `requester` | `string` | — | Фильтр по реквестеру. |
| `trace_id` | `string` | — | Фильтр по trace ID. |
| `server` | `string` | — | Фильтр по имени сервера. |
| `tags` | `string[]` | — | Фильтр записей, имеющих ВСЕ указанные теги. |
| `since` | `string` | — | Временная метка ISO 8601. Только записи после этого времени. |
| `limit` | `int` | `50` | Максимум записей, от новых к старым. `0` = без ограничений. |
| `offset` | `int` | `0` | Пропустить записей (пагинация). |

**Возвращает:** `{ entries: TrailEntry[], total: int }` — массив записей (от новых к старым) и общее количество по фильтрам.

### `mark_trail`

Явная запись в лог.

**Параметры:**

| Параметр | Тип | Обязательный | Описание |
|----------|-----|:---:|----------|
| `content_id` | `string` | да | Content ID. |
| `action` | `string` | да | Действие. |
| `requester` | `string` | да | Реквестер. |
| `details` | `object` | нет | Детали. |
| `trace_id` | `string` | нет | ID корреляции трейса. |
| `entry_id` | `string` | нет | Уникальный ID записи. Если не передан, сервер МОЖЕТ сгенерировать автоматически. |
| `caused_by` | `string` | нет | `entry_id` записи, вызвавшей эту. |
| `tags` | `string[]` | нет | Теги для записи. |

**Возвращает:** Записанную запись с серверными `timestamp` и опционально `entry_id` (если сгенерирован или передан).

### `get_trail_stats`

Сводная статистика лога. Полезно для дашбордов и проверок здоровья.

**Параметры:**

| Параметр | Тип | По умолч. | Описание |
|----------|-----|-----------|----------|
| `requester` | `string` | — | Фильтр по реквестеру. |
| `since` | `string` | — | Считать только записи после этого времени. |

**Возвращает:**
```json
{
  "total_entries": 1234,
  "by_action": {"posted": 500, "fetched": 400, "selected": 200, "failed": 80, "skipped": 54},
  "unique_content_ids": 350,
  "first_entry": "2026-01-15T10:00:00Z",
  "last_entry": "2026-04-05T14:07:00Z"
}
```

### Автологирование

Инструменты публикации (например, `send_photo`, `publish_post`) ДОЛЖНЫ принимать опциональные параметры `content_id`, `requester` и `trace_id`. Когда они переданы, инструмент автоматически дописывает запись `posted` при успехе или `failed` при ошибке.

---

## Обнаружение (Discovery)

MCP-сервер, реализующий TRAIL, ДОЛЖЕН объявлять поддержку через capability `trail` в метаданных сервера:

```json
{
  "capabilities": {
    "trail": {
      "version": 2,
      "server": "telegram-mcp",
      "conformance": "standard",
      "actions": ["fetched", "selected", "posted", "failed", "skipped", "guarded"],
      "auto_log_tools": ["send_photo", "send_message", "publish_post"],
      "supports": {
        "trace_id": true,
        "entry_id": true,
        "caused_by": true,
        "tags": true,
        "server_field": true
      },
      "retention_days": 90
    }
  }
}
```

---

## Пример пайплайна

Шедулер-таск `daily-content` берёт топ-картинку из агрегатора, постит в Telegram, затем кросс-постит в VK.

### Агрегатор `trail.jsonl`
```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00.100Z","content_id":"civitai:image:12345","action":"fetched","requester":"daily-content","trace_id":"t-20260405-001","details":{"url":"https://civitai.com/images/12345","content":{"type":"image","model":"Flux.1","width":1024,"height":1024}}}
{"version":2,"timestamp":"2026-04-05T14:07:00.200Z","content_id":"civitai:image:12346","action":"fetched","requester":"daily-content","trace_id":"t-20260405-001","details":{"url":"https://civitai.com/images/12346","content":{"type":"image","model":"SDXL"}}}
{"version":2,"timestamp":"2026-04-05T14:07:01.000Z","content_id":"civitai:image:12345","action":"selected","requester":"daily-content","trace_id":"t-20260405-001"}
{"version":2,"timestamp":"2026-04-05T14:07:01.100Z","content_id":"civitai:image:12346","action":"skipped","requester":"daily-content","trace_id":"t-20260405-001","details":{"reason":"prompt_too_short"}}
```

### Telegram `trail.jsonl`
```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:05.000Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-content","trace_id":"t-20260405-001","details":{"platform":"telegram","platform_id":"42","chat_id":"-100273..."}}
```

### VK `trail.jsonl`
```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:08.000Z","content_id":"civitai:image:12345","action":"failed","requester":"daily-content","trace_id":"t-20260405-001","details":{"error":{"type":"rate_limit","message":"Too many requests","retry_after":60},"attempt":1}}
{"version":2,"timestamp":"2026-04-05T14:08:10.000Z","content_id":"civitai:image:12345","action":"retrying","requester":"daily-content","trace_id":"t-20260405-001","details":{"attempt":2}}
{"version":2,"timestamp":"2026-04-05T14:08:12.000Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-content","trace_id":"t-20260405-001","details":{"platform":"vk","platform_id":"99","url":"https://vk.com/wall-123_99","attempt":2}}
```

---

## Дедупликация

Серверы НЕ выполняют дедупликацию сами. Это ответственность оркестратора:

1. Перед получением: `get_trail(requester="daily-content", since="2026-04-04T00:00:00Z")` на **сервере-источнике**
2. Перед постингом: `get_trail(content_id="civitai:image:12345", action="posted")` на **сервере-назначении**
3. Серверы-источники МОГУТ предоставлять `exclude_used=true` для предфильтрации

---

## Ротация логов

При типичных нагрузках (~50 записей/день) один файл справляется годами. Для высоконагруженных деплоев:

### Стратегия ротации

Когда `trail.jsonl` превышает порог (по умолчанию: 10 МБ):

1. Переименовать: `trail.jsonl` → `trail.{YYYY-MM}.jsonl`
2. Опционально сжать: `trail.2026-03.jsonl.gz`
3. Начать свежий `trail.jsonl`

### Запросы к ротированным логам

`get_trail` ДОЛЖЕН запрашивать активный `trail.jsonl`. МОЖЕТ также запрашивать ротированные файлы при `since` старше первой записи активного файла.

### Хранение

Серверы МОГУТ определять период хранения (например, 90 дней). Серверы ДОЛЖНЫ документировать политику хранения.

---

## Версионирование и эволюция

### Поле version

Текущая версия — `2`. Поле `version` обеспечивает эволюцию. Будущие версии могут добавить контрольные суммы, сжатие или бинарный формат.

### Правила совместимости

- Серверы ДОЛЖНЫ записывать `version: 2`
- Серверы ДОЛЖНЫ игнорировать записи с неизвестным `version`
- Серверы ДОЛЖНЫ игнорировать неизвестные поля
- Неизвестные подполя `details` ДОЛЖНЫ сохраняться

### Политика устаревания

- Deprecated-фичи анонсируются минимум за одну минорную в��рсию до удаления
- Удалённые фичи перечисляются в CHANGELOG

---

## Безопасность и приватность

- Никогда не логировать API-ключи, токены или пароли в `details`
- Поддерживать настраиваемый `redact_fields` для удаления чувствительных данных
- Хранить trail-файлы с ограниченными правами (`0600`)
- Не предоставлять `get_trail` неавторизованным клиентам

---

## Мост в OpenTelemetry

Записи TRAIL можно экспортировать как OpenTelemetry-спаны для интеграции с существующей инфраструктурой наблюдаемости.

### Маппинг полей

| Поле TRAIL | Поле / атрибут OTel Span |
|-----------|-------------------|
| `trace_id` | `traceId` (если 32 hex символа) или `trail.trace_id` |
| `entry_id` | `spanId` |
| `caused_by` | `parentSpanId` (реконструкция дерева в OTel-бэкендах) |
| `timestamp` | `startTime` |
| `timestamp` + `details.duration_ms` | `endTime` (если duration доступен; иначе `endTime` = `startTime`) |
| `content_id` | `trail.content_id` |
| `action` | `name` (имя операции) |
| `requester` | `trail.requester` |
| `server` | `service.name` (атрибут ресурса OTel) |
| `details.*` | `trail.details.*` (расплющенные) |
| `tags` | `trail.tags` |

### Маппинг Span Kind

| TRAIL Action | OTel Span Kind |
|-------------|----------------|
| `fetched`, `selected` | `CLIENT` |
| `posted`, `delivered` | `PRODUCER` |
| `delegated` | `PRODUCER` |
| `received` | `CONSUMER` |
| `moderated`, `evaluated`, `guarded` | `INTERNAL` |
| `acknowledged` | `INTERNAL` |
| `failed` | `CLIENT` (со статусом error) |

### Маппинг статуса

| TRAIL Action | OTel Span Status |
|-------------|-----------------|
| `failed` | `ERROR` с `error.type` = `details.error.type` |
| `skipped` | `OK` (намеренный пропуск — не ошибка) |
| `guarded` с `details.passed: false` | `ERROR` с `error.type` = `guardrail_blocked` |
| Все остальные | `OK` |

### Причинность → Parent-Child

Поле `caused_by` напрямую маппится на `parentSpanId` OTel. Цепочка причинности TRAIL становится деревом спанов в любом OTel-бэкенде (Jaeger, Grafana Tempo, Datadog):

```
trace_id: t-001
├── curator-mcp: selected (span_id: A)
│   └── curator-mcp: delegated (span_id: B, parent: A)
│       └── optimizer-mcp: received (span_id: C, parent: B)
│           └── optimizer-mcp: transformed (span_id: D, parent: C)
│               └── telegram-mcp: posted (span_id: E, parent: D)
```

Этот мост информативен. Референс-экспортер может быть предоставлен в `examples/otel-bridge/`.

---

## Уровни соответствия (Conformance Levels)

TRAIL определяет три уровня соответствия для постепенного внедрения.

### Уровень 0 — Basic

Минимальная реализация TRAIL.

**Обязательно:**
- Append-only JSONL файл `data/trail.jsonl`
- Пять обязательных полей: `version`, `timestamp`, `content_id`, `action`, `requester`
- Инструмент `get_trail` с фильтром по `content_id`
- Инструмент `mark_trail`

Этого достаточно для дедупликации (`is_used`) и базового трекинга.

### Уровень 1 — Standard

Для продакшн-деплоев с отладкой пайплайнов и кросс-серверной корреляцией.

**Обязательно (в дополнение к Level 0):**
- Поддержка `trace_id` при чтении и записи
- Поле `server` в каждой записи
- Автогенерация `entry_id` (UUIDv7 или составной формат)
- Поле `details` со стандартными подполями (`error`, `platform`, `platform_id`, `url`)
- Инструмент `get_trail_stats`
- Автологирование в инструментах публикации
- Discovery через capabilities

### Уровень 2 — Full

Для сложных мульти-агентных архитектур с полной наблюдаемостью.

**Обязательно (в дополнение к Level 1):**
- Поддержка `caused_by` (цепочки причинности)
- Поддержка `tags` с фильтрацией
- Все 15 стандартных действий
- Мульти-фильтр `action` в `get_trail` (строка или массив строк)
- Экспорт в OpenTelemetry
- Ротация логов с настраиваемым порогом

Серверы ДОЛЖНЫ объявлять уровень в capability:

```json
{"capabilities": {"trail": {"conformance": "standard"}}}
```

---

## Безопасность конкурентной записи

Несколько процессов МОГУТ писать в один `trail.jsonl`. Реализации ДОЛЖНЫ гарантировать целостность записей:

### Стратегия 1: Mutex/Lock (рекомендуется)

Сериализация записей через mutex или файловую блокировку.

```python
async with self._lock:
    with open(self._path, "a") as f:
        f.write(json.dumps(entry) + "\n")
```

### Стратегия 2: Атомарный append

На POSIX записи ≤ `PIPE_BUF` (обычно 4096 байт) в файл с `O_APPEND` атомарны. Максимальный размер записи 64 КБ, поэтому для больших записей нужен lock.

### Стратегия 3: Write-Ahead буфер

Буферизация в памяти с периодическим сбросом. Для высоконагруженных серверов (>1000 записей/сек). Записи МОГУТ быть потеряны при крэше.

**Чтение всегда без блокировок.** Неполная последняя строка ДОЛЖНА быть пропущена при парсинге.

---

## Мульти-агентные паттерны

### Делегация

Когда один агент делегирует работу другому — `delegated` + `received`, связанные через `trace_id` и `caused_by`.

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00Z","content_id":"civitai:image:12345","action":"delegated","requester":"content-curator","server":"curator-mcp","entry_id":"curator:1743861620000:1","trace_id":"t-001","details":{"delegate_to":"image-optimizer-mcp","delegation_reason":"needs_resize"}}
{"version":2,"timestamp":"2026-04-05T14:07:02Z","content_id":"civitai:image:12345","action":"received","requester":"content-curator","server":"optimizer-mcp","entry_id":"optimizer:1743861622000:1","caused_by":"curator:1743861620000:1","trace_id":"t-001","details":{"received_from":"curator-mcp"}}
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"transformed","requester":"content-curator","server":"optimizer-mcp","entry_id":"optimizer:1743861625000:1","caused_by":"optimizer:1743861622000:1","trace_id":"t-001","details":{"transformation":"resize:1024x1024"}}
```

### Оценка

Гейты качества через `evaluated`. Оценщик (LLM, эвристика, человек) выставляет скор.

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:03Z","content_id":"civitai:image:12345","action":"evaluated","requester":"daily-post","server":"evaluator-mcp","trace_id":"t-001","details":{"score":0.92,"evaluator":"llm-judge","duration_ms":800}}
```

### Гардрейлы

Проверки безопасности через `guarded` — аудит-трейл всех примённых проверок.

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:01Z","content_id":"civitai:image:12345","action":"guarded","requester":"daily-post","server":"safety-mcp","trace_id":"t-001","details":{"guardrail":"nsfw-classifier","passed":true,"duration_ms":200}}
{"version":2,"timestamp":"2026-04-05T14:07:02Z","content_id":"civitai:image:12345","action":"guarded","requester":"daily-post","server":"safety-mcp","trace_id":"t-001","details":{"guardrail":"copyright-check","passed":true,"duration_ms":1500}}
```

### Human-in-the-Loop

Когда нужно одобрение человека — `acknowledged`:

```jsonl
{"version":2,"timestamp":"2026-04-05T14:10:00Z","content_id":"civitai:image:12345","action":"acknowledged","requester":"daily-post","server":"approval-mcp","trace_id":"t-001","details":{"acknowledged_by":"editor@company.com","decision":"approve"}}
```

### Визуализация пайплайна

С `entry_id`, `caused_by` и `server` оркестратор строит полный DAG:

```
curator-mcp:  fetched → selected → delegated ─┐
                                               │
optimizer-mcp:              received ←─────────┘
                                ↓
                           transformed
                                ↓
safety-mcp:                  guarded (nsfw) → guarded (copyright)
                                                     ↓
evaluator-mcp:                                   evaluated (0.92)
                                                     ↓
telegram-mcp:                                      posted (#42)
                                                     ↓
vk-mcp:                                           posted (#99)
```

---

## Сравнение с альтернативами

| Подход | Общее состояние | Настройка | Агентные паттерны | Семантика контента | Применение |
|--------|:---:|---------|:---:|:---:|----------|
| **TRAIL** | Нет | Скопировать один файл | Да | Да | Трекинг контента через MCP-серверы |
| Общая БД | Да | Деплой БД + миграции | Нет | Нет | Общее состояние |
| Очередь сообщений | Да | Деплой брокера | Нет | Нет | Real-time стриминг |
| OpenTelemetry | Нет | SDK + коллектор + бэкенд | Предложено | Нет | Трейсинг вызовов |
| IETF AAT | Нет | Тяжёлая спека | Частично | Нет | Compliance аудит-трейлы |
| Google A2A | Нет | Полный протокол | Да | Нет | Agent-to-agent коммуникация |
| Langfuse | Да (облако/self-host) | SDK + бэкенд | Частично | Нет | LLM observability |
| LangSmith | Да (облако) | SDK + облако | Частично | Нет | LangChain observability |
| Agent Protocol | Нет | REST API | Tasks/Steps | Нет | API коммуникации агентов |
| ActivityPub | Да | Полный сервер | Нет | Нет | Социальная федерация |

**Уникальная ниша TRAIL:** Ни один другой протокол не совмещает zero shared state, семантику контента (`content_id` — «что куда опубликовано») и мульти-агентные паттерны (делегация, оценка, гардрейлы) в одной легковесной спеке.

---

## FAQ

**В: Почему читаемые имена полей, а не короткие?**
О: Протокол на десятилетия должен быть самодокументируемым. `content_id` понятен сразу. Накладные расходы ничтожны.

**В: Все необязательные поля нужны?**
О: Нет. Пять обязательных полей — это весь протокол. Остальное для продвинутых сценариев.

**В: Оркестратор упал посреди пайплайна?**
О: `trace_id` покажет все записи запуска. Действие последней записи — где продолжить.

**В: Как TRAIL соотносится с OpenTelemetry?**
О: OTel трейсит вызовы. TRAIL трекает семантику контента. Они комплементарны — есть OTel-мост.

**В: Что такое уровни соответствия?**
О: Три уровня: Basic (5 полей + 2 инструмента), Standard (+ `trace_id`, `server`, автологирование, discovery), Full (+ цепочки причинности, все 15 действий, OTel-экспорт). Начинайте с Basic.

**В: Как TRAIL работает с мульти-агентными пайплайнами?**
О: Через пары `delegated`/`received`, цепочки `caused_by` и поле `server`. Оркестратор восстанавливает полный DAG. См. [Мульти-агентные паттерны](#мульти-агентные-паттерны).

**В: Нужны ли гардрейлы и оценка?**
О: Только если в пайплайне есть гейты качества. Действия `guarded` и `evaluated` опциональны — они нужны чтобы проверки безопасности были частью аудит-трейла.

**В: Почему не IETF AAT?**
О: AAT — для регуляторного комплаенса (EU AI Act, SOC 2) с хэш-цепочками и ECDSA-подписями. TRAIL — для developer experience: легковесный, без зависимостей, контент-first.
