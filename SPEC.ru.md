# TRAIL — Tracking Records Across Isolated Logs

## Specification v1

**Version:** 1.0
**Date:** 2026-04-05
**Status:** Draft
**Authors:** timoncool

---

## Проблема

MCP-серверы изолированы по дизайну — каждый сервер не видит другие серверы. Когда несколько MCP-серверов участвуют в контент-пайплайне (например: получить из источника → запостить в мессенджер → кросс-постить в соцсеть), нет стандартного способа:

- Отслеживать какой контент куда был опубликован
- Предотвращать дублирование публикаций
- Отлаживать сломанные пайплайны
- Аудировать полный жизненный цикл контента

Спецификация MCP намеренно не описывает коммуникацию между серверами. **Хост** (LLM-агент) — единственный оркестратор. TRAIL использует эту архитектуру: каждый сервер ведёт свой лог, оркестратор читает все логи и связывает их воедино.

---

## Принципы дизайна

1. **Каждый сервер владеет своим логом.** Никакого общего состояния, центральной базы, межсерверной коммуникации.
2. **Оркестратор связывает всё воедино.** LLM читает логи всех серверов и отслеживает контент по `cid`.
3. **Только дозапись.** Логи — неизменяемый аудит-трейл. Никогда не редактировать и не удалять записи.
4. **Конвенция вместо конфигурации.** Одинаковое имя файла, одинаковый формат, одинаковые поля везде.
5. **Ноль зависимостей.** JSONL + стандартная библиотека. Никаких внешних пакетов.

---

## Файл

```
<корень-mcp-сервера>/data/trail.jsonl
```

- **Формат:** JSONL (JSON Lines) — один JSON-объект на строку, UTF-8, `\n` перенос строки
- **Режим записи:** Только дозапись (append-only)
- **Конкурентность:** Сериализовать запись (mutex/lock). Чтение без блокировок.

---

## Схема записи

```jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"source:image:12345","act":"posted","req":"daily-post","d":{"message_id":42}}
```

### Обязательные поля

