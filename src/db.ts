import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { loadConfig, firstToken, requireHome } from "./config.ts";
import { redactSecrets, REDACTED } from "./redact.ts";

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
// Pure helper (platform/home/xdg injected) so every branch — including
// macOS paths — is unit-testable on any machine.
export function dbPathFor(
  platform: string,
  home: string,
  xdgDataHome: string | undefined
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "mnemyx", "mnemyx.db");
  }
  // Linux (and fallback): XDG data home. macOS/Linux only.
  const dataHome = xdgDataHome || join(home, ".local", "share");
  return join(dataHome, "mnemyx", "mnemyx.db");
}

export function getDefaultDbPath(): string {
  return dbPathFor(process.platform, requireHome(), process.env.XDG_DATA_HOME);
}

// Open (creating parent dirs) and migrate the DB. Idempotent.
export function initDb(dbPath: string = getDefaultDbPath()): Database {
  if (db) return db;
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const fresh = !existsSync(dbPath);
  db = new Database(dbPath, { create: true });
  // History data is sensitive (may contain pasted secrets): restrict a
  // newly created DB file to the owner. Pre-existing files keep their perms.
  if (fresh) {
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Non-fatal (exotic filesystems); the DB works regardless.
    }
  }
  // Concurrent writers (server + `mnemyx init` at once) wait instead of
  // throwing SQLITE_BUSY immediately.
  db.run("PRAGMA busy_timeout = 5000;");
  try {
    db.run("PRAGMA journal_mode = WAL;");
  } catch {
    // WAL needs shared-memory files beside the DB — unavailable on some
    // network filesystems. Default rollback-journal mode works fine.
    console.error("[mnemyx] WAL mode unavailable, using default journal mode");
  }
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
  // One-time NFC convergence for rows imported before storage normalization:
  // without it, re-imports would INSERT OR IGNORE-miss (NFC text differs
  // from the stored NFD twin) and duplicate those rows. Rows whose NFC twin
  // already exists are dropped (carrying a proven exit code over first);
  // the rest are updated in place. No-op on already-clean DBs.
  {
    const rows = db
      .query(`SELECT id, command, timestamp, source_file, exit_code FROM commands;`)
      .all() as {
      id: number;
      command: string;
      timestamp: number;
      source_file: string;
      exit_code: number | null;
    }[];
    const dirty = rows.filter((r) => r.command !== r.command.normalize("NFC"));
    if (dirty.length > 0) {
      const twinStmt = db.query(
        `SELECT id, exit_code FROM commands WHERE command = ? AND timestamp = ? AND source_file = ? AND id != ? LIMIT 1`
      );
      const carryStmt = db.query(`UPDATE commands SET exit_code = ? WHERE id = ?`);
      const fixStmt = db.query(`UPDATE commands SET command = ? WHERE id = ?`);
      const delStmt = db.query(`DELETE FROM commands WHERE id = ?`);
      const converge = db.transaction(() => {
        for (const r of dirty) {
          const nfc = r.command.normalize("NFC");
          const twin = twinStmt.get(nfc, r.timestamp, r.sourceFile) as {
            id: number;
            exit_code: number | null;
          } | null;
          // NOTE: twin lookup omits the id exclusion (a twin IS another row
          // by definition here since r.command itself is non-NFC).
          if (twin) {
            if (twin.exit_code === null && r.exit_code !== null) {
              carryStmt.run(r.exit_code, twin.id);
            }
            delStmt.run(r.id);
          } else {
            fixStmt.run(nfc, r.id);
          }
        }
      });
      converge();
      console.error(`[mnemyx] normalized ${dirty.length} pre-existing rows to NFC`);
    }
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
  // Phase 4: one vector per command. Plain table (no extension needed —
  // ~2000 rows brute-force in JS in milliseconds). command_id references
  // commands(id); the model tag lets a future model/dtype swap prune and
  // re-embed without a migration.
  db.run(
    `CREATE TABLE IF NOT EXISTS command_embeddings (
       command_id INTEGER PRIMARY KEY,
       embedding BLOB NOT NULL,
       model TEXT NOT NULL,
       dims INTEGER NOT NULL
     );`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_embeddings_model ON command_embeddings(model);`
  );
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

// Concurrent writers (server + `mnemyx init` racing an import) collide on
// SQLite locks. busy_timeout covers plain SQLITE_BUSY, but NOT
// SQLITE_BUSY_SNAPSHOT: a transaction that READs (our before-count) and
// then writes while another connection holds RESERVED fails immediately
// without invoking the busy handler. So every write transaction also
// retries a few times with backoff — each attempt gets a fresh snapshot.
const BUSY_RETRIES = 10;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withBusyRetry<T>(fn: () => T): T {
  let last: unknown = new Error("withBusyRetry: unreachable");
  for (let i = 0; i < BUSY_RETRIES; i++) {
    try {
      return fn();
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code !== "SQLITE_BUSY" || i === BUSY_RETRIES - 1) throw err;
      last = err;
      sleepSync(50 * (i + 1));
    }
  }
  throw last;
}

export function clampLimit(limit: number | undefined, fallback: number): number {
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

// Phase 2 keyword search: SQLite FTS5 full-text match with BM25 ranking.
// The user query is tokenized to alphanumeric words; each becomes a prefix
// term (`commit*` matches `commit`), joined with AND so multi-word queries
// narrow instead of widen. Tokens are extracted by regex (never interpolated
// raw), so FTS5 operator characters in user input can't break the query.
// Queries with no searchable tokens (e.g. only symbols like "&&") fall back
// to the Phase 1 LIKE match so the tool never returns nothing spuriously.
function buildFtsMatch(query: string): string | null {
  // NFC for the same reason history import normalizes (macOS NFD text).
  const tokens = query.normalize("NFC").toLowerCase().match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 10)
    .map((t) => `${t}*`)
    .join(" AND ");
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
  return withBusyRetry(() => applyMany([...outcomes.entries()]));
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

// Format rows for an LLM to read, in the caller's relevance order, with
// date, shell, and provenance.
// Phase 3 adds the outcome signal: [exit 0] worked, [exit N] failed, and no
// marker means unknown (pre-hook history) — unknown is not failure.
// Step 2 redacts secrets on output (store raw, display masked): masked hits
// carry a [redacted] tag so the reader knows something was hidden.
export function formatRows(rows: CommandRow[]): string {
  if (rows.length === 0) {
    return "No matching commands found in shell history.";
  }
  const extraPatterns = loadConfig().redactPatterns;
  return rows
    .map((r, i) => {
      const date = new Date(r.timestamp * 1000).toISOString();
      const approx = r.timestampApproximate ? " (approx. time)" : "";
      const outcome = r.exitCode === null ? "" : ` [exit ${r.exitCode}]`;
      const redacted = redactSecrets(r.command, extraPatterns);
      const marker = redacted.redacted ? ` ${REDACTED}` : "";
      return `${i + 1}. [${date}${approx}] [${r.shell}]${outcome}${marker} ${redacted.text}\n   source: ${r.sourceFile}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Phase 4: vector storage. Float32 little-endian BLOBs; unit-length vectors
// (cosine similarity = dot product). All helpers take the model tag so a
// future model/dtype swap is just "new tag -> old rows look missing".
// ---------------------------------------------------------------------------

function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function decodeVector(blob: Buffer, dims: number): Float32Array {
  return Float32Array.from(
    new Float32Array(
      blob.buffer,
      blob.byteOffset,
      Math.floor(blob.byteLength / 4)
    ).subarray(0, dims)
  );
}

// Drop vectors from any other model tag (upgrade path: re-embed follows).
export function pruneStaleEmbeddings(model: string): number {
  const res = getDb()
    .query(`DELETE FROM command_embeddings WHERE model != ?`)
    .run(model);
  return Number(res.changes);
}

export function countEmbeddings(model: string): number {
  return (
    getDb()
      .query(`SELECT COUNT(*) AS n FROM command_embeddings WHERE model = ?`)
      .get(model) as { n: number }
  ).n;
}

// History rows with no current-model vector yet (backfill source).
// Keyset-paginated by id: pass back the max id seen to advance. (LIMIT
// alone can't skip rows — e.g. denylisted noise the caller declines to
// store would pin the cursor forever.)
export function getCommandsMissingEmbeddings(
  model: string,
  limit: number,
  afterId = 0
): { id: number; command: string }[] {
  return getDb()
    .query(
      `SELECT c.id, c.command FROM commands c
       WHERE c.id > ? AND NOT EXISTS (
         SELECT 1 FROM command_embeddings e
         WHERE e.command_id = c.id AND e.model = ?
       )
       ORDER BY c.id
       LIMIT ?`
    )
    .all(afterId, model, Math.max(Math.floor(limit), 1)) as {
    id: number;
    command: string;
  }[];
}

export function storeEmbeddings(
  ids: number[],
  vectors: Float32Array[],
  model: string,
  dims: number
): void {
  if (ids.length === 0) return;
  if (ids.length !== vectors.length) {
    throw new Error(
      `storeEmbeddings: ${ids.length} ids vs ${vectors.length} vectors`
    );
  }
  const database = getDb();
  const stmt = database.query(
    `INSERT OR REPLACE INTO command_embeddings (command_id, embedding, model, dims)
     VALUES (?, ?, ?, ?)`
  );
  const storeMany = database.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const vec = vectors[i];
      if (id === undefined || !vec || vec.length !== dims) {
        throw new Error(
          `storeEmbeddings: bad entry at index ${i} (want id + ${dims} dims)`
        );
      }
      stmt.run(id, encodeVector(vec), model, dims);
    }
  });
  withBusyRetry(() => storeMany());
}

// All stored vectors (+ optional proven-success pre-filter so top-k isn't
// wasted on rows an onlySuccessful query would discard anyway).
export function getEmbeddingCandidates(
  model: string,
  onlySuccessful: boolean
): { id: number; embedding: Float32Array }[] {
  const rows = (
    onlySuccessful
      ? getDb().query(
          `SELECT e.command_id AS id, e.embedding, e.dims FROM command_embeddings e
           JOIN commands c ON c.id = e.command_id
           WHERE e.model = ? AND c.exit_code = 0`
        )
      : getDb().query(
          `SELECT e.command_id AS id, e.embedding, e.dims FROM command_embeddings e
           WHERE e.model = ?`
        )
  ).all(model) as { id: number; embedding: Buffer; dims: number }[];
  return rows.map((r) => ({
    id: r.id,
    embedding: decodeVector(r.embedding, r.dims),
  }));
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
        `SELECT id, command, timestamp, source_file, shell, is_approximate_timestamp, exit_code
         FROM commands WHERE id IN (${placeholders})`
      )
      .all(...chunk) as DbRow[];
    out.push(...rows.map(rowToEntry));
  }
  return out;
}
