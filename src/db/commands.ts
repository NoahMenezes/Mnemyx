// ---------------------------------------------------------------------------
// Command history: writes (insert/bulk), keyword search (FTS5 + LIKE
// fallback), recents, exit-code stamping, and the time-window primitive
// used by commit correlation.
// ---------------------------------------------------------------------------

import { getDb, withBusyRetry, clampLimit } from "./connection.ts";
import {
  COMMAND_COLS,
  COMMAND_COLS_ALIASED,
  rowToEntry,
  type CommandRow,
  type DbRow,
  type HistoryEntry,
  type RecentOptions,
  type SearchOptions,
} from "./types.ts";
import {
  MAX_QUERY_LENGTH,
  buildFtsMatch,
  escapeLike,
  fetchSize,
  normalizeScopeRepo,
  outcomeTier,
  resolveBlend,
  blendActive,
  blendJoin,
  blendOrder,
} from "./scope.ts";
import { loadConfig, firstToken } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { normalizeError } from "../errorFingerprint.ts";

// Insert one command. INSERT OR IGNORE makes startup re-imports idempotent:
// re-parsing the same history files never creates duplicates and keeps ids stable.
// Stored text is NFC-normalized (macOS NFD input), so the DB holds one form.
export function insertCommand(entry: HistoryEntry): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO commands
         (command, timestamp, source_file, shell, is_approximate_timestamp)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      entry.command.normalize("NFC"),
      entry.timestamp,
      entry.sourceFile,
      entry.shell,
      entry.timestampApproximate ? 1 : 0
    );
}

// Bulk insert inside a single transaction. History files are thousands of
// rows; one txn is ~100x faster than autocommit-per-row.
//
// Counting subtlety (same family as applyExitCodes): the commands_ai FTS
// trigger fires per row and inflates sqlite changes() ~3x, so the added
// count comes from a before/after row count inside the same transaction
// instead of trusting per-statement change counts.
export function bulkInsert(entries: HistoryEntry[]): number {
  const database = getDb();
  const stmt = database.query(
    `INSERT OR IGNORE INTO commands
       (command, timestamp, source_file, shell, is_approximate_timestamp)
     VALUES (?, ?, ?, ?, ?)`
  );
  const countAll = database.query(`SELECT COUNT(*) AS n FROM commands;`);
  const insertMany = database.transaction((rows: HistoryEntry[]) => {
    const before = (countAll.get() as { n: number }).n;
    for (const e of rows) {
      stmt.run(
        e.command.normalize("NFC"),
        e.timestamp,
        e.sourceFile,
        e.shell,
        e.timestampApproximate ? 1 : 0
      );
    }
    return (countAll.get() as { n: number }).n - before;
  });
  return withBusyRetry(() => insertMany(entries));
}

