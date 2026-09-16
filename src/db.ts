import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { loadConfig, firstToken } from "./config.ts";

// Supported shells. Phase 1 scope: zsh + bash on macOS/Linux only.
export type SupportedShell = "zsh" | "bash";

// A single parsed history entry, before/after DB insertion.
export interface HistoryEntry {
  command: string;
  /** Unix epoch seconds. */
  timestamp: number;
  /** Absolute path of the history file this came from. */
  sourceFile: string;
  shell: SupportedShell;
  /** True when the timestamp is a fallback (e.g. file mtime), not real. */
  timestampApproximate: boolean;
}

// A row read back out of the `commands` table.
export interface CommandRow extends HistoryEntry {
  id: number;
  /**
   * Phase 3: this command's own exit code (0 = worked), from the opt-in
   * shell hook log. NULL = unknown (all pre-hook history, or hook not
   * installed). Unknown is NOT failure — it just means "no signal".
   */
  exitCode: number | null;
}

let db: Database | null = null;

// Resolve the per-user DB path. Absolute on purpose: MCP clients launch
// this server with an unpredictable cwd, so a repo-relative path would
// create stray DBs or fail to find the real one.
export function getDefaultDbPath(): string {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "mnemyx", "mnemyx.db");
  }
  // Linux (and fallback): XDG data home. macOS/Linux only in Phase 1.
  const dataHome =
    process.env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "mnemyx", "mnemyx.db");
}

// Open (creating parent dirs) and migrate the DB. Idempotent.
export function initDb(dbPath: string = getDefaultDbPath()): Database {
  if (db) return db;
  mkdirSync(join(dbPath, ".."), { recursive: true });
  db = new Database(dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL;");
  db.run(`
    CREATE TABLE IF NOT EXISTS commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      command TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      source_file TEXT NOT NULL,
      shell TEXT NOT NULL,
      is_approximate_timestamp INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      UNIQUE(command, timestamp, source_file)
    );
  `);
  // Migrate DBs created before the Phase 1 column naming
  // (timestamp_approximate -> is_approximate_timestamp), preserving rows.
  const colNames = (
    db.query(`PRAGMA table_info(commands);`).all() as { name: string }[]
  ).map((c) => c.name);
  if (
    colNames.includes("timestamp_approximate") &&
    !colNames.includes("is_approximate_timestamp")
  ) {
    db.run(
      `ALTER TABLE commands RENAME COLUMN timestamp_approximate TO is_approximate_timestamp;`
    );
  }
  // Phase 3: nullable outcome column. ALTER TABLE preserves every existing
  // row (all pre-hook history simply reads back as NULL = unknown).
  if (!colNames.includes("exit_code")) {
    db.run(`ALTER TABLE commands ADD COLUMN exit_code INTEGER;`);
  }
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commands_command ON commands(command);`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commands_timestamp ON commands(timestamp DESC);`
  );
  // Phase 2: full-text index over the command text. External-content FTS5
  // table keyed to commands.id; triggers keep it in sync on every write,
  // so normal INSERT/DELETE paths need no FTS-aware code.
  //
  // Sync-check subtlety (found the hard way): COUNT(*) on an external-content
  // FTS5 table returns the CONTENT table's row count even when the full-text
  // index itself is empty — so it can never tell us a rebuild is needed.
  // We compare against commands_fts_docsize instead (one row per indexed
  // doc, a plain table with a trustworthy count), and always rebuild when
  // the FTS table itself is newly created.
  const ftsExists =
    db.query(`SELECT 1 FROM sqlite_master WHERE name = 'commands_fts';`).get() !==
    undefined;
  db.run(
    `CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(command, content='commands', content_rowid='id', tokenize='unicode61');`
  );
  db.run(
    `CREATE TRIGGER IF NOT EXISTS commands_ai AFTER INSERT ON commands BEGIN
       INSERT INTO commands_fts(rowid, command) VALUES (new.id, new.command);
     END;`
  );
  db.run(
    `CREATE TRIGGER IF NOT EXISTS commands_ad AFTER DELETE ON commands BEGIN
       INSERT INTO commands_fts(commands_fts, rowid, command) VALUES ('delete', old.id, old.command);
     END;`
  );
  db.run(
    `CREATE TRIGGER IF NOT EXISTS commands_au AFTER UPDATE ON commands BEGIN
       INSERT INTO commands_fts(commands_fts, rowid, command) VALUES ('delete', old.id, old.command);
       INSERT INTO commands_fts(rowid, command) VALUES (new.id, new.command);
     END;`
  );
  // Backfill for DBs created before FTS existed (rebuild is idempotent).
  // A brand-new FTS table is always empty -> rebuild unconditionally.
  // Otherwise compare against the docsize table (see note above).
  const needsRebuild = (() => {
    if (!ftsExists) return true;
    const cmdCount = (
      db.query(`SELECT COUNT(*) AS n FROM commands;`).get() as { n: number }
    ).n;
    const ftsCount = (
      db.query(`SELECT COUNT(*) AS n FROM commands_fts_docsize;`).get() as {
        n: number;
      }
    ).n;
    return ftsCount !== cmdCount;
  })();
  if (needsRebuild) {
    db.run(`INSERT INTO commands_fts(commands_fts) VALUES('rebuild');`);
    const cmdCount = (
      db.query(`SELECT COUNT(*) AS n FROM commands;`).get() as { n: number }
    ).n;
    console.error(`[mnemyx] rebuilt FTS index (${cmdCount} rows)`);
  }
  return db;
}

