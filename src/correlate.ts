// ---------------------------------------------------------------------------
// Phase 6: correlate shell history with git commits. Two primitives:
//
// 1. Time-window: commands run shortly BEFORE a commit plausibly led to it.
//    No cwd is tracked yet (zsh/bash history has none), so this is
//    time-only — every story says so explicitly instead of implying a
//    stronger link than exists. Hook v2 (step 5-7) will add cwd.
// 2. Blame: `git blame` finds which commit last touched a line, then the
//    commit + its story explain WHY the line exists.
//
// All helpers are synchronous reads (SQLite + one git spawn for blame).
// Nothing here writes.
// ---------------------------------------------------------------------------

import {
  getCommandsInWindow,
  getCommitsByHash,
  formatRows,
  sanitizeForDisplay,
  type CommandRow,
  type GitCommit,
} from "./db.ts";
import { blameLine, getDiffStat } from "./gitIndexer.ts";

/** Default lookback: commands up to 30 min before the commit count. */
export const DEFAULT_STORY_WINDOW_MIN = 30;
/** Hard bounds so a wild argument can't scan the whole DB. */
export const MIN_STORY_WINDOW_MIN = 1;
export const MAX_STORY_WINDOW_MIN = 180;

export function clampWindowMinutes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_STORY_WINDOW_MIN;
  return Math.min(
    MAX_STORY_WINDOW_MIN,
    Math.max(MIN_STORY_WINDOW_MIN, Math.floor(n))
  );
}

// Commands plausibly leading to `commit`: everything in
// [authorTs - window, authorTs], newest first, noise-filtered.
// Same-repo commands (hook v2 `repo` match) sort first — stable, so
// recency is kept within each group. Rows with unknown repo stay in
// the time-only group; the story labels which group is which.
export function getCommandsNearCommit(
  commit: GitCommit,
  windowMinutes: number = DEFAULT_STORY_WINDOW_MIN,
  limit = 10
): CommandRow[] {
  const window = clampWindowMinutes(windowMinutes);
  const rows = getCommandsInWindow(
    commit.authorTs - window * 60,
    commit.authorTs,
    limit * 3
  );
  const same: CommandRow[] = [];
  const rest: CommandRow[] = [];
  for (const r of rows) {
    if (r.repo !== null && r.repo === commit.repoPath) same.push(r);
    else rest.push(r);
  }
  return [...same, ...rest].slice(0, Math.max(Math.floor(limit), 1));
}

// Resolve a full hash or unique short prefix to its most recent commit.
// Null = bad format or unknown (stale index — caller suggests reindex).
export function resolveCommit(hashPrefix: string): GitCommit | null {
  const hits = getCommitsByHash(hashPrefix);
  return hits[0] ?? null;
}

// Format one commit + its story for an LLM: three labelled sections so
// the reader can tell stored fact (message/files) apart from heuristic
// (time-window commands) apart from on-demand git output (diff stat).
export function formatCommitStory(
  commit: GitCommit,
  commands: CommandRow[],
  diffStat: string | null
): string {
  const date = new Date(commit.authorTs * 1000).toISOString();
  const files =
    commit.filesChanged.length > 0
      ? commit.filesChanged.join(", ")
      : "(file list unavailable)";
  const head = [
    `commit ${commit.hash.slice(0, 7)} (${commit.hash})`,
    `repo: ${commit.repoPath}`,
    `date: ${date}`,
    `message: ${sanitizeForDisplay(commit.message)}`,
    `files: ${sanitizeForDisplay(files)}`,
  ].join("\n");
  const stat = diffStat !== null ? `\n\nDiff stat:\n${sanitizeForDisplay(diffStat)}` : "";
  if (commands.length === 0) {
    return `${head}${stat}\n\nWhat I ran around then: no indexed commands in that window.`;
  }
  const repoMatched = commands.some((c) => c.repo !== null && c.repo === commit.repoPath);
  const caveat = repoMatched
    ? "top entries ran in this repo (hook-tracked), rest are time-only"
    : "time-only match (no repo-tracked commands yet — upgrade the shell hook)";
  return (
    `${head}${stat}` +
    `\n\nWhat I ran around then (${caveat}):\n${formatRows(commands)}`
  );
}

export interface LineExplanation {
  /** Hash blamed by git (null when blame itself failed). */
  blamedHash: string | null;
  /** Indexed commit record (null when index is stale/missing it). */
  commit: GitCommit | null;
}

// Blame one line, then look the commit up in the index. The blame hash
// and the stored record are returned separately on purpose: when the
// index is stale the hash is still useful (caller prints "reindex to
// learn more" instead of "not found").
export function explainLine(
  repoPath: string,
  filePath: string,
  line: number
): LineExplanation {
  const blamedHash = blameLine(repoPath, filePath, line);
  if (blamedHash === null) return { blamedHash: null, commit: null };
  const hits = getCommitsByHash(blamedHash);
  const inRepo = hits.find((c) => c.repoPath === repoPath) ?? hits[0] ?? null;
  return { blamedHash, commit: inRepo };
}
