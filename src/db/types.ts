// ---------------------------------------------------------------------------
// Shared vocabulary for the SQLite layer: row interfaces (public camelCase
// forms + raw snake_case DB shapes) and the canonical SELECT column lists.
// Pure — no imports, no DB access — so every module can depend on it.
// ---------------------------------------------------------------------------

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
  /**
   * Hook v2: where the command ran (working directory / enclosing git
   * repo root). NULL = unknown (pre-v2 hook or v1 log lines). Latest
   * observed value per command text — a ranking heuristic, not proof.
   */
  cwd: string | null;
  repo: string | null;
  /**
   * Phase 8: redacted stderr tail of the latest observed FAILURE of this
   * command (NULL when none captured). Redacted BEFORE storage — unlike
   * command text, the raw bytes never reach the DB. Display-masked again
   * on output (defense in depth).
   */
  stderrSnippet: string | null;
  /** Phase 8: normalized fingerprint of stderrSnippet — the match column. */
  stderrFp: string | null;
}

export interface GitCommit {
  id: number;
  hash: string;
  repoPath: string;
  message: string;
  /** Author timestamp, unix seconds. */
  authorTs: number;
  filesChanged: string[];
}

export interface NewCommit {
  hash: string;
  repoPath: string;
  message: string;
  authorTs: number;
  filesChanged: string[];
}

export interface SearchOptions {
  limit?: number;
  /**
   * Phase 3: when true, return only rows with a proven exit_code of 0.
   * Rows with unknown outcomes (NULL — all pre-hook history) are excluded,
   * because "unknown" is not "worked". Default false (full recall).
   */
  onlySuccessful?: boolean;
  /**
   * Phase 7: normalized repo scope ("this project first"). When set,
   * same-repo rows sort first (stable — relevance/recency preserved within
   * each group). Pre-shaped by the caller via normalizeScopeRepo; pass the
   * raw string and it is normalized here too for convenience.
   */
  repo?: string | null;
  /**
   * Phase 7: when true with `repo` set, restrict strictly to that repo
   * instead of boosting. Rows with unknown repo (NULL — pre-hook history)
   * are excluded, like onlySuccessful excludes unknowns. Default false.
   */
  onlyRepo?: boolean;
  /**
   * Phase 13: reference "now" (unix sec) for the recency blend.
   * Injectable for tests; defaults to wall clock.
   */
  nowSec?: number;
  /**
   * Phase 13: override config path for ranking weights (tests pin
   * weights deterministically; production omits it for ambient config).
   */
  configPath?: string;
}

export interface RecentOptions {  limit?: number;
  repo?: string | null;
  onlyRepo?: boolean;
}

export interface ErrorSearchOptions {
  limit?: number;
  repo?: string | null;
  onlyRepo?: boolean;
}

export interface ProjectProfile {
  /** Normalized repo scope as queried. */
  repo: string;
  /** Total commands across the whole DB (denominator for share). */
  totalCommands: number;
  /** Commands in this repo (exact repo match, all history). */
  inRepo: number;
  /** Outcome split within this repo. */
  success: number;
  unknown: number;
  failed: number;
  /** Activity window within this repo (unix seconds, null when empty). */
  firstTs: number | null;
  lastTs: number | null;
  /** Top command names (first token, denylist-filtered), most frequent first. */
  topTokens: { token: string; count: number }[];
}

// Raw row shape as returned by bun:sqlite (snake_case, nullable exit_code).
export interface DbRow {
  id: number;
  command: string;
  timestamp: number;
  source_file: string;
  shell: string;
  is_approximate_timestamp: number;
  exit_code: number | null;
  cwd: string | null;
  repo: string | null;
  stderr_snippet: string | null;
  stderr_fp: string | null;
}

export interface CommitDbRow {
  id: number;
  hash: string;
  repo_path: string;
  message: string;
  author_ts: number;
  files_changed: string;
}

export function rowToEntry(row: DbRow): CommandRow {
  return {
    id: row.id,
    command: row.command,
    timestamp: row.timestamp,
    sourceFile: row.source_file,
    shell: row.shell as SupportedShell,
    timestampApproximate: row.is_approximate_timestamp === 1,
    exitCode: row.exit_code,
    cwd: row.cwd ?? null,
    repo: row.repo ?? null,
    stderrSnippet: row.stderr_snippet ?? null,
    stderrFp: row.stderr_fp ?? null,
  };
}

export function commitRowToEntry(row: CommitDbRow): GitCommit {
  let files: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.files_changed);
    if (Array.isArray(parsed)) {
      files = parsed.filter((x): x is string => typeof x === "string");
    }
  } catch {
    files = [];
  }
  return {
    id: row.id,
    hash: row.hash,
    repoPath: row.repo_path,
    message: row.message,
    authorTs: row.author_ts,
    filesChanged: files,
  };
}

// Canonical SELECT column lists — one definition so the six query sites
// can't drift apart. Unaliased for direct `commands` reads, `c.`-prefixed
// for the FTS join.
export const COMMAND_COLS =
  `id, command, timestamp, source_file, shell, is_approximate_timestamp, exit_code, cwd, repo, stderr_snippet, stderr_fp`;

export const COMMAND_COLS_ALIASED =
  `c.id, c.command, c.timestamp, c.source_file, c.shell, c.is_approximate_timestamp, c.exit_code, c.cwd, c.repo, c.stderr_snippet, c.stderr_fp`;
