// ---------------------------------------------------------------------------
// Phase 6: git commit storage + queries. Small scale (hundreds per repo),
// so plain LIKE search is fast enough — no FTS table needed. All writes go
// through bulkInsertCommits (INSERT OR IGNORE = idempotent re-index).
// ---------------------------------------------------------------------------

import { getDb, withBusyRetry, clampLimit } from "./connection.ts";
import { MAX_QUERY_LENGTH, escapeLike } from "./scope.ts";
import {
  commitRowToEntry,
  type CommitDbRow,
  type GitCommit,
  type NewCommit,
} from "./types.ts";

// Insert commits idempotently. Returns rows newly added (before/after
// count inside one transaction, same reasoning as bulkInsert).
export function bulkInsertCommits(rows: NewCommit[]): number {
  if (rows.length === 0) return 0;
  const database = getDb();
  const stmt = database.query(
    `INSERT OR IGNORE INTO commits
       (hash, repo_path, message, author_ts, files_changed)
     VALUES (?, ?, ?, ?, ?)`
  );
  const countAll = database.query(`SELECT COUNT(*) AS n FROM commits;`);
  const insertMany = database.transaction((items: NewCommit[]) => {
    const before = (countAll.get() as { n: number }).n;
    for (const c of items) {
      stmt.run(
        c.hash,
        c.repoPath,
        c.message,
        c.authorTs,
        JSON.stringify(c.filesChanged)
      );
    }
    return (countAll.get() as { n: number }).n - before;
  });
  return withBusyRetry(() => insertMany(rows));
}

export function countCommits(): number {
  return (
    getDb().query(`SELECT COUNT(*) AS n FROM commits;`).get() as {
      n: number;
    }
  ).n;
}

// Find commits by full hash or unique prefix (min 7 hex chars). Returns all
// repos' matches, most recent first — callers disambiguate by repoPath.
export function getCommitsByHash(prefix: string): GitCommit[] {
  const p = prefix.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(p)) return [];
  const rows = getDb()
    .query(
      `SELECT id, hash, repo_path, message, author_ts, files_changed
       FROM commits WHERE hash LIKE ? ESCAPE '\\' ORDER BY author_ts DESC LIMIT 10`
    )
    .all(`${escapeLike(p)}%`) as CommitDbRow[];
  return rows.map(commitRowToEntry);
}

// Keyword search over message + file list. LIKE is plenty fast at this
// scale (hundreds–low-thousands of rows) and needs no extra index.
export function searchCommits(query: string, limit?: number): GitCommit[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(
      `query too long (${trimmed.length} chars, max ${MAX_QUERY_LENGTH})`
    );
  }
  const wanted = clampLimit(limit, 20);
  const like = `%${escapeLike(trimmed)}%`;
  const rows = getDb()
    .query(
      `SELECT id, hash, repo_path, message, author_ts, files_changed
       FROM commits
       WHERE message LIKE ? ESCAPE '\\' OR files_changed LIKE ? ESCAPE '\\'
       ORDER BY author_ts DESC LIMIT ?`
    )
    .all(like, like, Math.min(wanted * 2, 200)) as CommitDbRow[];
  return rows.slice(0, wanted).map(commitRowToEntry);
}

export function getRecentCommits(  limit?: number,
  repoPath?: string
): GitCommit[] {
  const wanted = clampLimit(limit, 10);
  const rows =
    repoPath !== undefined && repoPath !== ""
      ? (getDb()
          .query(
            `SELECT id, hash, repo_path, message, author_ts, files_changed
             FROM commits WHERE repo_path = ? ORDER BY author_ts DESC LIMIT ?`
          )
          .all(repoPath, wanted) as CommitDbRow[])
      : (getDb()
          .query(
            `SELECT id, hash, repo_path, message, author_ts, files_changed
             FROM commits ORDER BY author_ts DESC LIMIT ?`
          )
          .all(wanted) as CommitDbRow[]);
  return rows.map(commitRowToEntry);
}

// Commits with author timestamps inside a window — the session-attachment
// primitive (Phase 9). Newest first, capped; repo scoping happens in the
// caller (same-repo-first partition) so this stays a dumb range scan.
export function getCommitsInWindow(
  fromTs: number,
  toTs: number,
  limit = 5
): GitCommit[] {
  const wanted = clampLimit(limit, 5);
  const rows = getDb()
    .query(
      `SELECT id, hash, repo_path, message, author_ts, files_changed
       FROM commits WHERE author_ts >= ? AND author_ts <= ?
       ORDER BY author_ts DESC LIMIT ?`
    )
    .all(Math.floor(fromTs), Math.floor(toTs), wanted) as CommitDbRow[];
  return rows.map(commitRowToEntry);
}
