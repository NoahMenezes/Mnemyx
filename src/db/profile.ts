// ---------------------------------------------------------------------------
// Phase 7: per-project usage profile. Read-only rollup over one repo scope:
// how much of your history happened here, whether it worked, when you were
// last active, and which command names dominate. Cheap by design (3 small
// aggregate queries + one bounded command scan) so the tool stays instant.
// ---------------------------------------------------------------------------

import { getDb } from "./connection.ts";
import { normalizeScopeRepo } from "./scope.ts";
import { fencedBox } from "./format.ts";
import { loadConfig, firstToken } from "../config.ts";
import type { ProjectProfile } from "./types.ts";

export type { ProjectProfile } from "./types.ts";

export function getProjectProfile(repoPath: string): ProjectProfile | null {
  const repo = normalizeScopeRepo(repoPath);
  if (repo === null) return null;
  const database = getDb();
  const total = (
    database.query(`SELECT COUNT(*) AS n FROM commands;`).get() as { n: number }
  ).n;
  const agg = database.query(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN exit_code IS NULL THEN 1 ELSE 0 END) AS unk,
            SUM(CASE WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 1 ELSE 0 END) AS fail,
            MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
     FROM commands WHERE repo = ?;`
  ).get(repo) as {
    n: number;
    ok: number | null;
    unk: number | null;
    fail: number | null;
    first_ts: number | null;
    last_ts: number | null;
  };
  const inRepo = agg.n;
  if (inRepo === 0) {
    return {
      repo,
      totalCommands: total,
      inRepo: 0,
      success: 0,
      unknown: 0,
      failed: 0,
      firstTs: null,
      lastTs: null,
      topTokens: [],
    };
  }
  // Top command names: bounded scan (newest 2000 in-repo rows is plenty for
  // a profile), denylist-filtered like search so `ls`/`cd` don't top it.
  const denied = new Set(loadConfig().denylist);
  const rows = database.query(
    `SELECT command FROM commands WHERE repo = ? ORDER BY timestamp DESC LIMIT 2000;`
  ).all(repo) as { command: string }[];
  const counts = new Map<string, number>();
  for (const r of rows) {
    const tok = firstToken(r.command);
    if (!tok || denied.has(tok)) continue;
    counts.set(tok, (counts.get(tok) ?? 0) + 1);
  }
  const topTokens = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([token, count]) => ({ token, count }));
  return {
    repo,
    totalCommands: total,
    inRepo,
    success: agg.ok ?? 0,
    unknown: agg.unk ?? 0,
    failed: agg.fail ?? 0,
    firstTs: agg.first_ts,
    lastTs: agg.last_ts,
    topTokens,
  };
}

export function formatProjectProfile(p: ProjectProfile | null): string {
  if (p === null) {
    return "Pass a repo_path (workspace root / git toplevel) to profile a project.";
  }
  if (p.inRepo === 0) {
    return [
      `profile of ${p.repo}: no indexed commands ran in this repo.`,
      p.totalCommands > 0
        ? `(${p.totalCommands} commands indexed globally — rows without v2 hook context carry unknown repo. Re-run mnemyx init to upgrade the hook.)`
        : `(history is empty — run mnemyx init to index it.)`,
    ].join("\n");
  }
  const share =
    p.totalCommands > 0 ? Math.round((p.inRepo / p.totalCommands) * 100) : 100;
  const first =
    p.firstTs !== null ? new Date(p.firstTs * 1000).toISOString().slice(0, 10) : "?";
  const last =
    p.lastTs !== null ? new Date(p.lastTs * 1000).toISOString().slice(0, 10) : "?";
  const outcomes = fencedBox(
    ["Outcome", { header: "Count", align: "right" }],
    [
      ["✅ succeeded", String(p.success)],
      ["— unknown", String(p.unknown)],
      ["❌ failed", String(p.failed)],
    ]
  );
  const tops =
    p.topTokens.length > 0
      ? fencedBox(
          ["Top command", { header: "Runs", align: "right" }],
          p.topTokens.map((t) => [t.token, String(t.count)])
        )
      : "top commands: (all noise-filtered)";
  return [
    `profile of ${p.repo}: ${p.inRepo} commands (${share}% of ${p.totalCommands} total), active ${first} → ${last}`,
    outcomes,
    tops,
  ].join("\n\n");
}
