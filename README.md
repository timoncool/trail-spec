<p align="center">
  <img src="assets/banner.svg" alt="TRAIL — Tracking Records Across Isolated Logs" width="800"/>
</p>

<p align="center">
  An open protocol for cross-MCP server content tracking and deduplication.<br>
  <a href="SPEC.md">Spec (EN)</a> · <a href="SPEC.ru.md">Spec (RU)</a> · <a href="examples/">Examples</a> · <a href="README.ru.md">README на русском</a>
</p>

<p align="center">
  <a href="https://github.com/timoncool/trail-spec/stargazers"><img src="https://img.shields.io/github/stars/timoncool/trail-spec?style=flat-square" alt="Stars" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/timoncool/trail-spec?style=flat-square" alt="License" /></a>
  <img src="https://img.shields.io/badge/TRAIL-v2.1-6366f1?style=flat-square" alt="TRAIL v2.1" />
  <img src="https://img.shields.io/badge/MCP-compatible-purple?style=flat-square" alt="MCP" />
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
- **15 standard actions** — `fetched`, `selected`, `posted`, `failed`, `skipped`, `retrying`, `transformed`, `moderated`, `expired`, `delivered`, `delegated`, `received`, `evaluated`, `guarded`, `acknowledged`
- **Multi-agent patterns** — delegation, evaluation, guardrails, and human-in-the-loop via standard actions and `caused_by` chains
- **Standard tools** — `get_trail`, `mark_trail`, `get_trail_stats` — same API everywhere
- **Standardized details** — error types, cost tracking, content metadata, platform IDs, guardrail results, evaluation scores
- **Auto-logging** — publishing tools log automatically when `content_id` and `requester` are passed
- **3 conformance levels** — Basic (5 fields + 2 tools), Standard (+ tracing, auto-logging, discovery), Full (+ causality chains, OTel export, all 15 actions)
- **Zero dependencies** — stdlib only, no external packages
- **OTel-native mapping** — `caused_by` → `parentSpanId`, `server` → `service.name`, full span tree in any OTel backend

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
await trail.append("civitai:image:12345", "posted", "daily-post", {
  details: { platform: "telegram", platform_id: "42" },
  trace_id: "run-001",
});

// Query the trail
const { entries, total } = await trail.query({ content_id: "civitai:image:12345" });

// Check if already posted
if (await trail.isUsed("civitai:image:12345")) {
  console.log("Already posted, skipping");
}

