import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, normalize } from "node:path";

// ---------------------------------------------------------------------------
// Local config (~/.mnemyx/config.json). Phase 2: denylist. Phase 4:
// embeddings on/off. Phase 5: exit-code reading on/off + max history age.
// Phase 6: repoRoots for git discovery.
//
// The file is OPTIONAL. If missing or unreadable we silently use the
// built-ins. A user `denylist` array EXTENDS the built-ins (union,
// case-insensitive) — it never replaces them, so adding one word can't
// accidentally un-filter everything else.
//
// Example ~/.mnemyx/config.json:
//   {
  //     "denylist": ["vim", "nano", "htop"],
  //     "embeddings": true,
  //     "exitCodes": true,
  //     "maxHistoryAgeDays": 365,
  //     "redactPatterns": ["mycompany-internal-\\d+"],
  //     "repoRoots": ["~/dev", "~/projects"],
  //     "ranking": { "frequencyWeight": 1.0, "recencyHalfLifeDays": 30 },
  //     "plugins": true,
  //     "disabledPlugins": ["example"]
  //   }
// ---------------------------------------------------------------------------

export const DEFAULT_DENYLIST: string[] = [
  // Navigation / inspection noise.
  "ls",
  "cd",
  "pwd",
  "clear",
  "exit",
  "logout",
  "history",
  // Low-signal one-word probes.
  "whoami",
  "hostname",
  "date",
  "cal",
  "who",
  "jobs",
  "fg",
  "bg",
  "reset",
];

export interface MnemyxConfig {
  denylist: string[];
  /** Phase 4: false disables semantic search entirely (pure FTS5). Default true. */
  embeddings: boolean;
  /**
   * Phase 5: false makes the server ignore the exit-code log entirely.
   * Default true. Note this only stops READING — to stop the shell writing
   * the log, remove the hook snippet from your rc file (see README).
   */
  exitCodes: boolean;
  /**
   * Phase 5: only index commands newer than this many days (unix-timestamp
   * cutoff applied at import). null/omitted = no limit (default). Existing
   * DB rows are never deleted — it only filters newly parsed entries.
   */
  maxHistoryAgeDays: number | null;
  /**
   * Step 2: extra secret patterns (JS regex sources) ADDED to the built-in
   * redaction rules, applied to tool output. Invalid patterns warn and are
   * skipped. Defaults to [].
   */
  redactPatterns: string[];
  /**
   * Phase 6: root directories scanned for git repos. REPLACES the defaults
   * (unlike denylist, which extends). `~` expands to $HOME; relative
   * entries resolve under $HOME. Missing/unreadable dirs are skipped at
   * scan time, never an error. Defaults to ~/dev, ~/projects, ~/code,
   * ~/Desktop. Capped at MAX_REPO_ROOTS.
   */
  repoRoots: string[];
  /**
   * Phase 13: learning-to-rank weights. Frequency rewards commands you run
   * often (exact-text runs); recency decays with a half-life in days.
   * Zero weights reproduce the pre-Phase-13 order bit-for-bit.
   */
  ranking: RankingWeights;
  /**
   * Phase 13: false ignores ~/.mnemyx/plugins/ entirely. Default true.
   */
  plugins: boolean;
  /**
   * Phase 13: plugin names (default-export `name`) to skip loading.
   * Defaults to [].
   */
  disabledPlugins: string[];
}

/** Phase 13 ranking weights (see `ranking` above). */
export interface RankingWeights {
  frequencyWeight: number;
  recencyHalfLifeDays: number;
}

/** Built-in ranking weights: gentle blend, ties keep legacy order. */
export const DEFAULT_RANKING: RankingWeights = {
  frequencyWeight: 1.0,
  recencyHalfLifeDays: 30,
};

export function getConfigPath(): string {
  return join(requireHome(), ".mnemyx", "config.json");
}

// Phase 6: where to look for git repos when the user configured nothing.
// Kept as bare names so tests can assert the contract without touching
// ambient HOME; getDefaultRepoRoots() joins them under a home dir.
export const DEFAULT_REPO_ROOT_NAMES: string[] = [
  "dev",
  "projects",
  "code",
  "Desktop",
];

/** Hard cap so a hostile/mistaken config can't queue hundreds of roots. */
export const MAX_REPO_ROOTS = 20;

export function getDefaultRepoRoots(home: string): string[] {
  return DEFAULT_REPO_ROOT_NAMES.map((n) => join(home, n));
}

// Expand one user-supplied root: trim, `~` -> home, relative -> under home.
// Returns null for blank input (caller drops it).
export function expandRepoRoot(input: string, home: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed === "~" || trimmed.startsWith("~/")) {
    return normalize(join(home, trimmed.slice(1)));
  }
  if (isAbsolute(trimmed)) return normalize(trimmed);
  return normalize(join(home, trimmed));
}

