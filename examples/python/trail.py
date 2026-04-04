"""trail.py — TRAIL Protocol v1 (Tracking Records Across Isolated Logs)

Reference implementation for Python MCP servers.
https://github.com/timoncool/trail-spec

Usage:
    from trail import Trail

    trail = Trail("./data")
    await trail.append(cid="civitai:image:12345", act="posted", req="daily-post")
    entries = await trail.query(cid="civitai:image:12345")
"""

import json
import asyncio
from pathlib import Path
from datetime import datetime, timezone


class Trail:
    """TRAIL-compatible content log. Append-only JSONL."""

    FILENAME = "trail.jsonl"
    VERSION = 1

    def __init__(self, data_dir: str | Path):
        self._path = Path(data_dir) / self.FILENAME
        self._lock = asyncio.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    async def append(self, cid: str, act: str, req: str, d: dict | None = None) -> dict:
        """Append an event to the trail.

        Args:
            cid: Content ID in format source:type:id (e.g. "civitai:image:12345")
            act: Action — fetched, selected, posted, failed, skipped
            req: Requester — workflow or scheduler task ID
            d: Optional platform-specific details
        """
        entry = {
            "v": self.VERSION,
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
        """Query the trail with filters. Returns newest first.

        Args:
            cid: Filter by content ID (exact match or prefix)
            act: Filter by action
            req: Filter by requester
            limit: Max entries to return (0 = unlimited)
        """
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

        result = list(reversed(entries))
        return result[:limit] if limit else result

    async def is_used(self, cid: str) -> bool:
        """Check if content was already posted."""
        entries = await self.query(cid=cid, act="posted", limit=1)
        return len(entries) > 0

    async def get_used_cids(self, req: str | None = None) -> set[str]:
        """Get set of all posted content IDs."""
        entries = await self.query(act="posted", req=req, limit=0)
        return {e["cid"] for e in entries}