// Noise filter: drop rows whose command name (first token) is denied.
// We over-fetch from SQLite, then filter + slice, so `limit` still means
// "N usable results" from the caller's perspective. Exported: the semantic
// path (embeddings.ts) reuses it so both modes filter identically.
export function applyDenylist(rows: CommandRow[], limit: number): CommandRow[] {
  const denied = new Set(loadConfig().denylist);
  const out: CommandRow[] = [];
  for (const r of rows) {
    if (denied.has(firstToken(r.command))) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Stable outcome-tier sort (proven success -> unknown -> failure).
// Stable, so a pre-sorted relevance order (FTS rank, vector score) is kept
// within each tier. Exported for the semantic path; the keyword path does
// the same tiers in SQL.
export function sortByOutcomeTier(rows: CommandRow[]): CommandRow[] {
  const tier = (r: CommandRow): number =>
    r.exitCode === 0 ? 0 : r.exitCode === null ? 1 : 2;
  return [...rows].sort((a, b) => tier(a) - tier(b));
}

export function searchCommands(
  query: string,
  limitOrOptions?: number | SearchOptions
): CommandRow[] {
  const opts: SearchOptions =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : (limitOrOptions ?? {});
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(
      `query too long (${trimmed.length} chars, max ${MAX_QUERY_LENGTH})`
    );
  }
  const wanted = clampLimit(opts.limit, 20);
  const successFilter = opts.onlySuccessful === true;
  // Phase 7: normalize here so callers can pass the raw repo_path straight
  // through. onlyRepo without a repo is meaningless -> treat as global.
  const scopeRepo = normalizeScopeRepo(opts.repo ?? null);
  const strictRepo = opts.onlyRepo === true && scopeRepo !== null;
  const boostRepo = !strictRepo ? scopeRepo : null;
  // Phase 13: habitual + recent commands rank above stale one-offs within
  // equal (repo, outcome) groups. Zero weights emit the legacy SQL.
  const blend = resolveBlend(opts.configPath, opts.nowSec);
  const useBlend = blendActive(blend);
  const match = buildFtsMatch(trimmed);
  let rows: DbRow[];
  if (match === null) {
    rows = getDb()
      .query(
        `SELECT ${COMMAND_COLS}
         FROM commands
         ${useBlend ? blendJoin("commands") : ""}
         WHERE command LIKE '%' || ? || '%' ESCAPE '\\'
           ${successFilter ? "AND exit_code = 0" : ""}
           ${strictRepo ? "AND repo = ?" : ""}
         ORDER BY ${boostRepo !== null ? "CASE WHEN repo = ? THEN 0 ELSE 1 END," : ""} ${outcomeTier("commands")}, ${useBlend ? `${blendOrder("commands", blend)},` : ""} timestamp DESC
         LIMIT ?`
      )
      .all(
        ...(strictRepo && scopeRepo !== null
          ? [escapeLike(trimmed), scopeRepo]
          : [escapeLike(trimmed)]),
        ...(boostRepo !== null ? [boostRepo] : []),
        fetchSize(wanted)
      ) as DbRow[];
  } else {
    rows = getDb()
      .query(
        `SELECT ${COMMAND_COLS_ALIASED}
         FROM commands_fts f JOIN commands c ON c.id = f.rowid
         ${useBlend ? blendJoin("c") : ""}
         WHERE commands_fts MATCH ?
           ${successFilter ? "AND c.exit_code = 0" : ""}
           ${strictRepo ? "AND c.repo = ?" : ""}
         ORDER BY ${boostRepo !== null ? "CASE WHEN c.repo = ? THEN 0 ELSE 1 END," : ""} ${outcomeTier("c")}, ${useBlend ? `${blendOrder("c", blend)},` : ""} rank
         LIMIT ?`
      )
      .all(
        ...(strictRepo && scopeRepo !== null ? [match, scopeRepo] : [match]),
        ...(boostRepo !== null ? [boostRepo] : []),
        fetchSize(wanted)
      ) as DbRow[];
  }
  return applyDenylist(rows.map(rowToEntry), wanted);
}

// Most recent commands, no query needed — useful for general context.
// Denylist applies here too (recents full of `ls`/`cd` help nobody).
// Chronological order is kept (no outcome reordering here); exit codes
// show up as annotations via formatRows.
// Phase 7: optional repo scope — same-repo first (stable, chronology kept
// within each group), or strict with onlyRepo.
export function getRecentCommands(limitOrOptions?: number | RecentOptions): CommandRow[] {
  const opts: RecentOptions =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : (limitOrOptions ?? {});
  const wanted = clampLimit(opts.limit, 10);
  const scopeRepo = normalizeScopeRepo(opts.repo ?? null);
  const strictRepo = opts.onlyRepo === true && scopeRepo !== null;
  const boostRepo = !strictRepo ? scopeRepo : null;
  const rows = getDb()
    .query(
      `SELECT ${COMMAND_COLS}
       FROM commands
       ${strictRepo ? "WHERE repo = ?" : ""}
       ORDER BY ${boostRepo !== null ? "CASE WHEN repo = ? THEN 0 ELSE 1 END," : ""} timestamp DESC
       LIMIT ?`
    )
    .all(
      ...(strictRepo && scopeRepo !== null ? [scopeRepo] : []),
      ...(boostRepo !== null ? [boostRepo] : []),
      fetchSize(wanted)
    ) as DbRow[];
  return applyDenylist(rows.map(rowToEntry), wanted);
}

// Commands inside a time window — the correlation primitive. Newest first,
// denylist-filtered so `ls`/`cd` don't drown the story.
export function getCommandsInWindow(
  fromTs: number,
  toTs: number,
  limit?: number
): CommandRow[] {
  const wanted = clampLimit(limit, 20);
  const rows = getDb()
    .query(
      `SELECT ${COMMAND_COLS}
       FROM commands WHERE timestamp >= ? AND timestamp <= ?
       ORDER BY timestamp DESC LIMIT ?`
    )
    .all(
      Math.floor(fromTs),
      Math.floor(toTs),
      fetchSize(wanted)
    ) as DbRow[];
  return applyDenylist(rows.map(rowToEntry), wanted);
}

// Newest N commands with no denylist filtering — the session-clustering
// input (Phase 9). Grouping sees everything (so boundaries stay stable);
// display-time filtering happens later. Newest first.
export function getCommandTimeline(limit: number): CommandRow[] {
  const n = Number.isFinite(limit)
    ? Math.min(5000, Math.max(1, Math.floor(limit)))
    : 500;
  const rows = getDb()
    .query(
      `SELECT ${COMMAND_COLS}
       FROM commands ORDER BY timestamp DESC, id DESC LIMIT ?`
    )
    .all(n) as DbRow[];
  return rows.map(rowToEntry);
}

// Fetch full rows for scored ids (order restored by the caller).
export function getCommandsByIds(ids: number[]): CommandRow[] {
  if (ids.length === 0) return [];
  const out: CommandRow[] = [];
  // IN-list chunked so very large id sets can't blow the variable limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .query(
        `SELECT ${COMMAND_COLS}
         FROM commands WHERE id IN (${placeholders})`
      )
      .all(...chunk) as DbRow[];
    out.push(...rows.map(rowToEntry));
  }
  return out;
}

