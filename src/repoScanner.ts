// ---------------------------------------------------------------------------
// Phase 6: repo discovery. Finds local git checkouts under configured roots
// (e.g. ~/dev, ~/projects) so later phases can index their commit history.
//
// Design: NO git library, NO network — a directory merely containing a
// `.git` entry (dir for normal clones, file for worktrees/submodules)
// counts as a repo. Bounded by depth + result cap so a mistaken root like
// $HOME can't hang startup. Missing/unreadable roots are skipped with a
// warning, never an error — discovery must never crash the server.
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, normalize } from "node:path";
import { expandRepoRoot, loadConfig, requireHome } from "./config.ts";

/** How deep below each root to descend. Root itself = depth 0. */
export const MAX_SCAN_DEPTH = 3;
/** Hard cap on repos returned (warn + stop when hit). */
export const MAX_REPOS = 200;

// Never descend into these: dependency/build caches (huge, never contain
// repos we want) plus `.git` internals themselves.
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "target",
  "dist",
  "build",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
]);

function safeHome(): string {
  try {
    return requireHome();
  } catch {
    return "";
  }
}

// A repo = a directory with a `.git` entry. Accepts both a `.git`
// DIRECTORY (normal clone) and a `.git` FILE (worktree / submodule,
// whose content points at the real git dir). Anything else (missing,
// unreadable, `.git` absent) is not a repo — never throws.
export function isGitRepo(dir: string): boolean {
  try {
    const st = statSync(dir);
    if (!st.isDirectory()) return false;
    return existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}

export interface DiscoverOptions {
  /** Override scan depth (default MAX_SCAN_DEPTH). Negative = 0. */
  maxDepth?: number;
  /** Override result cap (default MAX_REPOS). */
  maxRepos?: number;
  /** Home dir for `~`/relative expansion (default: requireHome()). */
  home?: string;
}

// Find git repos under `roots`. Pure apart from fs reads + stderr warnings.
// Idempotent, deterministic (sorted output), never throws for bad input:
// blank roots dropped, missing dirs skipped, permission errors logged.
export function discoverRepos(
  roots: string[],
  opts: DiscoverOptions = {}
): string[] {
  const maxDepth = Math.max(
    0,
    Math.floor(opts.maxDepth ?? MAX_SCAN_DEPTH)
  );
  const maxRepos = Math.max(1, Math.floor(opts.maxRepos ?? MAX_REPOS));
  const home = opts.home ?? safeHome();

  // Expand + normalize + dedupe roots up front (overlapping roots like
  // ~/dev and ~/dev/sub would otherwise visit the same tree twice —
  // the visited set below also guards this, but clean input is cheaper).
  const seenRoots = new Set<string>();
  const queue: { path: string; depth: number }[] = [];
  for (const raw of roots) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    let expanded = raw.trim();
    if (home !== "") {
      const e = expandRepoRoot(expanded, home);
      if (e === null) continue;
      expanded = e;
    } else {
      expanded = normalize(expanded);
    }
    if (seenRoots.has(expanded)) continue;
    seenRoots.add(expanded);
    queue.push({ path: expanded, depth: 0 });
  }

  const visited = new Set<string>(seenRoots);
  const found: string[] = [];
  const foundSet = new Set<string>();
  let capped = false;

  const addRepo = (dir: string): boolean => {
    if (foundSet.has(dir)) return true;
    foundSet.add(dir);
    found.push(dir);
    if (found.length >= maxRepos) {
      console.error(
        `[mnemyx] repo discovery hit the ${maxRepos} repo cap — increase via code or narrow repoRoots`
      );
      capped = true;
      return false;
    }
    return true;
  };

  while (queue.length > 0) {
    if (capped) break;
    const cur = queue.shift() as { path: string; depth: number };
    let stat: ReturnType<typeof statSync> | null = null;
    try {
      stat = statSync(cur.path);
    } catch {
      console.error(`[mnemyx] skipping unreadable repo root ${cur.path}`);
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (isGitRepo(cur.path)) {
      if (!addRepo(cur.path)) break;
    }
    if (cur.depth >= maxDepth) continue;
    let entries: Dirent[] | null = null;
    try {
      entries = readdirSync(cur.path, { withFileTypes: true }) as Dirent[];
    } catch {
      console.error(`[mnemyx] skipping unreadable directory ${cur.path}`);
      continue;
    }
    if (entries === null) continue;
    for (const ent of entries) {
      // Skip symlinked dirs: following them risks cycles (a -> b -> a)
      // and escapes the configured tree (e.g. /tmp links to /).
      if (ent.isSymbolicLink()) continue;
      if (!ent.isDirectory()) continue;
      if (SKIP_DIRS.has(ent.name)) continue;
      // Hidden dirs (except the root itself) are caches/config, not
      // project trees — descending into ~/.cache etc. wastes time.
      // A repo whose own name starts with "." is still found when it
      // IS the root or a direct named child? No: to keep the rule
      // simple and predictable, dot-dirs are never descended into,
      // but a dot-dir that is itself a queue item IS tested above.
      if (ent.name.startsWith(".")) continue;
      const child = normalize(join(cur.path, ent.name));
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push({ path: child, depth: cur.depth + 1 });
    }
  }

  found.sort();
  return found;
}

// Convenience: discover using the user's configured repoRoots.
// Thin wrapper so server/CLI share one call path; still never throws
// beyond loadConfig's own (non-throwing) guarantees.
export function discoverReposFromConfig(
  configPath?: string,
  opts: DiscoverOptions = {}
): string[] {
  const cfg =
    configPath !== undefined ? loadConfig(configPath) : loadConfig();
  return discoverRepos(cfg.repoRoots, opts);
}