// For tests / explicit close between runs.
export function closeDb(): void {
  db?.close();
  db = null;
}

function getDb(): Database {
  if (!db) throw new Error("DB not initialized — call initDb() first");
  return db;
}

const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

// Escape LIKE wildcards so a query like "100%" matches literally.
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Raw row shape as returned by bun:sqlite (snake_case, nullable exit_code).
interface DbRow {
  id: number;
  command: string;
  timestamp: number;
  source_file: string;
  shell: string;
  is_approximate_timestamp: number;
  exit_code: number | null;
}

function rowToEntry(row: DbRow): CommandRow {
  return {
    id: row.id,
    command: row.command,
    timestamp: row.timestamp,
    sourceFile: row.source_file,
    shell: row.shell as SupportedShell,
    timestampApproximate: row.is_approximate_timestamp === 1,
    exitCode: row.exit_code,
  };
}

// Insert one command. INSERT OR IGNORE makes startup re-imports idempotent:
// re-parsing the same history files never creates duplicates and keeps ids stable.
export function insertCommand(entry: HistoryEntry): void {
  getDb()
    .query(
      `INSERT OR IGNORE INTO commands
         (command, timestamp, source_file, shell, is_approximate_timestamp)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      entry.command,
      entry.timestamp,
      entry.sourceFile,
      entry.shell,
      entry.timestampApproximate ? 1 : 0
    );
}

// Bulk insert inside a single transaction. History files are thousands of
// rows; one txn is ~100x faster than autocommit-per-row.
export function bulkInsert(entries: HistoryEntry[]): number {
  const database = getDb();
  const stmt = database.query(
    `INSERT OR IGNORE INTO commands
       (command, timestamp, source_file, shell, is_approximate_timestamp)
     VALUES (?, ?, ?, ?, ?)`
  );
  const insertMany = database.transaction((rows: HistoryEntry[]) => {
    let added = 0;
    for (const e of rows) {
      const res = stmt.run(
        e.command,
        e.timestamp,
        e.sourceFile,
        e.shell,
        e.timestampApproximate ? 1 : 0
      );
      added += Number(res.changes);
    }
    return added;
  });
  return insertMany(entries);
}

// Phase 2 keyword search: SQLite FTS5 full-text match with BM25 ranking.
// The user query is tokenized to alphanumeric words; each becomes a prefix
// term (`commit*` matches `commit`), joined with AND so multi-word queries
// narrow instead of widen. Tokens are extracted by regex (never interpolated
// raw), so FTS5 operator characters in user input can't break the query.
// Queries with no searchable tokens (e.g. only symbols like "&&") fall back
// to the Phase 1 LIKE match so the tool never returns nothing spuriously.
function buildFtsMatch(query: string): string | null {
  const tokens = query.toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 10)
    .map((t) => `${t}*`)
    .join(" AND ");
}

// Noise filter: drop rows whose command name (first token) is denied.
// We over-fetch from SQLite, then filter + slice, so `limit` still means
// "N usable results" from the caller's perspective.
function applyDenylist(rows: CommandRow[], limit: number): CommandRow[] {
  const denied = new Set(loadConfig().denylist);
  const out: CommandRow[] = [];
  for (const r of rows) {
    if (denied.has(firstToken(r.command))) continue;
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Over-fetch multiplier so post-filter results still fill `limit`.
function fetchSize(wanted: number): number {
  return Math.min(wanted * 3 + 10, 500);
}

export interface SearchOptions {
  limit?: number;
  /**
   * Phase 3: when true, return only rows with a proven exit_code of 0.
   * Rows with unknown outcomes (NULL — all pre-hook history) are excluded,
   * because "unknown" is not "worked". Default false (full recall).
   */
  onlySuccessful?: boolean;
}

// Outcome tier for ranking: proven successes first, unknowns next, proven
// failures last. This is the "boost": gentle and progressive — on a DB with
// no hook data every row is tier 1 and ordering is exactly Phase 2's.
function outcomeTier(alias: string): string {
  return `CASE WHEN ${alias}.exit_code = 0 THEN 0 WHEN ${alias}.exit_code IS NULL THEN 1 ELSE 2 END`;
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
  const wanted = clampLimit(opts.limit, 20);
  const successFilter = opts.onlySuccessful === true;
  const match = buildFtsMatch(trimmed);
  let rows: DbRow[];
  if (match === null) {
    rows = getDb()
      .query(
        `SELECT id, command, timestamp, source_file, shell, is_approximate_timestamp, exit_code
         FROM commands
         WHERE command LIKE '%' || ? || '%' ESCAPE '\\'
           ${successFilter ? "AND exit_code = 0" : ""}
         ORDER BY ${outcomeTier("commands")}, timestamp DESC
         LIMIT ?`
      )
      .all(escapeLike(trimmed), fetchSize(wanted)) as DbRow[];
  } else {
    rows = getDb()
      .query(
        `SELECT c.id, c.command, c.timestamp, c.source_file, c.shell, c.is_approximate_timestamp, c.exit_code
         FROM commands_fts f JOIN commands c ON c.id = f.rowid
         WHERE commands_fts MATCH ?
           ${successFilter ? "AND c.exit_code = 0" : ""}
         ORDER BY ${outcomeTier("c")}, rank
         LIMIT ?`
      )
      .all(match, fetchSize(wanted)) as DbRow[];
  }
  return applyDenylist(rows.map(rowToEntry), wanted);
}

// Most recent commands, no query needed — useful for general context.
// Denylist applies here too (recents full of `ls`/`cd` help nobody).
// Chronological order is kept (no outcome reordering here); exit codes
// show up as annotations via formatRows.
export function getRecentCommands(limit?: number): CommandRow[] {
  const wanted = clampLimit(limit, 10);
  const rows = getDb()
    .query(
      `SELECT id, command, timestamp, source_file, shell, is_approximate_timestamp, exit_code
       FROM commands
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(fetchSize(wanted)) as DbRow[];
  return applyDenylist(rows.map(rowToEntry), wanted);
}

// Phase 3: stamp hook-observed outcomes onto matching history rows.
// Matching is by exact command text; every row with that text gets the
// LATEST observed exit code (the map is already last-wins). Runs in one
// transaction; returns the number of rows updated. Re-running with the
// same log is a true no-op (rows already carrying the value are skipped,
// so the FTS sync triggers don't churn either).
//
// Counting subtlety: the commands_au FTS trigger fires on every UPDATE,
// which inflates sqlite changes() — so we count rows-to-change with a
// SELECT first instead of trusting the UPDATE's change count.
export function applyExitCodes(
  outcomes: Map<string, { exit: number }>
): number {
  if (outcomes.size === 0) return 0;
  const database = getDb();
  const pendingStmt = database.query(
    `SELECT COUNT(*) AS n FROM commands WHERE command = ? AND (exit_code IS NULL OR exit_code != ?)`
  );
  const updateStmt = database.query(
    `UPDATE commands SET exit_code = ? WHERE command = ? AND (exit_code IS NULL OR exit_code != ?)`
  );
  const applyMany = database.transaction(
    (entries: [string, { exit: number }][]): number => {
      let updated = 0;
      for (const [command, outcome] of entries) {
        const pending = (
          pendingStmt.get(command, outcome.exit) as { n: number }
        ).n;
        if (pending > 0) {
          updateStmt.run(outcome.exit, command, outcome.exit);
          updated += pending;
        }
      }
      return updated;
    }
  );
  return applyMany([...outcomes.entries()]);
}

// Format rows for an LLM to read: newest first, with date, shell, provenance.
// Phase 3 adds the outcome signal: [exit 0] worked, [exit N] failed, and no
// marker means unknown (pre-hook history) — unknown is not failure.
export function formatRows(rows: CommandRow[]): string {
  if (rows.length === 0) {
    return "No matching commands found in shell history.";
  }
  return rows
    .map((r, i) => {
      const date = new Date(r.timestamp * 1000).toISOString();
      const approx = r.timestampApproximate ? " (approx. time)" : "";
      const outcome = r.exitCode === null ? "" : ` [exit ${r.exitCode}]`;
      return `${i + 1}. [${date}${approx}] [${r.shell}]${outcome} ${r.command}\n   source: ${r.sourceFile}`;
    })
    .join("\n");
}
