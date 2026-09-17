// ---------------------------------------------------------------------------
// Phase 9: session grouping. Bursts of related commands (+ the commits
// they led to) clustered into one "session" unit.
//
// Design (deliberate, read before touching):
// - Computed ON DEMAND from the commands table on every call — no stored
//   table, no migration, always fresh. New imports just re-cluster.
// - Split rule: a new session starts when the gap between consecutive
//   commands exceeds gapMinutes, OR when the hook-tracked repo changes
//   (both non-null and different). NULL repos (pre-hook rows) never force
//   a split — they inherit the running session, so legacy history still
//   clusters instead of fragmenting.
// - Grouping sees ALL commands (no denylist): dropping `ls`/`cd` first
//   would merge sessions across gaps containing only noise. Display
//   filters noise instead (counts/top-tokens skip denied names).
// - Session ids are content-derived (`s<startTs>-<slug>`), deterministic
//   for the same DB state. New imports can shift them — get_session says
//   so instead of pretending permanence.
// - Commands display oldest→newest inside a session (it reads like a
//   story); sessions list newest-first.
// ---------------------------------------------------------------------------

import {
  getCommandTimeline,
  getCommitsInWindow,
  normalizeScopeRepo,
  formatRows,
  formatCommits,
  fencedBox,
  shortDateTime,
  formatDuration,
  type CommandRow,
  type GitCommit,
} from "./db.ts";
import { loadConfig, firstToken } from "./config.ts";

/** Default inactivity gap that splits sessions. */
export const DEFAULT_SESSION_GAP_MIN = 30;
export const MIN_SESSION_GAP_MIN = 1;
export const MAX_SESSION_GAP_MIN = 180;
/** How many recent commands the clustering scan reads (bounded input). */
export const MAX_SESSION_SCAN = 2000;
/** Commits attached per session (same-repo first). */
export const MAX_SESSION_COMMITS = 5;

export function clampGapMinutes(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SESSION_GAP_MIN;
  return Math.min(
    MAX_SESSION_GAP_MIN,
    Math.max(MIN_SESSION_GAP_MIN, Math.floor(n))
  );
}

export interface Session {
  /** Content-derived id: `s<startTs>-<slug>` (slug = repo basename or global). */
  id: string;
  startTs: number;
  endTs: number;
  /** Dominant repo (first non-null seen); null when nothing was tracked. */
  repo: string | null;
  /** True when >1 distinct tracked repo appears (label renders "mixed"). */
  mixed: boolean;
  /** Commands oldest→newest (story order). */
  commands: CommandRow[];
  /** Indexed commits in [startTs, endTs], same-repo first, capped. */
  commits: GitCommit[];
  success: number;
  failed: number;
  unknown: number;
  topTokens: { token: string; count: number }[];
}

export interface ClusterOptions {
  /** Newest-N commands to scan (default 500, max 2000). */
  scanLimit?: number;
  /** Inactivity gap in minutes (default 30, clamped 1–180). */
  gapMinutes?: number;
  /** Repo scope: strict filter (onlyRepo) or session-level boost. */
  repo?: string | null;
  onlyRepo?: boolean;
  /** Only sessions ending within the last N days (max 90). */
  sinceDays?: number;
  /** Reference "now" (unix sec) for sinceDays — injectable for tests. */
  nowSec?: number;
}

function slugFor(repo: string | null): string {
  if (repo === null) return "global";
  const base = repo.split("/").pop() ?? "repo";
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "repo" : slug;
}

function sessionId(startTs: number, repo: string | null): string {
  return `s${Math.floor(startTs)}-${slugFor(repo)}`;
}

