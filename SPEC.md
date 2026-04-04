# TRAIL — Tracking Records Across Isolated Logs

## Specification

**Version:** 2.0
**Date:** 2026-04-05
**Status:** Draft
**Authors:** timoncool

---

## Abstract

TRAIL is a lightweight, zero-dependency protocol for tracking content across isolated [MCP](https://modelcontextprotocol.io/) servers. Each server maintains its own append-only log; the LLM orchestrator reads all logs and correlates entries by a universal Content ID. TRAIL enables deduplication, pipeline debugging, crash recovery, and audit trails — without shared state or inter-server communication.

---

## Problem

MCP servers are isolated by design — each server has no visibility into other servers. When multiple MCP servers participate in a content pipeline (e.g., fetch from an aggregator → post to a messenger → cross-post to a social network), there is no standard way to:

- Track what content was published where
- Prevent duplicate publications
- Debug broken pipelines
- Audit the full lifecycle of a piece of content
- Recover from orchestrator crashes mid-pipeline

The MCP specification intentionally does not address server-to-server communication. The **host** (LLM agent) is the sole orchestrator. TRAIL leverages that architecture: each server maintains its own log, the orchestrator reads all logs and connects the dots.

---

## Design Principles

1. **Each server owns its log.** No shared state, no central database, no inter-server communication.
2. **The orchestrator connects the dots.** The LLM reads logs from all servers and traces content by `content_id`.
3. **Append-only.** Logs are immutable audit trails. Never edit or delete entries.
4. **Self-documenting.** Field names are human-readable. The log is understandable without consulting the spec.
5. **Convention over configuration.** Same file name, same format, same fields everywhere.
6. **Zero dependencies.** JSONL + stdlib. No external libraries required.
7. **Correlation-ready.** Entries can be linked into traces via optional `trace_id`, enabling integration with OpenTelemetry and other observability systems.

---

## File

```
<mcp-server-root>/data/trail.jsonl
```

- **Format:** JSONL (JSON Lines) — one JSON object per line, UTF-8, `\n` line endings
- **Write mode:** Append-only
- **Concurrency:** Serialize writes (mutex/lock). Reads are lock-free.
- **Max line length:** 64 KB (entries exceeding this SHOULD be truncated in `details`)

---

## Entry Schema

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00.123Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","details":{"platform":"telegram","message_id":42}}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `version` | `int` | Protocol version. `2` for this spec. |
| `timestamp` | `string` | ISO 8601 timestamp in UTC with milliseconds. When the action occurred. Example: `"2026-04-05T14:07:00.123Z"` |
| `content_id` | `string` | Universal Content ID. Follows content across servers. Format: `source:type:id`. See [Content ID](#content-id). |
| `action` | `string` | Action performed. See [Standard Actions](#standard-actions). |
| `requester` | `string` | The workflow, scheduled task, or user that initiated this action. Matches the scheduler's task ID or a human-readable pipeline name. |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `details` | `object` | Platform-specific data. See [Details Field](#details-field). |
| `trace_id` | `string` | Groups related entries across servers into a single trace. See [Trace Correlation](#trace-correlation). |
| `entry_id` | `string` | Unique ID for this entry. Format: UUIDv7 or `{server}:{timestamp_ms}:{seq}`. See [Entry ID](#entry-id). |
| `caused_by` | `string` | `entry_id` of the entry that directly caused this one. See [Causality Chain](#causality-chain). |
| `tags` | `string[]` | Free-form labels for filtering and categorization. Example: `["nsfw", "priority:high", "batch:2026-04-05"]` |

---

### Content ID

Format: `source:type:id`

```
civitai:image:12345
unsplash:photo:abc-def
youtube:video:dQw4w9WgXcQ
runware:image:550e8400
custom:article:my-slug
```

Rules:
- `source` — origin platform, lowercase, alphanumeric and hyphens only, no colons. Max 32 characters.
- `type` — content type at the source. Standard types: `image`, `video`, `audio`, `model`, `prompt`, `post`, `article`, `document`. Custom types allowed, lowercase. Max 32 characters.
- `id` — identifier at the source, as-is (string or numeric). Max 256 characters. Must not contain newlines.
- The Content ID is **assigned at the source** and **carried unchanged** through every server in the pipeline

**Validation regex:** `^[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,31}:[^\n:]{1,256}$`

---

### Standard Actions

| Action | Meaning |
|--------|---------|
| `fetched` | Content retrieved from source (candidate list) |
| `selected` | Chosen from candidates by the orchestrator |
| `posted` | Successfully published to this platform |
| `failed` | Publish attempt failed. Details in `details.error` |
| `skipped` | Intentionally not used. Reason in `details.reason` |
| `retrying` | Previous attempt failed, scheduling retry. `details.attempt` has the attempt number |
| `transformed` | Content was modified (resized, transcoded, translated, etc.). `details.transformation` describes what changed |
| `moderated` | Content passed or failed moderation. `details.result` is `"pass"` or `"reject"`, `details.reason` explains why |
| `expired` | Content is no longer eligible (TTL passed, source removed, etc.) |
| `delivered` | Delivery confirmed by the platform (e.g., webhook callback, read receipt) |

Servers MAY define additional actions for internal use (e.g., `drafted`, `reviewed`, `voted`). Custom actions MUST be lowercase, single-word or hyphenated, max 32 characters.

---

### Details Field

The `details` field is an open object. Each server defines what it stores. However, certain sub-fields have standard meaning when present:

#### Standard Detail Fields

| Field | Type | When |
|-------|------|------|
| `details.error` | `object` | On `failed` or `retrying` actions |
| `details.error.type` | `string` | Error category: `rate_limit`, `auth`, `validation`, `network`, `server`, `timeout`, `unknown` |
| `details.error.message` | `string` | Human-readable error description |
| `details.error.retry_after` | `int` | Seconds until retry is allowed (for rate limits) |
| `details.reason` | `string` | Why content was `skipped` or `moderated` |
| `details.platform` | `string` | Target platform identifier (e.g., `"telegram"`, `"facebook"`) |
| `details.platform_id` | `string` | ID of the created resource on the target platform |
| `details.url` | `string` | URL of the published content |
| `details.attempt` | `int` | Retry attempt number (1-based), for `retrying` and `failed` |
| `details.transformation` | `string` | What transformation was applied (e.g., `"resize:1024x1024"`, `"translate:en→ru"`) |
| `details.result` | `string` | Moderation result: `"pass"` or `"reject"` |
| `details.cost` | `object` | Cost information. See [Cost Tracking](#cost-tracking). |
| `details.content` | `object` | Content metadata. See [Content Metadata](#content-metadata). |
| `details.duration_ms` | `int` | How long the action took in milliseconds |

#### Examples

**Source server (content aggregator):**
```json
{"details": {"url": "https://civitai.com/images/12345", "content": {"type": "image", "width": 1024, "height": 1024, "model": "Flux.1"}}}
```

**Messenger (Telegram, Slack, Discord):**
```json
{"details": {"platform": "telegram", "platform_id": "42", "chat_id": "-100273..."}}
```

**Social network (Facebook, VK, Reddit):**
```json
{"details": {"platform": "vk", "platform_id": "99", "url": "https://vk.com/wall-123_99"}}
```

**On failure:**
```json
{"details": {"error": {"type": "rate_limit", "message": "429 Too Many Requests", "retry_after": 30}}}
```

**On skip:**
```json
{"details": {"reason": "nsfw_detected"}}
```

**On moderation:**
```json
{"details": {"result": "reject", "reason": "copyright_claim", "duration_ms": 1200}}
```

---

### Cost Tracking

When a publishing action has an associated cost, it SHOULD be recorded in `details.cost`:

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

| Field | Type | Description |
|-------|------|-------------|
| `tokens_in` | `int` | Input tokens consumed |
| `tokens_out` | `int` | Output tokens generated |
| `usd` | `number` | Cost in US dollars |
| `credits` | `number` | Platform-specific credits consumed |

All cost fields are optional. Include whichever are available.

---

### Content Metadata

When content metadata is known, it SHOULD be recorded in `details.content`:

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

| Field | Type | Description |
|-------|------|-------------|
| `type` | `string` | `image`, `video`, `audio`, `text`, `document` |
| `width` | `int` | Width in pixels |
| `height` | `int` | Height in pixels |
| `duration_sec` | `number` | Duration in seconds (video/audio) |
| `size_bytes` | `int` | File size in bytes |
| `mime_type` | `string` | MIME type |
| `model` | `string` | AI model used to generate the content |
| `title` | `string` | Content title or caption |
| `nsfw` | `boolean` | Whether content is NSFW |

---

### Trace Correlation

The optional `trace_id` field groups related entries across multiple servers into a single logical trace. This enables:

- Reconstructing the full pipeline for a single orchestrator run
- Integration with OpenTelemetry (use `trace_id` as the OTel trace ID)
- Correlating entries that belong to the same batch/workflow execution

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00Z","content_id":"civitai:image:12345","action":"selected","requester":"daily-post","trace_id":"d4c5f6a7-8b9c-4d0e-a1f2-b3c4d5e6f7a8"}
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","trace_id":"d4c5f6a7-8b9c-4d0e-a1f2-b3c4d5e6f7a8","details":{"platform":"telegram","platform_id":"42"}}
```

**Format:** UUID (v4 or v7) or any string up to 64 characters. When bridging to OpenTelemetry, use a 32-character lowercase hex string (W3C Trace Context format).

The orchestrator SHOULD generate one `trace_id` per pipeline run and pass it to all servers.

---

### Entry ID

The optional `entry_id` uniquely identifies each entry. This enables `caused_by` references and deduplication of retried writes.

**Recommended formats:**
- UUIDv7 (time-sortable): `019576a0-7c00-7000-8000-000000000001`
- Composite: `{server}:{timestamp_ms}:{seq}` — e.g., `telegram:1743861600123:1`

---

### Causality Chain

The optional `caused_by` field links entries into a causality chain. It references the `entry_id` of the entry that directly led to this one.

```jsonl
{"version":2,"timestamp":"2026-04-05T14:07:00Z","content_id":"civitai:image:12345","action":"selected","requester":"daily-post","entry_id":"civitai:1743861620000:1"}
{"version":2,"timestamp":"2026-04-05T14:07:05Z","content_id":"civitai:image:12345","action":"posted","requester":"daily-post","entry_id":"telegram:1743861625000:1","caused_by":"civitai:1743861620000:1","details":{"platform":"telegram","platform_id":"42"}}
```

This is useful for:
- Tracing exactly which selection led to which post
- Understanding retry chains (failed → retrying → posted)
- Building DAG visualizations of the pipeline

---

## Standard Tools

Every MCP server implementing TRAIL MUST expose these tools:

### `get_trail`

Query the trail log with filters.

**Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `content_id` | `string` | — | Filter by content ID. Exact match or prefix (e.g., `civitai:image:` matches all Civitai images). |
| `action` | `string` | — | Filter by action. |
| `requester` | `string` | — | Filter by requester. |
| `trace_id` | `string` | — | Filter by trace ID. |
| `tags` | `string[]` | — | Filter entries that have ALL specified tags. |
| `since` | `string` | — | ISO 8601 timestamp. Only return entries after this time. |
| `limit` | `int` | `50` | Max entries to return, newest first. `0` = unlimited. |
| `offset` | `int` | `0` | Number of entries to skip (for pagination). |

**Returns:** `{ entries: TrailEntry[], total: int }` — Array of log entries (newest first) and total count matching filters.

### `mark_trail`

Explicitly write an entry to the trail log.

**Parameters:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `content_id` | `string` | yes | Content ID. |
| `action` | `string` | yes | Action. |
| `requester` | `string` | yes | Requester. |
| `details` | `object` | no | Details. |
| `trace_id` | `string` | no | Trace correlation ID. |
| `entry_id` | `string` | no | Unique entry identifier. If omitted, the server MAY auto-generate one. |
| `caused_by` | `string` | no | `entry_id` of the entry that caused this one. |
| `tags` | `string[]` | no | Tags for this entry. |

**Returns:** The written entry including server-generated `timestamp` and optionally `entry_id` (if auto-generated or provided).

### `get_trail_stats`

Get summary statistics for the trail log. Useful for dashboards and health checks.

**Parameters:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `requester` | `string` | — | Filter by requester. |
| `since` | `string` | — | Only count entries after this time. |

**Returns:**
```json
{
  "total_entries": 1234,
  "by_action": {"posted": 500, "fetched": 400, "selected": 200, "failed": 80, "skipped": 54},
  "unique_content_ids": 350,
  "first_entry": "2026-01-15T10:00:00Z",
  "last_entry": "2026-04-05T14:07:00Z"
}
```

### Auto-Logging

Publishing tools (e.g., `send_photo`, `publish_post`) SHOULD accept optional `content_id`, `requester`, and `trace_id` parameters. When provided, the tool automatically appends a `posted` entry on success, or a `failed` entry on error. This eliminates the need for a separate `mark_trail` call after every publish.

---

## Discovery

An MCP server implementing TRAIL SHOULD advertise support via the `trail` capability in its server metadata:

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

This allows the orchestrator to:
- Know which servers support TRAIL without trial and error
- Discover which publishing tools auto-log
- Verify protocol version compatibility

---

## Pipeline Example

A scheduled task `daily-content` fetches a top image from an aggregator, posts to Telegram, then cross-posts to VK.

### Aggregator `trail.jsonl`
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

The orchestrator queries any server's trail with `trace_id=t-20260405-001` and reconstructs the full pipeline:

```
aggregator → fetched(12345, 12346) → selected(12345) → skipped(12346)
telegram   → posted(12345, msg #42)
vk         → failed(12345, rate_limit) → retrying(12345) → posted(12345, post #99)
```

---

## Deduplication

Servers do NOT enforce deduplication themselves. The orchestrator is responsible:

1. Before fetching: call `get_trail(requester="daily-content", since="2026-04-04T00:00:00Z")` on the **source** server to see what was recently fetched
2. Before posting: call `get_trail(content_id="civitai:image:12345", action="posted")` on the **destination** server to check if already posted
3. Source servers MAY offer a convenience parameter (e.g., `exclude_used=true`) that pre-filters results using the trail

---

## Log Rotation

At typical posting rates (~50 entries/day), a single file handles years of data. For high-volume deployments:

### Rotation Strategy

When `trail.jsonl` exceeds a configurable size threshold (default: 10 MB), the server SHOULD:

1. Rename current file: `trail.jsonl` → `trail.{YYYY-MM}.jsonl` (e.g., `trail.2026-03.jsonl`)
2. Optionally compress: `trail.2026-03.jsonl.gz`
3. Start a fresh `trail.jsonl`

### Querying Rotated Logs

`get_trail` MUST query the active `trail.jsonl` file. It MAY also query rotated files when the `since` parameter requests data older than the active file's first entry.

### Retention

Servers MAY define a retention period (e.g., 90 days). Entries older than the retention period MAY be deleted during rotation. Servers MUST document their retention policy.

---

## Versioning and Evolution

### Version Field

The `version` field enables forward evolution. The current version is `2`. Future versions may add checksums, compression, or binary formats.

### Compatibility Rules

- Servers MUST write entries with `version: 2` under this spec
- Servers MUST ignore entries with unknown `version` values (forward compatibility)
- Servers MUST ignore unknown fields in entries (extensibility)
- The `details` field is always open — unknown sub-fields MUST be preserved, not stripped

### Deprecation Policy

- Deprecated features are announced at least one minor version before removal
- Removed features are listed in a CHANGELOG

---

## Security and Privacy

### Sensitive Data

The `details` field MAY contain sensitive information (user IDs, API keys in error messages, PII in content titles). Implementations SHOULD:

- Never log API keys, tokens, or passwords in `details`
- Support a configurable `redact_fields` list to strip sensitive sub-fields before writing
- Document which fields may contain PII

### Access Control

Trail files contain operational data that may be sensitive. Servers SHOULD:

- Store trail files with restrictive permissions (e.g., `0600`)
- Not expose `get_trail` to unauthorized clients
- Consider rate-limiting `get_trail` queries

---

## OpenTelemetry Bridge

TRAIL entries can be exported as OpenTelemetry spans for integration with existing observability infrastructure.

### Mapping

| TRAIL Field | OTel Span Attribute |
|------------|---------------------|
| `trace_id` | `traceId` (if 32 hex chars) or `trail.trace_id` |
| `entry_id` | `spanId` |
| `timestamp` | `startTime` |
| `content_id` | `trail.content_id` |
| `action` | `name` (operation name) |
| `requester` | `trail.requester` |
| `details.*` | `trail.details.*` (flattened) |
| `tags` | `trail.tags` |

### Span Kind Mapping

| TRAIL Action | OTel Span Kind |
|-------------|----------------|
| `fetched`, `selected` | `CLIENT` |
| `posted`, `delivered` | `PRODUCER` |
| `moderated` | `INTERNAL` |
| `failed` | `CLIENT` (with error status) |

This bridge is informational. A reference exporter may be provided in `examples/otel-bridge/`.

---

## Adoption Guide

### For server authors

1. Create `data/` directory in your server root
2. Implement the `Trail` class (see reference implementations)
3. Add `get_trail`, `mark_trail`, and optionally `get_trail_stats` tools
4. Add optional `content_id`, `requester`, and `trace_id` params to your publishing tools
5. Advertise TRAIL support in your server capabilities

### For orchestrator prompts

Include in your scheduled task prompt:
```
When posting content, ALWAYS pass content_id, requester, and trace_id parameters to track the content pipeline.
Before posting, check get_trail on the destination to avoid duplicates.
Generate one trace_id per pipeline run (e.g., "daily-YYYY-MM-DD-NNN") and pass it to all servers.
```

---

## Comparison with Alternatives

| Approach | Shared State | Setup | Use Case |
|----------|:---:|-------|----------|
| **TRAIL** | No | Copy one file | Content tracking across MCP servers |
| Shared Database | Yes | Deploy DB + migrations | General state sharing |
| Message Queue | Yes | Deploy broker | Real-time event streaming |
| OpenTelemetry | No | SDK + collector + backend | Tool call tracing (not content semantics) |
| ActivityPub | Yes (federation) | Full server | Social federation |

TRAIL is designed specifically for the MCP orchestrator use case where each server is independent and the LLM is the sole mediator.

---

## FAQ

**Q: Why readable field names instead of short ones?**
A: A protocol meant to last decades must be self-documenting. When a developer sees a trail file for the first time, `content_id` is immediately clear. The ~15 KB/year overhead at typical rates is negligible, and gzip eliminates it entirely.

**Q: Why not a shared database?**
A: MCP servers are isolated by design. A shared DB creates coupling, deployment complexity, and a single point of failure. The orchestrator already sees all servers — let it do the correlation.

**Q: Are all optional fields really needed?**
A: No field is required except the five core ones. Optional fields (`trace_id`, `entry_id`, `caused_by`, `tags`) unlock advanced use cases (pipeline reconstruction, OTel integration, DAG visualization) without adding burden to simple implementations. If you don't need them, don't include them.

**Q: What about log rotation?**
A: See [Log Rotation](#log-rotation). At ~50 entries/day, one file handles years. For high-volume deployments, rotate at 10 MB.

**Q: Can I add custom fields to the root?**
A: No. Put everything custom in `details`. Root-level fields are reserved for the protocol. This ensures parsers can always rely on the root schema.

**Q: What if the orchestrator crashes mid-pipeline?**
A: The trail shows exactly where it stopped. Use `trace_id` to find all entries from that pipeline run. The last entry's `action` tells you where to resume.

**Q: How does TRAIL compare to OpenTelemetry?**
A: OTel traces tool *calls* (function invocations, latencies, errors). TRAIL tracks content *semantics* (what was published where). They are complementary. Use the OTel bridge to combine both in one dashboard.