// Phase 13: run counts per exact command text — the frequency signal.
// Chunked IN-list like getCommandsByIds; missing texts read back as 0
// (callers default via `?? 0`, so partial maps are safe).
export function countCommandRuns(commands: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const uniq = [...new Set(commands)];
  for (let i = 0; i < uniq.length; i += 500) {
    const chunk = uniq.slice(i, i + 500);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = getDb()
      .query(
        `SELECT command, COUNT(*) AS n FROM commands WHERE command IN (${placeholders}) GROUP BY command`
      )
      .all(...chunk) as { command: string; n: number }[];
    for (const r of rows) out.set(r.command, r.n);
  }
  return out;
}

// Phase 3: stamp hook-observed outcomes onto matching history rows.
// Matching is by exact command text; every row with that text gets the
// LATEST observed exit code (the map is already last-wins). Hook v2 lines
// additionally carry cwd/repo: those stamp the latest observed location
// onto matching rows (NULL before any v2 observation). Runs in one
// transaction; returns the number of rows updated. Re-running with the
// same log is a true no-op (rows already carrying the values are skipped,
// so the FTS sync triggers don't churn either).
//
// Counting subtlety: the commands_au FTS trigger fires on every UPDATE,
// which inflates sqlite changes() — so we count rows-to-change with a
// SELECT first instead of trusting the UPDATE's change count.
export interface ExitOutcome {
  exit: number;
  cwd?: string | null;
  repo?: string | null;
  /** Raw stderr tail (v3 log lines). Redacted + fingerprinted before storage. */
  stderr?: string | null;
}

export function applyExitCodes(
  outcomes: Map<string, ExitOutcome>
): number {
  if (outcomes.size === 0) return 0;
  const database = getDb();
  const pendingStmt = database.query(
    `SELECT COUNT(*) AS n FROM commands WHERE command = ? AND (exit_code IS NULL OR exit_code != ?)`
  );
  const updateStmt = database.query(
    `UPDATE commands SET exit_code = ? WHERE command = ? AND (exit_code IS NULL OR exit_code != ?)`
  );
  const pendingCtxStmt = database.query(
    `SELECT COUNT(*) AS n FROM commands
     WHERE command = ? AND (IFNULL(cwd, '') != ? OR IFNULL(repo, '') != ?)`
  );
  const updateCtxStmt = database.query(
    `UPDATE commands SET cwd = ?, repo = ?
     WHERE command = ? AND (IFNULL(cwd, '') != ? OR IFNULL(repo, '') != ?)`
  );
  // Phase 8: stderr goes through redact-before-store HERE — the single
  // choke point for these columns. The raw snippet never reaches SQLite:
  // what lands in stderr_snippet is already masked, and stderr_fp is the
  // normalized fingerprint of the masked text. Only failures with actual
  // output are stored (success chatter would only bloat the match column).
  const extraPatterns = loadConfig().redactPatterns;
  const pendingErrStmt = database.query(
    `SELECT COUNT(*) AS n FROM commands
     WHERE command = ? AND (IFNULL(stderr_fp, '') != ?)`
  );
  const updateErrStmt = database.query(
    `UPDATE commands SET stderr_snippet = ?, stderr_fp = ?
     WHERE command = ? AND (IFNULL(stderr_fp, '') != ?)`
  );
  const applyMany = database.transaction(
    (entries: [string, ExitOutcome][]): number => {
      let updated = 0;
      for (const [command, outcome] of entries) {
        const pending = (
          pendingStmt.get(command, outcome.exit) as { n: number }
        ).n;
        if (pending > 0) {
          updateStmt.run(outcome.exit, command, outcome.exit);
          updated += pending;
        }
        // v1 lines (no context) skip this entirely: nothing new to stamp.
        // Empty string would only ever come from hand-edited logs —
        // normalize to NULL so "unknown" has exactly one representation.
        const cwd = outcome.cwd?.trim() ? outcome.cwd.trim() : null;
        const repo = outcome.repo?.trim() ? outcome.repo.trim() : null;
        if (cwd !== null || repo !== null) {
          const wantCwd = cwd ?? "";
          const wantRepo = repo ?? "";
          const pendingCtx = (
            pendingCtxStmt.get(command, wantCwd, wantRepo) as { n: number }
          ).n;
          if (pendingCtx > 0) {
            updateCtxStmt.run(
              cwd,
              repo,
              command,
              wantCwd,
              wantRepo
            );
            updated += pendingCtx;
          }
        }
        // Phase 8: stderr stamping. Failures only, non-empty only — and the
        // fingerprint gates the write, so identical reruns are no-ops.
        if (outcome.exit !== 0 && typeof outcome.stderr === "string" && outcome.stderr.trim() !== "") {
          const snippet = redactSecrets(outcome.stderr, extraPatterns).text;
          const fp = normalizeError(outcome.stderr, extraPatterns);
          if (fp !== "") {
            const pendingErr = (
              pendingErrStmt.get(command, fp) as { n: number }
            ).n;
            if (pendingErr > 0) {
              updateErrStmt.run(snippet, fp, command, fp);
              updated += pendingErr;
            }
          }
        }
      }
      return updated;
    }
  );
  return withBusyRetry(() => applyMany([...outcomes.entries()]));
}