function topTokensFor(commands: CommandRow[], n = 5): { token: string; count: number }[] {
  const denied = new Set(loadConfig().denylist);
  const counts = new Map<string, number>();
  for (const c of commands) {
    const tok = firstToken(c.command);
    if (!tok || denied.has(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([token, count]) => ({ token, count }));
}

function finishSession(group: CommandRow[]): Session {
  const ordered = [...group].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const first = ordered[0] as CommandRow;
  const last = ordered[ordered.length - 1] as CommandRow;
  const repos = [...new Set(ordered.map((c) => c.repo).filter((r): r is string => r !== null))];
  const repo = repos[0] ?? null;
  const mixed = repos.length > 1;
  let success = 0;
  let failed = 0;
  let unknown = 0;
  for (const c of ordered) {
    if (c.exitCode === 0) success++;
    else if (c.exitCode === null) unknown++;
    else failed++;
  }
  // Commits in the window, same-repo first when the session has one repo.
  const inWindow = getCommitsInWindow(first.timestamp, last.timestamp, MAX_SESSION_COMMITS * 2);
  const orderedCommits =
    mixed || repo === null
      ? inWindow
      : [
          ...inWindow.filter((c) => c.repoPath === repo),
          ...inWindow.filter((c) => c.repoPath !== repo),
        ];
  const commits = orderedCommits.slice(0, MAX_SESSION_COMMITS);
  return {
    id: sessionId(first.timestamp, repo),
    startTs: first.timestamp,
    endTs: last.timestamp,
    repo,
    mixed,
    commands: ordered,
    commits,
    success,
    failed,
    unknown,
    topTokens: topTokensFor(ordered),
  };
}

// Cluster recent commands into sessions, newest session first.
export function clusterSessions(opts: ClusterOptions = {}): Session[] {
  const gapSec = clampGapMinutes(opts.gapMinutes ?? DEFAULT_SESSION_GAP_MIN) * 60;
  const scan = Number.isFinite(opts.scanLimit)
    ? Math.min(MAX_SESSION_SCAN, Math.max(1, Math.floor(opts.scanLimit as number)))
    : 500;
  const scopeRepo = normalizeScopeRepo(opts.repo ?? null);
  const strictRepo = opts.onlyRepo === true && scopeRepo !== null;
  const sinceDays =
    opts.sinceDays === undefined
      ? null
      : Math.min(90, Math.max(1, Math.floor(opts.sinceDays)));
  const nowSec =
    opts.nowSec !== undefined && Number.isFinite(opts.nowSec)
      ? Math.floor(opts.nowSec)
      : Math.floor(Date.now() / 1000);

  let timeline = getCommandTimeline(scan);
  if (strictRepo && scopeRepo !== null) {
    timeline = timeline.filter((c) => c.repo === scopeRepo);
  }
  if (sinceDays !== null) {
    const cutoff = nowSec - sinceDays * 86400;
    timeline = timeline.filter((c) => c.timestamp >= cutoff);
  }
  // Oldest→newest walk (timeline arrives newest-first).
  const chrono = [...timeline].sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
  const sessions: Session[] = [];
  let group: CommandRow[] = [];
  let prev: CommandRow | null = null;
  const flush = (): void => {
    if (group.length > 0) {
      sessions.push(finishSession(group));
      group = [];
    }
  };
  for (const cur of chrono) {
    if (prev !== null) {
      const gapSplit = cur.timestamp - prev.timestamp > gapSec;
      const repoSplit =
        prev.repo !== null &&
        cur.repo !== null &&
        prev.repo !== cur.repo;
      if (gapSplit || repoSplit) flush();
    }
    group.push(cur);
    prev = cur;
  }
  flush();
  // Newest session first. Boost-only scope: sessions in this repo first
  // (stable — recency kept within each group).
  sessions.sort((a, b) => b.startTs - a.startTs || b.endTs - a.endTs);
  if (!strictRepo && scopeRepo !== null) {
    const same = sessions.filter((s) => !s.mixed && s.repo === scopeRepo);
    const rest = sessions.filter((s) => s.mixed || s.repo !== scopeRepo);
    return [...same, ...rest];
  }
  return sessions;
}

// Re-cluster and find one session by id. Null = unknown (ids shift as new
// commands land — callers refresh via list_sessions).
export function getSession(id: string, opts: ClusterOptions = {}): Session | null {
  const want = (id ?? "").trim();
  if (want === "") return null;
  return clusterSessions(opts).find((s) => s.id === want) ?? null;
}

function repoLabel(s: Session): string {
  if (s.repo === null) return "—";
  const base = s.repo.split("/").pop() ?? s.repo;
  return s.mixed ? `mixed (${base}+)` : base;
}

function whenRange(s: Session): string {
  const a = shortDateTime(s.startTs);
  const sameDay =
    new Date(s.startTs * 1000).toISOString().slice(0, 10) ===
    new Date(s.endTs * 1000).toISOString().slice(0, 10);
  const b = sameDay
    ? new Date(s.endTs * 1000).toISOString().slice(11, 16)
    : shortDateTime(s.endTs);
  return `${a}→${b}`;
}

// All sessions as one markdown table — the neat overview.
export function formatSessions(sessions: Session[]): string {
  if (sessions.length === 0) {
    return "No sessions found in scope (empty history, or nothing recent matches).";
  }
  return fencedBox(
    ["Session", "When", "Dur", "Repo", { header: "Cmds", align: "right" }, "ok/fail/?", "Commits", "Top"],
    sessions.map((s) => [
      s.id,
      whenRange(s),
      formatDuration(s.endTs - s.startTs),
      repoLabel(s),
      String(s.commands.length),
      `${s.success}/${s.failed}/${s.unknown}`,
      s.commits.length > 0
        ? s.commits.map((c) => c.hash.slice(0, 7)).join(", ")
        : "—",
      s.topTokens.length > 0
        ? s.topTokens.slice(0, 3).map((t) => t.token).join(", ")
        : "—",
    ])
  );
}

// One session in full: property table + commands (story order) + commits.
export function formatSession(s: Session | null): string {
  if (s === null) {
    return "Unknown session — ids shift as new commands land. Call list_sessions for fresh ids.";
  }
  const repoShown = s.repo ?? (s.mixed ? "mixed" : "unknown (no hook context)");
  const head = [
    `## Session \`${s.id}\``,
    fencedBox(["Field", "Value"], [
      ["repo", repoShown],
      ["window", `${whenRange(s)} (${formatDuration(s.endTs - s.startTs)})`],
      ["commands", String(s.commands.length)],
      ["outcomes", `${s.success} ok · ${s.failed} failed · ${s.unknown} unknown`],
      ["commits", s.commits.length > 0 ? s.commits.map((c) => c.hash.slice(0, 7)).join(", ") : "none in window"],
    ]),
  ].join("\n");
  const cmds =
    s.commands.length > 0
      ? `### Commands (${s.commands.length}, oldest first)\n${formatRows(s.commands)}`
      : "### Commands\nnone.";
  const commits =
    s.commits.length > 0
      ? `### Commits (${s.commits.length})\n${formatCommits(s.commits)}`
      : "### Commits\nnone in this window.";
  return `${head}\n\n${cmds}\n\n${commits}`;
}
