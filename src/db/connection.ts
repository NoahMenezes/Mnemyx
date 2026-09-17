// ---------------------------------------------------------------------------
// DB lifecycle: singleton handle, open/migrate/close, busy-retry writes.
// DDL itself lives in schema.ts (ensureSchema); this module owns the
// connection, pragmas, and concurrency helpers.
// ---------------------------------------------------------------------------

import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import { getDefaultDbPath } from "./paths.ts";
import { ensureSchema } from "./schema.ts";

let db: Database | null = null;

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
  // Measured wins on the bench (10k rows: bulk import ~1.5s -> ~0.43s,
  // 3.5x): NORMAL is crash-safe under WAL, bigger page cache + memory temp
  // store cut FTS-trigger write amplification. Re-measure with
  // `mnemyx bench` before touching these.
  db.run("PRAGMA synchronous = NORMAL;");
  db.run("PRAGMA cache_size = -64000;");
  db.run("PRAGMA temp_store = MEMORY;");
  try {
    db.run("PRAGMA journal_mode = WAL;");
  } catch {
    // WAL needs shared-memory files beside the DB — unavailable on some
    // network filesystems. Default rollback-journal mode works fine.
    console.error("[mnemyx] WAL mode unavailable, using default journal mode");
  }
  ensureSchema(db);
  return db;
}

// For tests / explicit close between runs.
export function closeDb(): void {
  db?.close();
  db = null;
}

export function getDb(): Database {
  if (!db) throw new Error("DB not initialized — call initDb() first");
  return db;
}

export const MAX_LIMIT = 100;

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

export function withBusyRetry<T>(fn: () => T): T {
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