// Get pipeline stats
const stats = await trail.stats("daily-post");
console.log(`Posted: ${stats.by_action.posted ?? 0}`);
```

## Entry Schema

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00.123Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","server":"telegram-mcp","trace_id":"run-001","details":{"platform":"telegram","platform_id":"42"}}
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
| `server` | `string` | no | MCP server that wrote this entry (auto-set) |
| `entry_id` | `string` | no | Unique entry identifier (for causality chains) |
| `caused_by` | `string` | no | `entry_id` of the causing entry (maps to OTel `parentSpanId`) |
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
| `delegated` | Task delegated to another agent/server (`details.delegate_to`, `details.delegation_reason`) |
| `received` | Content received from another agent/server (`details.received_from`) |
| `evaluated` | Quality/relevance scored (`details.score`: 0.0–1.0, `details.evaluator`) |
| `guarded` | Guardrail check (`details.guardrail`, `details.passed`, `details.reason`) |
| `acknowledged` | Human-in-the-loop approval (`details.acknowledged_by`, `details.decision`) |

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
    "duration_ms": 1200,
    "delegate_to": "optimizer-mcp",
    "score": 0.92,
    "evaluator": "llm-judge",
    "guardrail": "nsfw-filter",
    "passed": true,
    "acknowledged_by": "editor@company.com",
    "decision": "approve"
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

## Adopting TRAIL in Your MCP Server

**Basic (Level 0)** — deduplication and simple tracking:
1. Copy [`trail.py`](examples/python/trail.py) or [`trail.ts`](examples/typescript/trail.ts) into your project
2. Add `get_trail` and `mark_trail` tools
3. Done

**Standard (Level 1)** — production pipelines:
4. Set `server` name in Trail constructor
5. Add `get_trail_stats` tool
6. Add `content_id` + `requester` + `trace_id` params to publishing tools
7. Advertise TRAIL in capabilities with `"conformance": "standard"`

**Full (Level 2)** — multi-agent observability:
8. Enable `entry_id` auto-generation and `caused_by` support
9. Implement all 15 standard actions
10. Add OTel export capability

Full specification: **[SPEC.md](SPEC.md)** | **[SPEC.ru.md](SPEC.ru.md)**

## Why Not...

| Alternative | Why TRAIL is better for content tracking |
|---|---|
| **Shared database** | Creates coupling, deployment complexity, single point of failure. MCP servers are isolated by design. |
| **Message queue** | Overkill. The LLM orchestrator already mediates all servers — it IS the message bus. |
| **OpenTelemetry** | Traces tool *calls*, not content *semantics*. Doesn't know what was published where. TRAIL has an [OTel bridge](SPEC.md#opentelemetry-bridge) for combining both. |
| **IETF AAT** | Compliance-focused (hash chains, ECDSA signatures). TRAIL is developer-first — lightweight and zero-dependency. |
| **Langfuse / LangSmith** | LLM observability platforms — trace API calls, not content lifecycle. Require cloud/self-hosted backend. |
| **Google A2A** | Agent-to-agent communication protocol, not a content tracking log. Different layer. |
| **Agent Protocol** | Defines agent API, not a logging format. Tasks/Steps, not content semantics. |
| **ActivityPub** | Designed for social federation, not AI tool orchestration. Massive overhead. |

## FAQ

**Q: Why readable field names instead of short ones?**
A: A protocol for decades must be self-documenting. `content_id` is clear on first sight. The overhead is ~15 KB/year at typical rates — negligible.

**Q: Do I need all the optional fields?**
A: No. The five required fields are the whole protocol. Optional fields unlock advanced features when you need them.

**Q: Orchestrator crashes mid-pipeline?**
A: Use `trace_id` to find all entries for that run. The last entry's `action` shows where to resume.

**Q: What are conformance levels?**
A: Three tiers — Basic (5 fields + 2 tools), Standard (+ tracing, `server`, auto-logging), Full (+ causality chains, all 15 actions, OTel export). Start at Basic.

**Q: Multi-agent pipelines?**
A: `delegated`/`received` action pairs + `caused_by` chains + `server` field. The orchestrator reconstructs the full DAG. See [SPEC.md — Multi-Agent Patterns](SPEC.md#multi-agent-patterns).

## Prior Art

We searched extensively for existing solutions. As of April 2026, **no cross-MCP content tracking protocol exists**:

- **MCP Spec** — no server-to-server communication by design
- **CA-MCP** (arXiv 2601.11595) — shared context store for transient state, not persistent content logs
- **lokryn/mcp-log** — JSONL audit logging for operations (SOC2/HIPAA), not content tracking
- **IBM ContextForge** — gateway proxy with OTel tracing, not content semantics
- **OpenTelemetry GenAI** — semantic conventions for LLM calls (Development status), not content lifecycle
- **IETF AAT** (draft-sharif-agent-audit-trail) — compliance-focused audit trail with hash chains, no content semantics
- **Google A2A** — agent-to-agent communication protocol with traceability extension, not a logging format
- **Langfuse / LangSmith / Arize Phoenix** — LLM observability platforms, trace API calls not content
- **Agent Protocol** (agentprotocol.ai) — REST API for interacting with agents, not a log format

TRAIL fills a unique gap: **lightweight, zero-dependency content tracking with multi-agent support** — no other protocol combines content semantics (`content_id`), zero shared state, and agent patterns (delegation, evaluation, guardrails).

## MCP Servers Implementing TRAIL

| Server | Description | Language |
|--------|-------------|----------|
| [civitai-mcp-ultimate](https://github.com/timoncool/civitai-mcp-ultimate) | Civitai API — models, images, videos, prompts | Python |
| [telegram-api-mcp](https://github.com/timoncool/telegram-api-mcp) | Telegram Bot API v9.6 — full coverage | TypeScript |

*Implementing TRAIL in your server? Open a PR to add it here.*

---

## Other Projects by [@timoncool](https://github.com/timoncool)

| Project | Description |
|---------|-------------|
| [ACE-Step Studio](https://github.com/timoncool/ACE-Step-Studio) | AI music studio — songs, vocals, covers, videos |
| [VideoSOS](https://github.com/timoncool/videosos) | AI video production in the browser |
| [Bulka](https://github.com/timoncool/Bulka) | Live-coding music platform |
| [GitLife](https://github.com/timoncool/gitlife) | Your life in weeks — interactive calendar |
| [ScreenSavy.com](https://github.com/timoncool/ScreenSavy.com) | Ambient screen generator |

---

## Support the Author

I build open-source software and do AI research. Most of what I create is free and available to everyone. Your donations help me keep creating without worrying about where the next meal comes from =)

**[All donation methods](https://github.com/timoncool/ACE-Step-Studio/blob/master/DONATE.md)** | **[dalink.to/nerual_dreming](https://dalink.to/nerual_dreming)** | **[boosty.to/neuro_art](https://boosty.to/neuro_art)**

- **BTC:** `1E7dHL22RpyhJGVpcvKdbyZgksSYkYeEBC`
- **ETH (ERC20):** `0xb5db65adf478983186d4897ba92fe2c25c594a0c`
- **USDT (TRC20):** `TQST9Lp2TjK6FiVkn4fwfGUee7NmkxEE7C`


## Star History

<a href="https://www.star-history.com/?repos=timoncool%2Ftrail-spec&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=timoncool/trail-spec&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=timoncool/trail-spec&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=timoncool/trail-spec&type=date&legend=top-left" />
 </picture>
</a>
---

<p align="center">
  <strong>MIT License</strong> · Made with Claude Code
</p>
