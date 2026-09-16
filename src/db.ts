import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commands_command ON commands(command);`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commands_timestamp ON commands(timestamp DESC);`
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

function clampLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_LIMIT);
}

// Escape LIKE wildcards so a query like "100%" matches literally.
function escapeLike(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function rowToEntry(row: {
  id: number;
  command: string;
  timestamp: number;
  source_file: string;
  shell: string;
  is_approximate_timestamp: number;
}): CommandRow {
  return {
    id: row.id,
    command: row.command,
    timestamp: row.timestamp,
    sourceFile: row.source_file,
    shell: row.shell as SupportedShell,
    timestampApproximate: row.is_approximate_timestamp === 1,
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

// Phase 1 keyword search: case-insensitive substring match via SQL LIKE.
// FTS5 ranking comes in Phase 2; embeddings (if ever) later still.
export function searchCommands(
  query: string,
  limit?: number
): CommandRow[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const rows = getDb()
    .query(
      `SELECT id, command, timestamp, source_file, shell, is_approximate_timestamp
       FROM commands
       WHERE command LIKE '%' || ? || '%' ESCAPE '\\'
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(escapeLike(trimmed), clampLimit(limit, 20)) as {
    id: number;
    command: string;
    timestamp: number;
    source_file: string;
    shell: string;
    is_approximate_timestamp: number;
  }[];
  return rows.map(rowToEntry);
}

// Most recent commands, no query needed — useful for general context.
export function getRecentCommands(limit?: number): CommandRow[] {
  const rows = getDb()
    .query(
      `SELECT id, command, timestamp, source_file, shell, is_approximate_timestamp
       FROM commands
       ORDER BY timestamp DESC
       LIMIT ?`
    )
    .all(clampLimit(limit, 10)) as {
    id: number;
    command: string;
    timestamp: number;
    source_file: string;
    shell: string;
    is_approximate_timestamp: number;
  }[];
  return rows.map(rowToEntry);
}

// Format rows for an LLM to read: newest first, with date, shell, provenance.
export function formatRows(rows: CommandRow[]): string {
  if (rows.length === 0) {
    return "No matching commands found in shell history.";
  }
  return rows
    .map((r, i) => {
      const date = new Date(r.timestamp * 1000).toISOString();
      const approx = r.timestampApproximate ? " (approx. time)" : "";
      return `${i + 1}. [${date}${approx}] [${r.shell}] ${r.command}\n   source: ${r.sourceFile}`;
    })
    .join("\n");
}
