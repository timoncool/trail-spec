<p align="center">
  <img src="assets/banner.svg" alt="TRAIL — Tracking Records Across Isolated Logs" width="800"/>
</p>

<p align="center">
  Открытый протокол для кросс-MCP трекинга контента и дедупликации.<br>
  <a href="SPEC.md">Spec (EN)</a> · <a href="SPEC.ru.md">Spec (RU)</a> · <a href="examples/">Examples</a>
</p>

---

## Проблема

У вас несколько [MCP-серверов](https://modelcontextprotocol.io/) — один получает контент, другой постит в Telegram, третий кросс-постит в соцсеть. Каждый сервер изолирован по дизайну. **Ни один сервер не видит другие.**

Попробуйте ответить:
- Эта картинка уже была опубликована в Telegram?
- Пост в соцсеть прошёл или упал?
- Где сломался пайплайн вчера в 3 ночи?

Не получится. Нет стандартного способа отслеживать контент через изолированные MCP-серверы.

**TRAIL решает эту проблему.**

## Как это работает

```
                    LLM-оркестратор (Claude, GPT, и др.)
                   /          |            \
                  /           |             \
         ┌──────────┐  ┌──────────┐  ┌──────────┐
         │ Источник │  │Мессенджер│  │ Соцсеть  │
         │   MCP    │  │   MCP    │  │   MCP    │
         └────┬─────┘  └────┬─────┘  └────┬─────┘
              │              │              │
         trail.jsonl    trail.jsonl    trail.jsonl
```

Каждый сервер ведёт свой `trail.jsonl` — append-only лог с единой схемой. Оркестратор читает все логи и связывает их через универсальный **Content ID** (`cid`).

**Один прогон пайплайна через три сервера:**

```jsonl
# Источник trail.jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"civitai:image:12345","act":"selected","req":"daily-post"}

# Мессенджер trail.jsonl
{"v":1,"t":"2026-04-05T14:07:05Z","cid":"civitai:image:12345","act":"posted","req":"daily-post","d":{"message_id":42}}

# Соцсеть trail.jsonl
{"v":1,"t":"2026-04-05T14:07:30Z","cid":"civitai:image:12345","act":"posted","req":"daily-post","d":{"post_id":99}}
```

Оркестратор видит: `civitai:image:12345` → выбран → запощен в мессенджер (msg #42) → запощен в соцсеть (post #99). Полная цепочка восстановлена.

## Ключевые особенности

- **Ноль общего состояния** — без баз данных, очередей, межсерверной коммуникации
- **Append-only JSONL** — атомарная запись, нет риска повреждения, тривиальный парсинг
- **5 обязательных полей** — `v`, `t`, `cid`, `act`, `req` — это весь протокол
- **Универсальный Content ID** — формат `source:type:id` прослеживает контент через любое количество серверов
- **Стандартные инструменты** — `get_trail` и `mark_trail` — одинаковый API везде
- **Автологирование** — инструменты публикации логируют автоматически при передаче `cid` и `req`
- **Ноль зависимостей** — только стандартная библиотека, никаких внешних пакетов

## Быстрый старт

### Python

```python
from trail import Trail

trail = Trail("./data")

# Залогировать событие
await trail.append(
    cid="civitai:image:12345",
    act="posted",
    req="daily-post",
    d={"message_id": 42}
)

# Запросить лог
entries = await trail.query(cid="civitai:image:12345")

# Проверить, уже опубликовано?
if await trail.is_used("civitai:image:12345"):
    print("Уже опубликовано, пропускаем")
```

### TypeScript

```typescript
import { Trail } from "./trail";

const trail = new Trail("./data");

// Залогировать событие
trail.append("civitai:image:12345", "posted", "daily-post", { message_id: 42 });

// Запросить лог
const entries = trail.query({ cid: "civitai:image:12345" });

// Проверить, уже опубликовано?
if (trail.isUsed("civitai:image:12345")) {
  console.log("Уже опубликовано, пропускаем");
}
```

## Схема записи

```jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"civitai:image:12345","act":"posted","req":"daily-post","d":{"message_id":42}}
```

| Поле  | Тип      | Обязательное | Описание |
|-------|----------|:---:|-------------|
| `v`   | `int`    | да | Версия протокола (всегда `1`) |
| `t`   | `string` | да | Временная метка ISO 8601 |
| `cid` | `string` | да | Content ID: `source:type:id` |
| `act` | `string` | да | Действие: `fetched`, `selected`, `posted`, `failed`, `skipped` |
| `req` | `string` | да | Реквестер (ID воркфлоу/таска) |
| `d`   | `object` | нет | Платформенные детали |

## Стандартные действия

| Действие   | Когда |
|------------|-------|
| `fetched`  | Контент получен из источника (список кандидатов) |
| `selected` | Выбран из кандидатов оркестратором |
| `posted`   | Успешно опубликован |
| `failed`   | Попытка не удалась (причина в `d.error`) |
| `skipped`  | Намеренно пропущен (причина в `d.reason`) |

## Стандартные инструменты

Каждый TRAIL-совместимый MCP-сервер предоставляет:

| Инструмент | Назначение |
|------------|------------|
| `get_trail(cid?, act?, req?, limit?)` | Запросить лог с фильтрами |
| `mark_trail(cid, act, req, d?)` | Явно записать событие |

Инструменты публикации (`send_photo`, `publish_post` и т.д.) принимают опциональные `cid` + `req` для автоматического логирования.

## Дедупликация

Дедупликацией занимается оркестратор, не серверы:

```
1. Перед получением  → get_trail(req="daily-post") на сервере-источнике
2. Перед постингом   → get_trail(cid="civitai:image:12345") на сервере-назначении
3. Если уже запощено → пропускаем
```

Серверы МОГУТ предоставлять параметры-удобства (например, `exclude_used=true`), которые используют trail внутри.

## Внедрение TRAIL в ваш MCP-сервер

1. Скопируйте [`trail.py`](examples/python/trail.py) или [`trail.ts`](examples/typescript/trail.ts) в проект
2. Добавьте инструменты `get_trail` и `mark_trail`
3. Добавьте опциональные `cid` + `req` в инструменты публикации
4. Готово

Полная спецификация: **[SPEC.md](SPEC.md)** | **[SPEC.ru.md](SPEC.ru.md)**

## Почему не...

| Альтернатива | Почему TRAIL лучше |
|---|---|
| **Общая база данных** | Связанность, сложность деплоя, единая точка отказа. MCP-серверы изолированы по дизайну. |
| **Очередь сообщений** | Избыточно. LLM-оркестратор уже связывает все серверы — он И ЕСТЬ шина сообщений. |
| **OpenTelemetry** | Трейсит *вызовы* инструментов, а не *семантику* контента. Не знает что куда запостили. |
| **ActivityPub** | Создан для социальной федерации, не для оркестрации AI-инструментов. Огромный оверхед. |

## FAQ

**В: Почему короткие имена полей (`cid`, `act`, `req`)?**
О: Логи растут бесконечно. Короткие ключи экономят ~40% места. Лог читает машина, не человек.

**В: Что с ротацией логов?**
О: При ~50 записях/день один файл справляется годами. Переименуйте в `trail.2026.jsonl` и начните новый если нужно.

**В: Свои поля?**
О: Всё кладите в `d`. Корневые поля зарезервированы для протокола.

**В: Оркестратор упал посреди пайплайна?**
О: Trail показывает где именно остановился. Продолжайте с последнего успешного шага.

## Исследование существующих решений

Мы тщательно искали существующие решения перед созданием TRAIL. На апрель 2026 года **протокола кросс-MCP трекинга контента не существует**:

- **MCP Spec** — отсутствие коммуникации между серверами by design
- **CA-MCP** (arXiv 2601.11595) — shared context store, но для транзиентного стейта, не для персистентных логов
- **lokryn/mcp-log** — JSONL аудит-логирование, но для операций (SOC2/HIPAA), не для контента
- **IBM ContextForge** — прокси-гейтвей с OTel, не семантика контента
- **OpenTelemetry для MCP** — трейсит вызовы, не "что куда запостили"

TRAIL заполняет этот пробел.

## MCP-серверы с поддержкой TRAIL

| Сервер | Описание | Язык |
|--------|----------|------|
| [civitai-mcp-ultimate](https://github.com/timoncool/civitai-mcp-ultimate) | Civitai API — модели, картинки, видео, промпты | Python |
| [telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp) | Telegram Bot API v9.6 — полное покрытие | TypeScript |

*Внедрили TRAIL в свой сервер? Откройте PR чтобы добавить его сюда.*

---

## Другие open source проекты от [@timoncool](https://github.com/timoncool)

| Проект | Описание |
|--------|----------|
| [civitai-mcp-ultimate](https://github.com/timoncool/civitai-mcp-ultimate) | Civitai MCP-сервер — поиск, просмотр, скачивание, анализ |
| [telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp) | Telegram Bot API MCP-сервер — полное покрытие v9.6, rate limiting, circuit breaker |
| [SuperCaption_Qwen3-VL](https://github.com/timoncool/SuperCaption_Qwen3-VL) | Генерация описаний изображений на Qwen Vision |
| [Foundation-Music-Lab](https://github.com/timoncool/Foundation-Music-Lab) | Генерация музыки с встроенным таймлайн-редактором |
| [Wan2GP_wan.best](https://github.com/timoncool/Wan2GP_wan.best) | Быстрый AI-видеогенератор — Wan 2.1/2.2, Hunyuan, LTX, Flux |
| [VibeVoice_ASR_portable_ru](https://github.com/timoncool/VibeVoice_ASR_portable_ru) | Портативное распознавание речи для русского |
| [Qwen3-TTS_portable_rus](https://github.com/timoncool/Qwen3-TTS_portable_rus) | Портативный TTS с клонированием голоса |
| [ScreenSavy.com](https://github.com/timoncool/ScreenSavy.com) | Превращает любой дисплей в динамичный ambient-экран |

---

## Star History

<a href="https://star-history.com/#timoncool/trail-spec&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=timoncool/trail-spec&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=timoncool/trail-spec&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=timoncool/trail-spec&type=Date" />
 </picture>
</a>

---

<p align="center">
  <strong>MIT License</strong> · Made with Claude Code
</p>
