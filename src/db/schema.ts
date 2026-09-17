// ---------------------------------------------------------------------------
// Schema + migrations. Called once per open from initDb (connection.ts);
// idempotent by construction (IF NOT EXISTS + column probes), so old DBs
// migrate in place with all rows preserved.
// ---------------------------------------------------------------------------

import type { Database } from "bun:sqlite";

export function ensureSchema(db: Database): void {
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
  // Hook v2: where the command ran. Nullable like exit_code — pre-v2 rows
  // read back as NULL = unknown. Latest observation wins per command text
  // (same last-wins rule as exit codes; a heuristic, documented).
  if (!colNames.includes("cwd")) {
    db.run(`ALTER TABLE commands ADD COLUMN cwd TEXT;`);
  }
  if (!colNames.includes("repo")) {
    db.run(`ALTER TABLE commands ADD COLUMN repo TEXT;`);
  }
  // Phase 8: redacted stderr tail + its normalized fingerprint, for
  // error search. NULL = none captured (older rows, successes).
  if (!colNames.includes("stderr_snippet")) {
    db.run(`ALTER TABLE commands ADD COLUMN stderr_snippet TEXT;`);
  }
  if (!colNames.includes("stderr_fp")) {
    db.run(`ALTER TABLE commands ADD COLUMN stderr_fp TEXT;`);
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
        `SELECT id, exit_code FROM commands WHERE command = ? AND timestamp = ? AND source_file = ? LIMIT 1`
      );
      const carryStmt = db.query(`UPDATE commands SET exit_code = ? WHERE id = ?`);
      const fixStmt = db.query(`UPDATE commands SET command = ? WHERE id = ?`);
      const delStmt = db.query(`DELETE FROM commands WHERE id = ?`);
      const converge = db.transaction(() => {
        for (const r of dirty) {
          const nfc = r.command.normalize("NFC");
          const twin = twinStmt.get(nfc, r.timestamp, r.source_file) as {
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
  // Phase 7: repo-scoped search ("this project first"). The `repo` column
  // already exists (hook v2); this index keeps strict `onlyRepo` filters
  // and boosted scans cheap as history grows.
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commands_repo ON commands(repo);`
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
  // Phase 6: git commits. One row per (repo, hash). files_changed is a
  // JSON array of paths (from `git log --name-only`). No full diffs stored
  // — those are fetched on demand via `git show --stat <hash>`.
  db.run(
    `CREATE TABLE IF NOT EXISTS commits (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       hash TEXT NOT NULL,
       repo_path TEXT NOT NULL,
       message TEXT NOT NULL,
       author_ts INTEGER NOT NULL,
       files_changed TEXT NOT NULL,
       UNIQUE(hash, repo_path)
     );`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commits_repo_ts ON commits(repo_path, author_ts DESC);`
  );
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_commits_ts ON commits(author_ts DESC);`
  );
}