// Central home-directory resolution. $HOME wins; otherwise the OS passwd
// entry. Both missing (minimal containers, odd launchd contexts) used to
// surface as a cryptic homedir() throw — sometimes at module import time,
// killing even keyword-only runs. Now it's one actionable error.
// `env`/`systemHome` are injectable so tests never touch ambient state.
export function requireHome(
  env: Record<string, string | undefined> = process.env,
  systemHome: () => string = homedir
): string {
  if (env.HOME !== undefined && env.HOME !== "") return env.HOME;
  try {
    return systemHome();
  } catch {
    throw new Error(
      "mnemyx needs a home directory: $HOME is unset and no OS user entry exists — set HOME to a writable directory and retry"
    );
  }
}

// Read fresh on every call (no cache): the file is tiny, MCP calls are
// infrequent, and this way hand-editing the config never needs a restart.
export function loadConfig(
  configPath: string = getConfigPath()
): MnemyxConfig {
  const denied = new Set(DEFAULT_DENYLIST);
  let embeddings = true;
  let exitCodes = true;
  let maxHistoryAgeDays: number | null = null;
  const redactPatterns: string[] = [];
  let repoRoots: string[] | null = null;
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
        denylist?: unknown;
        embeddings?: unknown;
        exitCodes?: unknown;
        maxHistoryAgeDays?: unknown;
        redactPatterns?: unknown;
        repoRoots?: unknown;
      };
      if (Array.isArray(raw.denylist)) {
        for (const item of raw.denylist) {
          if (typeof item === "string" && item.trim()) {
            denied.add(item.trim().toLowerCase());
          }
        }
      } else if (raw.denylist !== undefined) {
        console.error(
          `[mnemyx] ignoring malformed "denylist" in ${configPath} (expected array of strings)`
        );
      }
      if (typeof raw.embeddings === "boolean") {
        embeddings = raw.embeddings;
      } else if (raw.embeddings !== undefined) {
        console.error(
          `[mnemyx] ignoring malformed "embeddings" in ${configPath} (expected boolean)`
        );
      }
      if (typeof raw.exitCodes === "boolean") {
        exitCodes = raw.exitCodes;
      } else if (raw.exitCodes !== undefined) {
        console.error(
          `[mnemyx] ignoring malformed "exitCodes" in ${configPath} (expected boolean)`
        );
      }
      if (
        typeof raw.maxHistoryAgeDays === "number" &&
        Number.isFinite(raw.maxHistoryAgeDays) &&
        raw.maxHistoryAgeDays >= 0
      ) {
        maxHistoryAgeDays = Math.floor(raw.maxHistoryAgeDays);
      } else if (
        raw.maxHistoryAgeDays !== undefined &&
        raw.maxHistoryAgeDays !== null
      ) {
        console.error(
          `[mnemyx] ignoring malformed "maxHistoryAgeDays" in ${configPath} (expected non-negative number or null)`
        );
      }
      if (Array.isArray(raw.redactPatterns)) {
        for (const item of raw.redactPatterns) {
          if (typeof item === "string" && item) redactPatterns.push(item);
        }
      } else if (raw.redactPatterns !== undefined) {
        console.error(
          `[mnemyx] ignoring malformed "redactPatterns" in ${configPath} (expected array of regex strings)`
        );
      }
      if (Array.isArray(raw.repoRoots)) {
        // REPLACES defaults (unlike denylist). Resolve `~`/relative
        // against HOME now so every downstream caller sees absolute
        // paths. Blank/non-string entries are dropped; over the cap
        // the tail is ignored with a warning, never an error.
        let homeForRoots = "";
        try {
          homeForRoots = requireHome();
        } catch {
          homeForRoots = "";
        }
        const seen = new Set<string>();
        const resolved: string[] = [];
        for (const item of raw.repoRoots) {
          if (typeof item !== "string" || !item.trim()) continue;
          const expanded =
            homeForRoots !== ""
              ? expandRepoRoot(item, homeForRoots)
              : item.trim();
          if (expanded === null || expanded === "") continue;
          if (seen.has(expanded)) continue;
          seen.add(expanded);
          resolved.push(expanded);
          if (resolved.length >= MAX_REPO_ROOTS) break;
        }
        if (resolved.length >= MAX_REPO_ROOTS && raw.repoRoots.length > resolved.length) {
          console.error(
            `[mnemyx] ignoring ${raw.repoRoots.length - resolved.length} repoRoots beyond the ${MAX_REPO_ROOTS} cap in ${configPath}`
          );
        }
        repoRoots = resolved;
      } else if (raw.repoRoots !== undefined && raw.repoRoots !== null) {
        console.error(
          `[mnemyx] ignoring malformed "repoRoots" in ${configPath} (expected array of path strings)`
        );
      }
    } catch (err) {
      console.error(
        `[mnemyx] ignoring unreadable config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (repoRoots === null) {
    try {
      repoRoots = getDefaultRepoRoots(requireHome());
    } catch {
      // No home (minimal containers): no sensible defaults exist.
      // Callers treat [] as "nothing to scan", never a crash.
      repoRoots = [];
    }
  }
  return { denylist: [...denied], embeddings, exitCodes, maxHistoryAgeDays, redactPatterns, repoRoots };
}

// First whitespace-separated token, lowercased — the "command name".
// `ls -la` -> `ls`; `  GIT status` -> `git`. Empty string if blank.
export function firstToken(command: string): string {
  return command.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
}
