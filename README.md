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

Each server keeps its own `trail.jsonl` — an append-only log with a shared schema. The orchestrator reads all logs and connects the dots using a universal **Content ID** (`cid`).

**One content pipeline run across three servers:**

```jsonl
# Civitai trail.jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"civitai:image:12345","act":"selected","req":"daily-post"}

# Telegram trail.jsonl
{"v":1,"t":"2026-04-05T14:07:05Z","cid":"civitai:image:12345","act":"posted","req":"daily-post","d":{"message_id":42}}

# Facebook trail.jsonl
{"v":1,"t":"2026-04-05T14:07:30Z","cid":"civitai:image:12345","act":"posted","req":"daily-post","d":{"post_id":99}}
```

The orchestrator sees: `civitai:image:12345` → selected → posted to Telegram (msg #42) → posted to Facebook (post #99). Full pipeline traced.

## Key Features

- **Zero shared state** — no database, no message bus, no inter-server communication
- **Append-only JSONL** — atomic writes, no corruption risk, trivially parseable
- **5 required fields** — `v`, `t`, `cid`, `act`, `req` — that's the whole protocol
- **Universal Content ID** — `source:type:id` format traces content across any number of servers
- **Standard tools** — `get_trail` and `mark_trail` — same API everywhere
- **Auto-logging** — publishing tools log automatically when `cid` and `req` are passed
- **Zero dependencies** — stdlib only, no external packages

## Quick Start

### Python

```python
from trail import Trail

trail = Trail("./data")

# Log an event
await trail.append(
    cid="civitai:image:12345",
    act="posted",
    req="daily-post",
    d={"message_id": 42}
)

# Query the trail
entries = await trail.query(cid="civitai:image:12345")

# Check if already posted
if await trail.is_used("civitai:image:12345"):
    print("Already posted, skipping")
```

### TypeScript

```typescript
import { Trail } from "./trail";

const trail = new Trail("./data");

// Log an event
trail.append("civitai:image:12345", "posted", "daily-post", { message_id: 42 });

// Query the trail
const entries = trail.query({ cid: "civitai:image:12345" });

// Check if already posted
if (trail.isUsed("civitai:image:12345")) {
  console.log("Already posted, skipping");
}
```

## Entry Schema

```jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"civitai:image:12345","act":"posted","req":"daily-post","d":{"message_id":42}}
```

| Field | Type     | Required | Description |
|-------|----------|:--------:|-------------|
| `v`   | `int`    | yes | Protocol version (always `1`) |
| `t`   | `string` | yes | ISO 8601 timestamp |
| `cid` | `string` | yes | Content ID: `source:type:id` |
| `act` | `string` | yes | Action: `fetched`, `selected`, `posted`, `failed`, `skipped` |
| `req` | `string` | yes | Requester (workflow/task ID) |
| `d`   | `object` | no  | Platform-specific details |

## Standard Actions

| Action     | When |
|------------|------|
| `fetched`  | Content retrieved from source (candidate list) |
| `selected` | Chosen from candidates by the orchestrator |
| `posted`   | Successfully published |
| `failed`   | Publish attempt failed (`d.error` has the reason) |
| `skipped`  | Intentionally not used (`d.reason` has the reason) |

## Standard Tools

Every TRAIL-compatible MCP server exposes:

| Tool | Purpose |
|------|---------|
| `get_trail(cid?, act?, req?, limit?)` | Query the log with filters |
| `mark_trail(cid, act, req, d?)` | Write an entry explicitly |

Publishing tools (`send_photo`, `publish_post`, etc.) accept optional `cid` + `req` params for automatic logging.

## Deduplication

The orchestrator handles deduplication, not the servers:

```
1. Before fetching  → get_trail(req="daily-post") on source server
2. Before posting   → get_trail(cid="civitai:image:12345") on destination
3. If already posted → skip
```

Servers MAY offer convenience filters (e.g., `exclude_used=true`) that use the trail internally.

## Adopting TRAIL in Your MCP Server

1. Copy [`trail.py`](examples/python/trail.py) or [`trail.ts`](examples/typescript/trail.ts) into your project
2. Add `get_trail` and `mark_trail` tools
3. Add optional `cid` + `req` params to publishing tools
4. Done

Full specification: **[SPEC.md](SPEC.md)** | **[SPEC.ru.md](SPEC.ru.md)**

## Why Not...

| Alternative | Why TRAIL is better |
|---|---|
| **Shared database** | Creates coupling, deployment complexity, single point of failure. MCP servers are isolated by design. |
| **Message queue** | Overkill. The LLM orchestrator already mediates all servers — it IS the message bus. |
| **OpenTelemetry** | Traces tool *calls*, not content *semantics*. Doesn't know what was published where. |
| **ActivityPub** | Designed for social federation, not AI tool orchestration. Massive overhead. |

## FAQ

**Q: Why short field names (`cid`, `act`, `req`)?**
A: Logs grow forever. Short keys save ~40% disk space. The log is read by machines, not humans.

**Q: What about log rotation?**
A: At ~50 entries/day, one file handles years. Rename to `trail.2026.jsonl` and start fresh if needed.

**Q: Custom fields?**
A: Put everything in `d`. Root-level fields are reserved for the protocol.

**Q: Orchestrator crashes mid-pipeline?**
A: The trail shows exactly where it stopped. Resume from the last successful step.

## Prior Art Research

We searched extensively for existing solutions before creating TRAIL. As of April 2026, **no cross-MCP content tracking protocol exists**:

- **MCP Spec** — no server-to-server communication by design
- **CA-MCP** (arXiv 2601.11595) — proposes shared context store, but for transient state, not persistent content logs
- **lokryn/mcp-log** — JSONL audit logging, but for operations (SOC2/HIPAA), not content tracking
- **IBM ContextForge** — gateway proxy with OTel tracing, not content semantics
- **OpenTelemetry for MCP** — traces tool calls, not "what was published where"

TRAIL fills this gap.

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
