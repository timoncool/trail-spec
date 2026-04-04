# TRAIL — Tracking Records Across Isolated Logs

## Specification v1

**Version:** 1.0
**Date:** 2026-04-05
**Status:** Draft
**Authors:** timoncool

---

## Problem

MCP servers are isolated by design — each server has no visibility into other servers. When multiple MCP servers participate in a content pipeline (e.g., fetch from an aggregator → post to a messenger → cross-post to a social network), there is no standard way to:

- Track what content was published where
- Prevent duplicate publications
- Debug broken pipelines
- Audit the full lifecycle of a piece of content

The MCP specification intentionally does not address server-to-server communication. The **host** (LLM agent) is the sole orchestrator. TRAIL leverages that architecture: each server maintains its own log, the orchestrator reads all logs and connects the dots.

---

## Design Principles

1. **Each server owns its log.** No shared state, no central database, no inter-server communication.
2. **The orchestrator connects the dots.** The LLM reads logs from all servers and traces content by `cid`.
3. **Append-only.** Logs are immutable audit trails. Never edit or delete entries.
4. **Convention over configuration.** Same file name, same format, same fields everywhere.
5. **Zero dependencies.** JSONL + stdlib. No external libraries required.

---

## File

```
<mcp-server-root>/data/trail.jsonl
```

- **Format:** JSONL (JSON Lines) — one JSON object per line, UTF-8, `\n` line endings
- **Write mode:** Append-only
- **Concurrency:** Serialize writes (mutex/lock). Reads are lock-free.

---

## Entry Schema

```jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"source:image:12345","act":"posted","req":"daily-post","d":{"message_id":42}}
```

### Required Fields

