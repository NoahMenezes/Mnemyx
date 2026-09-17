// ---------------------------------------------------------------------------
// Query-shaping primitives shared by every search path: LIKE escaping,
// over-fetch sizing, outcome-tier SQL, FTS match building, and Phase 7
// repo scoping. Pure functions — no DB access.
// ---------------------------------------------------------------------------

import { loadConfig, DEFAULT_RANKING } from "../config.ts";

// Hardening: bound the work any single query can trigger. FTS already caps
// at 10 tokens and the embedder would happily chew megabytes, so overlong
// queries are rejected up front (both search paths share this).
export const MAX_QUERY_LENGTH = 500;

// Escape LIKE wildcards so a query like "100%" matches literally.
export function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Over-fetch multiplier so post-filter results still fill `limit`.
export function fetchSize(wanted: number): number {
  return Math.min(wanted * 3 + 10, 500);
}

// Outcome tier for ranking: proven successes first, unknowns next, proven
// failures last. This is the "boost": gentle and progressive — on a DB with
// no hook data every row is tier 1 and ordering is exactly Phase 2's.
export function outcomeTier(alias: string): string {
  return `CASE WHEN ${alias}.exit_code = 0 THEN 0 WHEN ${alias}.exit_code IS NULL THEN 1 ELSE 2 END`;
}

// Phase 2 keyword search: SQLite FTS5 full-text match with BM25 ranking.
// The user query is tokenized to alphanumeric words; each becomes a prefix
// term (`commit*` matches `commit`), joined with AND so multi-word queries
// narrow instead of widen. Tokens are extracted by regex (never interpolated
// raw), so FTS5 operator characters in user input can't break the query.
// Queries with no searchable tokens (e.g. only symbols like "&&") fall back
// to the Phase 1 LIKE match so the tool never returns nothing spuriously.
export function buildFtsMatch(query: string): string | null {
  // NFC for the same reason history import normalizes (macOS NFD text).
  const tokens = query.normalize("NFC").toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 10)
    .map((t) => `${t}*`)
    .join(" AND ");
}

// ---------------------------------------------------------------------------
// Phase 7: project scoping ("this project first").
//
// The server's own cwd is meaningless (MCP clients spawn it anywhere), so
// the repo always arrives as an explicit caller-supplied path (workspace
// root / `git rev-parse --show-toplevel`). Hook v2 stores exactly that
// string per command; pre-hook rows keep repo NULL = unknown and never
// match a filter.
// ---------------------------------------------------------------------------

/**
 * Normalize a caller-supplied repo scope to the stored form.
 * Lenient on purpose: no fs/git checks, so deleted or renamed checkouts
 * still filter against their stored strings. Blank/undefined -> null
 * (global search, today's behavior). NFC-normalized like everything stored.
 */
export function normalizeScopeRepo(input: string | undefined | null): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim().normalize("NFC");
  if (trimmed === "") return null;
  // Strip trailing slashes (except the filesystem root) so
  // "/repo" and "/repo/" scope identically.
  if (trimmed.length > 1) {
    const stripped = trimmed.replace(/\/+$/, "");
    return stripped === "" ? "/" : stripped;
  }
  return trimmed;
}

/**
 * Stable same-repo-first partition. Preserves the input order within each
 * group (recency / relevance / outcome-tier order all survive). Unknown
 * repos (NULL) always stay in the global group.
 */
export function partitionRepoFirst<T extends { repo: string | null }>(
  rows: T[],
  repo: string | null
): T[] {
  if (repo === null) return rows;
  const same: T[] = [];
  const rest: T[] = [];
  for (const r of rows) {
    if (r.repo !== null && r.repo === repo) same.push(r);
    else rest.push(r);
  }
  return [...same, ...rest];
}

// ---------------------------------------------------------------------------
// Phase 13: learning-to-rank blend (frequency + recency). Both signals
// already live in `commands` (every run is a row with a timestamp), so no
// schema change and nothing new to track.
//
// Placement: AFTER repo-boost and outcome-tier, BEFORE rank/timestamp —
// the blend reorders within equal (repo, outcome) groups but never
// promotes a failure above a success. All terms are plain arithmetic
// (deliberately no LN/EXP: bun:sqlite builds vary in math-function
// support, and bounded terms can't swamp relevance anyway):
//   frequency: fw * MIN(runs,10)/10          ∈ [0, fw]
//   recency:   rw * 1/(1+ageDays/halfLife)   ∈ (0, rw]
// Zero weights skip the JOIN entirely and emit the legacy SQL verbatim,
// so the escape hatch is byte-identical to pre-Phase-13 behavior.
// ---------------------------------------------------------------------------

export interface BlendParams {
  frequencyWeight: number;
  recencyWeight: number;
  recencyHalfLifeDays: number;
  /** Reference "now" (unix sec) — injectable for tests. */
  nowSec: number;
}

/** Coerced blend params from config (fresh read per call, like denylist). */
export function resolveBlend(configPath?: string, nowSec?: number): BlendParams {
  const w = configPath !== undefined
    ? loadConfig(configPath).ranking
    : loadConfig().ranking;
  const frequencyWeight =
    typeof w.frequencyWeight === "number" && Number.isFinite(w.frequencyWeight)
      ? Math.max(0, w.frequencyWeight)
      : DEFAULT_RANKING.frequencyWeight;
  const recencyWeight =
    typeof w.recencyWeight === "number" && Number.isFinite(w.recencyWeight)
      ? Math.max(0, w.recencyWeight)
      : DEFAULT_RANKING.recencyWeight;
  const recencyHalfLifeDays =
    typeof w.recencyHalfLifeDays === "number" && Number.isFinite(w.recencyHalfLifeDays)
      ? Math.max(1, w.recencyHalfLifeDays)
      : DEFAULT_RANKING.recencyHalfLifeDays;
  const now =
    nowSec !== undefined && Number.isFinite(nowSec) ? Math.floor(nowSec) : Math.floor(Date.now() / 1000);
  return { frequencyWeight, recencyWeight, recencyHalfLifeDays, nowSec: now };
}

export function blendActive(b: BlendParams): boolean {
  return b.frequencyWeight > 0 || b.recencyWeight > 0;
}

/** LEFT JOIN run-counts per exact command text (one row per distinct command). */
export function blendJoin(alias: string): string {
  return `LEFT JOIN (SELECT command AS _fc, COUNT(*) AS _runs FROM commands GROUP BY command) _f ON _f._fc = ${alias}.command`;
}

/** DESC fragment: higher blend = more habitual + more recent. */
export function blendOrder(alias: string, b: BlendParams): string {
  return `((${b.frequencyWeight} * MIN(COALESCE(_f._runs, 0), 10) / 10.0) + (${b.recencyWeight} * (1.0 / (1.0 + (${b.nowSec} - ${alias}.timestamp) / 86400.0 / ${b.recencyHalfLifeDays})))) DESC`;
}

/** JS-side twin of the SQL blend (semantic path scores in JS, not SQL). */
export function blendScore(runs: number, timestamp: number, b: BlendParams): number {
  const freq = b.frequencyWeight * Math.min(Math.max(0, runs), 10) / 10;
  const ageDays = Math.max(0, (b.nowSec - timestamp) / 86400);
  return freq + b.recencyWeight * (1 / (1 + ageDays / b.recencyHalfLifeDays));
}