| Поле  | Тип      | Описание |
|-------|----------|----------|
| `v`   | `int`    | Версия протокола. Всегда `1` для этой спецификации. |
| `t`   | `string` | Временная метка ISO 8601 с таймзоной. Когда произошло действие. |
| `cid` | `string` | Content ID. Универсальный идентификатор, который следует за контентом через все серверы. Формат: `source:type:id`. См. [Content ID](#content-id). |
| `act` | `string` | Действие. См. [Стандартные действия](#стандартные-действия). |
| `req` | `string` | Реквестер — воркфлоу или шедулер-таск, который инициировал цепочку. Совпадает с `taskId` шедулера. |

### Необязательные поля

| Поле  | Тип      | Описание |
|-------|----------|----------|
| `d`   | `object` | Платформенные детали. Каждый сервер определяет свою схему. См. [Поле Details](#поле-details). |

---

### Content ID

Формат: `source:type:id`

```
civitai:image:12345
unsplash:photo:abc-def
youtube:video:dQw4w9WgXcQ
runware:image:550e8400
```

Правила:
- `source` — платформа-источник, lowercase, без двоеточий
- `type` — тип контента на источнике (`image`, `video`, `model`, `prompt`)
- `id` — идентификатор на источнике, как есть (строка или число)
- `cid` **назначается на источнике** и **передаётся без изменений** через каждый сервер в пайплайне

---

### Стандартные действия

| Действие   | Значение |
|------------|----------|
| `fetched`  | Контент получен из источника (список кандидатов) |
| `selected` | Выбран из кандидатов оркестратором |
| `posted`   | Успешно опубликован на этой платформе |
| `failed`   | Попытка публикации не удалась. Причина в `d.error` |
| `skipped`  | Намеренно пропущен. Причина в `d.reason` |

Серверы МОГУТ определять дополнительные действия для внутреннего использования (например, `drafted`, `reviewed`, `voted`). Кастомные действия ДОЛЖНЫ быть в lowercase, одним словом или через дефис.

---

### Поле Details

Поле `d` — открытый объект. Каждый сервер определяет что хранить. Примеры:

**Сервер-источник (агрегатор контента):**
```json
{"d": {"url": "https://...", "model": "Flux.1", "sort_rank": 1}}
```

**Мессенджер (Telegram, Slack, Discord):**
```json
{"d": {"chat_id": "-100...", "message_id": 42}}
```

**Соцсеть (Facebook, VK, Reddit):**
```json
{"d": {"post_id": 12345, "url": "https://..."}}
```

**При ошибке:**
```json
{"d": {"error": "rate_limit", "retry_after": 30}}
```

**При пропуске:**
```json
{"d": {"reason": "nsfw_detected"}}
```

---

## Стандартные инструменты (tools)

Каждый MCP-сервер, реализующий TRAIL, ДОЛЖЕН предоставлять два инструмента:

### `get_trail`

Запрос лога с фильтрами.

**Параметры:**

| Параметр | Тип      | По умолчанию | Описание |
|----------|----------|:---:|----------|
| `cid`    | `string` | —   | Фильтр по content ID. Точное совпадение или префикс (например, `civitai:image:` найдёт все картинки с Civitai). |
| `act`    | `string` | —   | Фильтр по действию. |
| `req`    | `string` | —   | Фильтр по реквестеру. |
| `limit`  | `int`    | `50`| Максимум записей, от новых к старым. |

**Возвращает:** Массив записей лога, от новых к старым.

### `mark_trail`

Явная запись в лог.

**Параметры:**

| Параметр | Тип      | Обязательный | Описание |
|----------|----------|:---:|----------|
| `cid`    | `string` | да  | Content ID. |
| `act`    | `string` | да  | Действие. |
| `req`    | `string` | да  | Реквестер. |
| `d`      | `object` | нет | Детали. |

**Возвращает:** Подтверждение с записанной строкой.

### Автологирование

Инструменты публикации (например, `send_photo`, `publish_post`) ДОЛЖНЫ принимать опциональные параметры `cid` и `req`. Когда они переданы, инструмент автоматически дописывает запись `posted` при успехе или `failed` при ошибке. Это устраняет необходимость отдельного вызова `mark_trail` после каждой публикации.

---

## Пример пайплайна

Шедулер-таск `daily-content` берёт топ-картинку из агрегатора, постит в Telegram, затем кросс-постит в соцсеть.

### Агрегатор `trail.jsonl`
```jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"source:image:12345","act":"fetched","req":"daily-content","d":{"url":"https://...","model":"Flux.1"}}
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"source:image:12346","act":"fetched","req":"daily-content","d":{"url":"https://...","model":"SDXL"}}
{"v":1,"t":"2026-04-05T14:07:01Z","cid":"source:image:12345","act":"selected","req":"daily-content"}
{"v":1,"t":"2026-04-05T14:07:01Z","cid":"source:image:12346","act":"skipped","req":"daily-content","d":{"reason":"prompt_too_short"}}
```

### Мессенджер `trail.jsonl`
```jsonl
{"v":1,"t":"2026-04-05T14:07:05Z","cid":"source:image:12345","act":"posted","req":"daily-content","d":{"chat_id":"-100273...","message_id":42}}
```

### Соцсеть `trail.jsonl`
```jsonl
{"v":1,"t":"2026-04-05T14:07:30Z","cid":"source:image:12345","act":"posted","req":"daily-content","d":{"post_id":99,"url":"https://social.example/post/99"}}
```

Оркестратор (LLM) запрашивает лог любого сервера по `cid=source:image:12345` и восстанавливает полный пайплайн:

```
агрегатор  → fetched → selected
мессенджер → posted  (msg #42)
соцсеть    → posted  (post #99)
```

---

## Дедупликация

Серверы НЕ выполняют дедупликацию сами. Это ответственность оркестратора:

1. Перед получением: вызвать `get_trail(req="daily-content", limit=100)` на **сервере-источнике**, чтобы увидеть что недавно получали
2. Перед постингом: вызвать `get_trail(cid="source:image:12345")` на **сервере-назначении**, чтобы проверить, не опубликовано ли уже
3. Серверы-источники МОГУТ предоставлять параметр-удобство (например, `exclude_used=true`), который предварительно фильтрует результаты по логу

---

## Гайд по внедрению

### Для авторов серверов

1. Создайте папку `data/` в корне сервера
2. Реализуйте класс `ContentLog` (см. референс-реализации ниже)
3. Добавьте инструменты `get_trail` и `mark_trail`
4. Добавьте опциональные параметры `cid` + `req` в инструменты публикации
5. Положите этот файл спецификации в репозиторий как `TRAIL-SPEC.md`

### Для промптов оркестратора

Включите в промпт шедулер-таска:
```
При постинге контента ВСЕГДА передавай параметры cid и req для трекинга пайплайна.
Перед постингом проверяй get_trail на сервере-назначении, чтобы избежать дубликатов.
```

---

## Референс-реализация — Python

```python
"""trail.py — TRAIL Protocol v1 (Tracking Records Across Isolated Logs)"""

import json
import asyncio
from pathlib import Path
from datetime import datetime, timezone


class Trail:
    """TRAIL-совместимый контент-лог. Append-only JSONL."""

    def __init__(self, data_dir: str | Path):
        self._path = Path(data_dir) / "trail.jsonl"
        self._lock = asyncio.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    async def append(self, cid: str, act: str, req: str, d: dict | None = None) -> dict:
        """Дозаписать событие в лог."""
        entry = {
            "v": 1,
            "t": datetime.now(timezone.utc).isoformat(),
            "cid": cid,
            "act": act,
            "req": req,
        }
        if d:
            entry["d"] = d

        async with self._lock:
            with open(self._path, "a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")

        return entry

    async def query(
        self,
        cid: str | None = None,
        act: str | None = None,
        req: str | None = None,
        limit: int = 50,
    ) -> list[dict]:
        """Запросить лог с фильтрами. Возвращает от новых к старым."""
        if not self._path.exists():
            return []

        entries = []
        async with self._lock:
            with open(self._path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if cid and not entry.get("cid", "").startswith(cid):
                        continue
                    if act and entry.get("act") != act:
                        continue
                    if req and entry.get("req") != req:
                        continue

                    entries.append(entry)

        return list(reversed(entries))[:limit]

    async def is_used(self, cid: str) -> bool:
        """Проверить, был ли контент уже опубликован."""
        entries = await self.query(cid=cid, act="posted", limit=1)
        return len(entries) > 0

    async def get_used_cids(self, req: str | None = None) -> set[str]:
        """Получить множество всех опубликованных content ID."""
        entries = await self.query(act="posted", req=req, limit=0)
        return {e["cid"] for e in entries}
```

---

## Референс-реализация — TypeScript

```typescript
/** trail.ts — TRAIL Protocol v1 (Tracking Records Across Isolated Logs) */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

interface TrailEntry {
  v: 1;
  t: string;
  cid: string;
  act: string;
  req: string;
  d?: Record<string, unknown>;
}

interface TrailQuery {
  cid?: string;
  act?: string;
  req?: string;
  limit?: number;
}

export class Trail {
  private path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, "trail.jsonl");
    mkdirSync(dirname(this.path), { recursive: true });
  }

  /** Дозаписать событие в лог */
  append(cid: string, act: string, req: string, d?: Record<string, unknown>): TrailEntry {
    const entry: TrailEntry = {
      v: 1,
      t: new Date().toISOString(),
      cid,
      act,
      req,
    };
    if (d) entry.d = d;

    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
    return entry;
  }

  /** Запросить лог с фильтрами. Возвращает от новых к старым */
  query({ cid, act, req, limit = 50 }: TrailQuery = {}): TrailEntry[] {
    if (!existsSync(this.path)) return [];

    const lines = readFileSync(this.path, "utf-8").split("\n").filter(Boolean);
    const entries: TrailEntry[] = [];

    for (const line of lines) {
      try {
        const entry: TrailEntry = JSON.parse(line);
        if (cid && !entry.cid.startsWith(cid)) continue;
        if (act && entry.act !== act) continue;
        if (req && entry.req !== req) continue;
        entries.push(entry);
      } catch {
        continue;
      }
    }

    return entries.reverse().slice(0, limit);
  }

  /** Проверить, был ли контент уже опубликован */
  isUsed(cid: string): boolean {
    return this.query({ cid, act: "posted", limit: 1 }).length > 0;
  }

  /** Получить множество всех опубликованных content ID */
  getUsedCids(req?: string): Set<string> {
    const entries = this.query({ act: "posted", req, limit: 0 });
    return new Set(entries.map((e) => e.cid));
  }
}
```

---

## Версионирование

Поле `v` позволяет эволюцию в будущем:
- **v1** (эта спека): плоский JSONL, 5 полей, без валидации схемы
- **v2** (гипотетически): можно добавить контрольные суммы, сжатие или бинарный формат

Серверы ДОЛЖНЫ игнорировать записи с неизвестным значением `v`. Серверы ДОЛЖНЫ всегда писать `v: 1` по этой спецификации.

---

## FAQ

**В: Почему не общая база данных?**
О: MCP-серверы изолированы по дизайну. Общая БД создаёт связанность, сложность деплоя и единую точку отказа. Оркестратор и так видит все серверы — пусть он и делает корреляцию.

**В: Почему короткие имена полей?**
О: Логи растут бесконечно. При 10 постах/день на 5 серверов — это 18К записей/год. Короткие ключи экономят ~40% места и ускоряют парсинг. Лог читает машина, не человек.

**В: Что с ротацией логов?**
О: При типичных нагрузках (~50 записей/день) один файл справляется годами. Если надо — реализуйте ротацию внешне (переместите `trail.jsonl` в `trail.2026.jsonl` и начните новый). Спецификация не требует ротации.

**В: Можно добавить свои поля в корень записи?**
О: Нет. Всё кастомное кладите в `d`. Это сохраняет поля протокола стабильными и парсируемыми.

**В: Что если оркестратор упал посреди пайплайна?**
О: Лог показывает где именно он остановился. `source:image:12345` имеет `selected` в агрегаторе, но нет `posted` в мессенджере → оркестратор знает что нужно продолжить с мессенджера.