| Field | Type     | Description |
|-------|----------|-------------|
| `v`   | `int`    | Protocol version. Always `1` for this spec. |
| `t`   | `string` | ISO 8601 timestamp with timezone. When the action occurred. |
| `cid` | `string` | Content ID. Universal identifier that follows content across servers. Format: `source:type:id`. See [Content ID](#content-id). |
| `act` | `string` | Action performed. See [Standard Actions](#standard-actions). |
| `req` | `string` | Requester — the workflow or scheduled task that initiated this action. Matches the scheduler's `taskId` or a human-readable pipeline name. |

### Optional Fields

| Field | Type     | Description |
|-------|----------|-------------|
| `d`   | `object` | Platform-specific details. Each server defines its own schema. See [Details Field](#details-field). |

---

### Content ID

Format: `source:type:id`

```
civitai:image:12345
unsplash:photo:abc-def
youtube:video:dQw4w9WgXcQ
runware:image:550e8400
```

Rules:
- `source` — origin platform, lowercase, no colons
- `type` — content type at the source (`image`, `video`, `model`, `prompt`)
- `id` — identifier at the source, as-is (string or numeric)
- The `cid` is **assigned at the source** and **carried unchanged** through every server in the pipeline

---

### Standard Actions

| Action     | Meaning |
|------------|---------|
| `fetched`  | Content retrieved from source (candidate list) |
| `selected` | Chosen from candidates by the orchestrator |
| `posted`   | Successfully published to this platform |
| `failed`   | Publish attempt failed. Reason in `d.error` |
| `skipped`  | Intentionally not used. Reason in `d.reason` |

Servers MAY define additional actions for internal use (e.g., `drafted`, `reviewed`, `voted`). Custom actions SHOULD be lowercase, single-word or hyphenated.

---

### Details Field

The `d` field is an open object. Each server defines what it stores. Examples:

**Source server (content aggregator):**
```json
{"d": {"url": "https://...", "model": "Flux.1", "sort_rank": 1}}
```

**Messenger (Telegram, Slack, Discord):**
```json
{"d": {"chat_id": "-100...", "message_id": 42}}
```

**Social network (Facebook, VK, Reddit):**
```json
{"d": {"post_id": 12345, "url": "https://..."}}
```

**On failure:**
```json
{"d": {"error": "rate_limit", "retry_after": 30}}
```

**On skip:**
```json
{"d": {"reason": "nsfw_detected"}}
```

---

## Standard Tools

Every MCP server implementing TRAIL SHOULD expose two tools:

### `get_trail`

Query the trail log with filters.

**Parameters:**

| Param  | Type     | Default | Description |
|--------|----------|---------|-------------|
| `cid`  | `string` | —       | Filter by content ID. Exact match or prefix (e.g., `civitai:image:` matches all Civitai images). |
| `act`  | `string` | —       | Filter by action. |
| `req`  | `string` | —       | Filter by requester. |
| `limit`| `int`    | `50`    | Max entries to return, newest first. |

**Returns:** Array of log entries, newest first.

### `mark_trail`

Explicitly write an entry to the trail log.

**Parameters:**

| Param  | Type     | Required | Description |
|--------|----------|----------|-------------|
| `cid`  | `string` | yes      | Content ID. |
| `act`  | `string` | yes      | Action. |
| `req`  | `string` | yes      | Requester. |
| `d`    | `object` | no       | Details. |

**Returns:** Confirmation with the written entry.

### Auto-Logging

Publishing tools (e.g., `send_photo`, `publish_post`) SHOULD accept optional `cid` and `req` parameters. When provided, the tool automatically appends a `posted` entry to the trail on success, or a `failed` entry on error. This eliminates the need for a separate `mark_trail` call after every publish.

---

## Pipeline Example

A scheduled task `daily-content` fetches a top image from an aggregator, posts to Telegram, then cross-posts to a social network.

### Aggregator `trail.jsonl`
```jsonl
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"source:image:12345","act":"fetched","req":"daily-content","d":{"url":"https://...","model":"Flux.1"}}
{"v":1,"t":"2026-04-05T14:07:00Z","cid":"source:image:12346","act":"fetched","req":"daily-content","d":{"url":"https://...","model":"SDXL"}}
{"v":1,"t":"2026-04-05T14:07:01Z","cid":"source:image:12345","act":"selected","req":"daily-content"}
{"v":1,"t":"2026-04-05T14:07:01Z","cid":"source:image:12346","act":"skipped","req":"daily-content","d":{"reason":"prompt_too_short"}}
```

### Messenger `trail.jsonl`
```jsonl
{"v":1,"t":"2026-04-05T14:07:05Z","cid":"source:image:12345","act":"posted","req":"daily-content","d":{"chat_id":"-100273...","message_id":42}}
```

### Social network `trail.jsonl`
```jsonl
{"v":1,"t":"2026-04-05T14:07:30Z","cid":"source:image:12345","act":"posted","req":"daily-content","d":{"post_id":99,"url":"https://social.example/post/99"}}
```

The orchestrator (LLM) queries any server's trail for `cid=source:image:12345` and reconstructs the full pipeline:

```
aggregator → fetched → selected
messenger  → posted  (msg #42)
social     → posted  (post #99)
```

---

## Deduplication

Servers do NOT enforce deduplication themselves. The orchestrator is responsible:

1. Before fetching: call `get_trail(req="daily-content", limit=100)` on the **source** server to see what was recently fetched
2. Before posting: call `get_trail(cid="source:image:12345")` on the **destination** server to check if already posted
3. Source servers MAY offer a convenience parameter (e.g., `exclude_used=true`) that pre-filters results using the trail

---

## Adoption Guide

### For server authors

1. Create `data/` directory in your server root
2. Implement the `Trail` class (see reference implementations below)
3. Add `get_trail` and `mark_trail` tools
4. Add optional `cid` + `req` params to your publishing tools
5. Drop this spec file into your repo as `TRAIL-SPEC.md`

### For orchestrator prompts

Include in your scheduled task prompt:
```
When posting content, ALWAYS pass cid and req parameters to track the content pipeline.
Before posting, check get_trail on the destination to avoid duplicates.
```

---

## Reference Implementation — Python

```python
"""trail.py — TRAIL Protocol v1 (Tracking Records Across Isolated Logs)"""

import json
import asyncio
from pathlib import Path
from datetime import datetime, timezone


class Trail:
    """TRAIL-compatible content log. Append-only JSONL."""

    def __init__(self, data_dir: str | Path):
        self._path = Path(data_dir) / "trail.jsonl"
        self._lock = asyncio.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    async def append(self, cid: str, act: str, req: str, d: dict | None = None) -> dict:
        """Append an event to the trail."""
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
        """Query the trail with filters. Returns newest first."""
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
        """Check if content was already posted."""
        entries = await self.query(cid=cid, act="posted", limit=1)
        return len(entries) > 0

    async def get_used_cids(self, req: str | None = None) -> set[str]:
        """Get set of all posted content IDs."""
        entries = await self.query(act="posted", req=req, limit=0)
        return {e["cid"] for e in entries}
```

---

## Reference Implementation — TypeScript

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

  /** Append an event to the trail */
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

  /** Query the trail with filters. Returns newest first */
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

  /** Check if content was already posted */
  isUsed(cid: string): boolean {
    return this.query({ cid, act: "posted", limit: 1 }).length > 0;
  }

  /** Get set of all posted content IDs */
  getUsedCids(req?: string): Set<string> {
    const entries = this.query({ act: "posted", req, limit: 0 });
    return new Set(entries.map((e) => e.cid));
  }
}
```

---

## Versioning

The `v` field enables future evolution:
- **v1** (this spec): flat JSONL, 5 fields, no schema validation
- **v2** (hypothetical): could add checksums, compression, or binary format

Servers MUST ignore entries with unknown `v` values. Servers MUST always write `v: 1` under this spec.

---

## FAQ

**Q: Why not a shared database?**
A: MCP servers are isolated by design. A shared DB creates coupling, deployment complexity, and a single point of failure. The orchestrator already sees all servers — let it do the correlation.

**Q: Why short field names?**
A: Logs grow forever. At 10 posts/day across 5 servers, that's 18K entries/year. Short keys save ~40% disk space and reduce parse time. The log is read by machines, not humans.

**Q: What about log rotation?**
A: At typical posting rates (~50 entries/day), a single file handles years of data. If needed, implement rotation externally (move `trail.jsonl` to `trail.2026.jsonl` and start fresh). The spec does not mandate rotation.

**Q: Can I add custom fields to the root?**
A: No. Put everything custom in `d`. This keeps the protocol fields stable and parseable.

**Q: What if the orchestrator crashes mid-pipeline?**
A: The trail shows exactly where it stopped. `source:image:12345` has `selected` in the aggregator but no `posted` in the messenger → the orchestrator knows to resume from the messenger.
