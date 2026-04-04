<p align="center">
  <img src="assets/banner.svg" alt="TRAIL — Tracking Records Across Isolated Logs" width="800"/>
</p>

<p align="center">
  An open protocol for cross-MCP server content tracking and deduplication.<br>
  <a href="SPEC.md">Spec (EN)</a> · <a href="SPEC.ru.md">Spec (RU)</a> · <a href="examples/">Examples</a> · <a href="README.ru.md">README на русском</a>
</p>

---

## The Problem

You have multiple [MCP servers](https://modelcontextprotocol.io/) — one fetches content, another posts to Telegram, a third cross-posts to a social network. Each server is isolated by design. **No server sees the others.**

Now answer these questions:
- Was this image already posted to Telegram?
- Did the social network post succeed or fail?
- Where did the pipeline break yesterday at 3am?

You can't. There's no standard way to track content across isolated MCP servers.

**TRAIL solves this.**

## How It Works

```
                    LLM Orchestrator (Claude, GPT, etc.)
                   /          |            \
                  /           |             \
         ┌──────────┐  ┌──────────┐  ┌──────────┐
         │ Civitai  │  │ Telegram │  │ Facebook │
         │   MCP    │  │   MCP    │  │   MCP    │
         └────┬─────┘  └────┬─────┘  └────┬─────┘
              │              │              │
         trail.jsonl    trail.jsonl    trail.jsonl
```

Each server keeps its own `trail.jsonl` — an append-only log with a shared schema. The orchestrator reads all logs and connects the dots using a universal **Content ID** (`content_id`).

**One pipeline run across three servers:**

```jsonl
# Civitai trail.jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00Z","content_id":"civitai:image:12345","action":"selected","requester":"daily-post","trace_id":"run-001"}

# Telegram trail.jsonl
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","trace_id":"run-001","details":{"platform":"telegram","platform_id":"42"}}

# Facebook trail.jsonl
{"version":2,"timestamp":"2026-04-05T14:07:30Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","trace_id":"run-001","details":{"platform":"facebook","platform_id":"99"}}
```

The orchestrator sees: `civitai:image:12345` → selected → posted to Telegram (#42) → posted to Facebook (#99). Full pipeline traced via `trace_id`.

## Key Features

- **Zero shared state** — no database, no message bus, no inter-server communication
- **Append-only JSONL** — atomic writes, no corruption risk, trivially parseable
- **Self-documenting** — readable field names: `content_id`, `action`, `requester`, `timestamp`, `version`
- **Universal Content ID** — `source:type:id` format traces content across any number of servers
- **Trace correlation** — optional `trace_id` links entries across servers into one pipeline trace
- **10 standard actions** — `fetched`, `selected`, `posted`, `failed`, `skipped`, `retrying`, `transformed`, `moderated`, `expired`, `delivered`
- **Standard tools** — `get_trail`, `mark_trail`, `get_trail_stats` — same API everywhere
- **Standardized details** — error types, cost tracking, content metadata, platform IDs
- **Auto-logging** — publishing tools log automatically when `content_id` and `requester` are passed
- **Zero dependencies** — stdlib only, no external packages
- **OTel-ready** — optional bridge to export entries as OpenTelemetry spans
- **v1 backward compatible** — reads v1 logs transparently, no migration needed

## Quick Start

### Python

```python
from trail import Trail

trail = Trail("./data")

# Log an event
await trail.append(
    content_id="civitai:image:12345",
    action="posted",
    requester="daily-post",
    details={"platform": "telegram", "platform_id": "42"},
    trace_id="run-001"
)

# Query the trail
entries, total = await trail.query(content_id="civitai:image:12345")

# Check if already posted
if await trail.is_used("civitai:image:12345"):
    print("Already posted, skipping")

# Get pipeline stats
stats = await trail.stats(requester="daily-post")
print(f"Posted: {stats['by_action'].get('posted', 0)}")
```

### TypeScript

```typescript
import { Trail } from "./trail";

const trail = new Trail("./data");

// Log an event
trail.append("civitai:image:12345", "posted", "daily-post", {
  details: { platform: "telegram", platform_id: "42" },
  trace_id: "run-001",
});

// Query the trail
const { entries, total } = trail.query({ content_id: "civitai:image:12345" });

// Check if already posted
if (trail.isUsed("civitai:image:12345")) {
  console.log("Already posted, skipping");
}

// Get pipeline stats
const stats = trail.stats("daily-post");
console.log(`Posted: ${stats.by_action.posted ?? 0}`);
```

## Entry Schema

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00.123Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","trace_id":"run-001","details":{"platform":"telegram","platform_id":"42"}}
```

| Field | Type | Required | Description |
|-------|------|:--------:|-------------|
| `version` | `int` | yes | Protocol version (`2`) |
| `timestamp` | `string` | yes | ISO 8601 timestamp (UTC, milliseconds) |
| `content_id` | `string` | yes | Content ID: `source:type:id` |
| `action` | `string` | yes | Action performed (see below) |
| `requester` | `string` | yes | Workflow/task ID that initiated this |
| `details` | `object` | no | Platform-specific data with [standard sub-fields](SPEC.md#details-field) |
| `trace_id` | `string` | no | Groups entries across servers into one trace |
| `entry_id` | `string` | no | Unique entry identifier (for causality chains) |
| `caused_by` | `string` | no | `entry_id` of the causing entry |
| `tags` | `string[]` | no | Free-form labels for filtering |

## Standard Actions

| Action | When |
|--------|------|
| `fetched` | Content retrieved from source (candidate list) |
| `selected` | Chosen from candidates by the orchestrator |
| `posted` | Successfully published |
| `failed` | Publish attempt failed (`details.error` has structured error info) |
| `skipped` | Intentionally not used (`details.reason` explains why) |
| `retrying` | Scheduling retry after failure (`details.attempt` = attempt number) |
| `transformed` | Content modified (resize, transcode, translate) |
| `moderated` | Passed or failed moderation (`details.result`: `"pass"` / `"reject"`) |
| `expired` | Content no longer eligible (TTL, source removed) |
| `delivered` | Delivery confirmed by platform (webhook, read receipt) |

## Standard Tools

Every TRAIL-compatible MCP server exposes:

| Tool | Purpose |
|------|---------|
| `get_trail(content_id?, action?, requester?, trace_id?, tags?, since?, limit?, offset?)` | Query the log with filters. Returns `{entries, total}` |
| `mark_trail(content_id, action, requester, details?, trace_id?, tags?)` | Write an entry explicitly |
| `get_trail_stats(requester?, since?)` | Summary statistics (counts by action, unique content IDs, date range) |

Publishing tools (`send_photo`, `publish_post`, etc.) accept optional `content_id` + `requester` + `trace_id` for automatic logging.

## Standardized Details

TRAIL defines standard sub-fields in `details` for cross-server consistency:

```json
{
  "details": {
    "platform": "telegram",
    "platform_id": "42",
    "url": "https://t.me/channel/42",
    "error": {"type": "rate_limit", "message": "429", "retry_after": 60},
    "cost": {"tokens_in": 150, "tokens_out": 50, "usd": 0.003},
    "content": {"type": "image", "width": 1024, "height": 1024, "model": "Flux.1"},
    "duration_ms": 1200
  }
}
```

See [SPEC.md — Details Field](SPEC.md#details-field) for the full specification.

## Deduplication

The orchestrator handles deduplication, not the servers:

```
1. Before fetching  → get_trail(requester="daily-post", since="...") on source
2. Before posting   → get_trail(content_id="civitai:image:12345", action="posted") on destination
3. If already posted → skip
```

Servers MAY offer convenience filters (e.g., `exclude_used=true`) that use the trail internally.

## Discovery

Servers advertise TRAIL support via capabilities:

```json
{
  "capabilities": {
    "trail": {
      "version": 2,
      "actions": ["fetched", "selected", "posted", "failed", "skipped"],
      "auto_log_tools": ["send_photo", "send_message", "publish_post"]
    }
  }
}
```

## Migration from v1

TRAIL v2 is **fully backward compatible** with v1:
- v2 servers read v1 entries by mapping field names (`v`→`version`, `t`→`timestamp`, `cid`→`content_id`, `act`→`action`, `req`→`requester`, `d`→`details`)
- Existing log files do NOT need migration
- New entries are always written in v2 format

## Adopting TRAIL in Your MCP Server

1. Copy [`trail.py`](examples/python/trail.py) or [`trail.ts`](examples/typescript/trail.ts) into your project
2. Add `get_trail`, `mark_trail`, and `get_trail_stats` tools
3. Add optional `content_id` + `requester` + `trace_id` params to publishing tools
4. Advertise TRAIL in your server capabilities
5. Done

Full specification: **[SPEC.md](SPEC.md)** | **[SPEC.ru.md](SPEC.ru.md)**

## Why Not...

| Alternative | Why TRAIL is better |
|---|---|
| **Shared database** | Creates coupling, deployment complexity, single point of failure. MCP servers are isolated by design. |
| **Message queue** | Overkill. The LLM orchestrator already mediates all servers — it IS the message bus. |
| **OpenTelemetry** | Traces tool *calls*, not content *semantics*. Doesn't know what was published where. TRAIL has an [OTel bridge](SPEC.md#opentelemetry-bridge) for combining both. |
| **ActivityPub** | Designed for social federation, not AI tool orchestration. Massive overhead. |

## FAQ

**Q: Why readable field names instead of v1's short ones (`cid`, `act`)?**
A: A protocol for decades must be self-documenting. `content_id` is clear on first sight; `cid` requires the spec. The overhead is ~15 KB/year at typical rates — negligible.

**Q: Is v1 still supported?**
A: Yes. v2 reads v1 transparently. No migration needed.

**Q: Do I need all the optional fields?**
A: No. The five required fields are the whole protocol. Optional fields unlock advanced features when you need them.

**Q: Orchestrator crashes mid-pipeline?**
A: Use `trace_id` to find all entries for that run. The last entry's `action` shows where to resume.

## Prior Art

We searched extensively for existing solutions. As of April 2026, **no cross-MCP content tracking protocol exists**:

- **MCP Spec** — no server-to-server communication by design
- **CA-MCP** (arXiv 2601.11595) — shared context store for transient state, not persistent content logs
- **lokryn/mcp-log** — JSONL audit logging for operations (SOC2/HIPAA), not content tracking
- **IBM ContextForge** — gateway proxy with OTel tracing, not content semantics
- **OpenTelemetry for MCP** — traces tool calls, not "what was published where"

Related observability systems (Langfuse, OpenInference, LangSmith) focus on LLM call tracing, not cross-server content lifecycle. TRAIL fills this gap.

## MCP Servers Implementing TRAIL

| Server | Description | Language |
|--------|-------------|----------|
| [civitai-mcp-ultimate](https://github.com/timoncool/civitai-mcp-ultimate) | Civitai API — models, images, videos, prompts | Python |
| [telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp) | Telegram Bot API v9.6 — full coverage | TypeScript |

*Implementing TRAIL in your server? Open a PR to add it here.*

---

## Other Open Source by [@timoncool](https://github.com/timoncool)

| Project | Description |
|---------|-------------|
| [civitai-mcp-ultimate](https://github.com/timoncool/civitai-mcp-ultimate) | Ultimate Civitai MCP server — search, browse, download, analyze |
| [telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp) | Telegram Bot API MCP server — full v9.6 coverage, rate limiting, circuit breaker |
| [SuperCaption_Qwen3-VL](https://github.com/timoncool/SuperCaption_Qwen3-VL) | Image description generator based on Qwen Vision Language Models |
| [Foundation-Music-Lab](https://github.com/timoncool/Foundation-Music-Lab) | Music generation with built-in timeline editor |
| [Wan2GP_wan.best](https://github.com/timoncool/Wan2GP_wan.best) | Fast AI video generator — Wan 2.1/2.2, Hunyuan, LTX, Flux |
| [VibeVoice_ASR_portable_ru](https://github.com/timoncool/VibeVoice_ASR_portable_ru) | Portable speech recognition for Russian |
| [Qwen3-TTS_portable_rus](https://github.com/timoncool/Qwen3-TTS_portable_rus) | Portable TTS with voice cloning |
| [ScreenSavy.com](https://github.com/timoncool/ScreenSavy.com) | Transform any display into a dynamic ambient screen |

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
