/**
 * trail.ts — TRAIL Protocol v2 (Tracking Records Across Isolated Logs)
 *
 * Reference implementation for TypeScript MCP servers.
 * https://github.com/timoncool/trail-spec
 *
 * Usage:
 *   import { Trail } from "./trail";
 *   const trail = new Trail("./data");
 *   trail.append("civitai:image:12345", "posted", "daily-post", { details: { platform: "telegram" } });
 *   const { entries, total } = trail.query({ content_id: "civitai:image:12345" });
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

export interface TrailEntry {
  version: number;
  timestamp: string;
  content_id: string;
  action: string;
  requester: string;
  details?: Record<string, unknown>;
  trace_id?: string;
  entry_id?: string;
  caused_by?: string;
  tags?: string[];
}

export interface TrailQuery {
  /** Filter by content ID (exact match or prefix) */
  content_id?: string;
  /** Filter by action */
  action?: string;
  /** Filter by requester */
  requester?: string;
  /** Filter by trace ID */
  trace_id?: string;
  /** Filter entries that have ALL specified tags */
  tags?: string[];
  /** ISO 8601 timestamp — only return entries after this time */
  since?: string;
  /** Max entries to return, newest first (0 = unlimited, default 50) */
  limit?: number;
  /** Number of entries to skip for pagination */
  offset?: number;
}

export interface TrailAppendOptions {
  details?: Record<string, unknown>;
  trace_id?: string;
  entry_id?: string;
  caused_by?: string;
  tags?: string[];
}

export interface TrailQueryResult {
  entries: TrailEntry[];
  total: number;
}

export interface TrailStats {
  total_entries: number;
  by_action: Record<string, number>;
  unique_content_ids: number;
  first_entry: string | null;
  last_entry: string | null;
}

export class Trail {
  private static readonly FILENAME = "trail.jsonl";
  private static readonly VERSION = 2;
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, Trail.FILENAME);
    mkdirSync(dirname(this.filePath), { recursive: true });
  }

  /**
   * Append an event to the trail.
   * @param content_id Content ID in format source:type:id
   * @param action Action — fetched, selected, posted, failed, skipped, retrying, etc.
   * @param requester Requester — workflow or scheduler task ID
   * @param options Optional: details, trace_id, entry_id, caused_by, tags
   */
  append(
    content_id: string,
    action: string,
    requester: string,
    options?: TrailAppendOptions
  ): TrailEntry {
    const entry: TrailEntry = {
      version: Trail.VERSION,
      timestamp: new Date().toISOString(),
      content_id,
      action,
      requester,
    };
    if (options?.details) entry.details = options.details;
    if (options?.trace_id) entry.trace_id = options.trace_id;
    if (options?.entry_id) entry.entry_id = options.entry_id;
    if (options?.caused_by) entry.caused_by = options.caused_by;
    if (options?.tags) entry.tags = options.tags;

    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", "utf-8");
    return entry;
  }

  /** Query the trail with filters. Returns entries newest first + total count. */
  query(q: TrailQuery = {}): TrailQueryResult {
    const {
      content_id,
      action,
      requester,
      trace_id,
      tags,
      since,
      limit = 50,
      offset = 0,
    } = q;

    if (!existsSync(this.filePath)) return { entries: [], total: 0 };

    const lines = readFileSync(this.filePath, "utf-8")
      .split("\n")
      .filter(Boolean);
    const matched: TrailEntry[] = [];

    for (const line of lines) {
      try {
        const entry: TrailEntry = JSON.parse(line);
        if (content_id && !entry.content_id.startsWith(content_id)) continue;
        if (action && entry.action !== action) continue;
        if (requester && entry.requester !== requester) continue;
        if (trace_id && entry.trace_id !== trace_id) continue;
        if (tags && !tags.every((t) => entry.tags?.includes(t))) continue;
        if (since && entry.timestamp < since) continue;
        matched.push(entry);
      } catch {
        continue;
      }
    }

    const total = matched.length;
    let result = matched.reverse();
    if (offset) result = result.slice(offset);
    if (limit) result = result.slice(0, limit);
    return { entries: result, total };
  }

  /** Get summary statistics for the trail. */
  stats(requester?: string, since?: string): TrailStats {
    const { entries } = this.query({ requester, since, limit: 0 });
    const byAction: Record<string, number> = {};
    const cids = new Set<string>();
    const timestamps: string[] = [];

    for (const e of entries) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      cids.add(e.content_id);
      timestamps.push(e.timestamp);
    }

    return {
      total_entries: entries.length,
      by_action: byAction,
      unique_content_ids: cids.size,
      first_entry: timestamps.length
        ? timestamps.reduce((a, b) => (a < b ? a : b))
        : null,
      last_entry: timestamps.length
        ? timestamps.reduce((a, b) => (a > b ? a : b))
        : null,
    };
  }

  /** Check if content was already posted. */
  isUsed(content_id: string, requester?: string): boolean {
    return (
      this.query({ content_id, action: "posted", requester, limit: 1 }).entries
        .length > 0
    );
  }

  /** Get set of all posted content IDs. */
  getUsedIds(requester?: string): Set<string> {
    const { entries } = this.query({ action: "posted", requester, limit: 0 });
    return new Set(entries.map((e) => e.content_id));
  }
}
