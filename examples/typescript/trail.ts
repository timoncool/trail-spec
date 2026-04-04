/**
 * trail.ts — TRAIL Protocol v1 (Tracking Records Across Isolated Logs)
 *
 * Reference implementation for TypeScript MCP servers.
 * https://github.com/timoncool/trail-spec
 *
 * Usage:
 *   import { Trail } from "./trail";
 *   const trail = new Trail("./data");
 *   trail.append("civitai:image:12345", "posted", "daily-post");
 *   const entries = trail.query({ cid: "civitai:image:12345" });
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

export interface TrailEntry {
  v: 1;
  t: string;
  cid: string;
  act: string;
  req: string;
  d?: Record<string, unknown>;
}

export interface TrailQuery {
  /** Filter by content ID (exact match or prefix) */
  cid?: string;
  /** Filter by action */
  act?: string;
  /** Filter by requester */
  req?: string;
  /** Max entries to return, newest first (0 = unlimited) */
  limit?: number;
}

export class Trail {
  private static readonly FILENAME = "trail.jsonl";
  private static readonly VERSION = 1;
  private path: string;

  constructor(dataDir: string) {
    this.path = join(dataDir, Trail.FILENAME);
    mkdirSync(dirname(this.path), { recursive: true });
  }

  /**
   * Append an event to the trail.
   * @param cid Content ID in format source:type:id
   * @param act Action — fetched, selected, posted, failed, skipped
   * @param req Requester — workflow or scheduler task ID
   * @param d Optional platform-specific details
   */
  append(
    cid: string,
    act: string,
    req: string,
    d?: Record<string, unknown>
  ): TrailEntry {
    const entry: TrailEntry = {
      v: Trail.VERSION,
      t: new Date().toISOString(),
      cid,
      act,
      req,
    };
    if (d) entry.d = d;

    appendFileSync(this.path, JSON.stringify(entry) + "\n", "utf-8");
    return entry;
  }

  /** Query the trail with filters. Returns newest first. */
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

    const result = entries.reverse();
    return limit ? result.slice(0, limit) : result;
  }

  /** Check if content was already posted. */
  isUsed(cid: string): boolean {
    return this.query({ cid, act: "posted", limit: 1 }).length > 0;
  }

  /** Get set of all posted content IDs. */
  getUsedCids(req?: string): Set<string> {
    const entries = this.query({ act: "posted", req, limit: 0 });
    return new Set(entries.map((e) => e.cid));
  }
}
