import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Local config (~/.mnemyx/config.json). Phase 2: denylist. Phase 4:
// embeddings on/off. Phase 5: exit-code reading on/off + max history age.
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
//     "maxHistoryAgeDays": 365
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
}

export function getConfigPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".mnemyx", "config.json");
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
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
        denylist?: unknown;
        embeddings?: unknown;
        exitCodes?: unknown;
        maxHistoryAgeDays?: unknown;
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
    } catch (err) {
      console.error(
        `[mnemyx] ignoring unreadable config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { denylist: [...denied], embeddings, exitCodes, maxHistoryAgeDays };
}

// First whitespace-separated token, lowercased — the "command name".
// `ls -la` -> `ls`; `  GIT status` -> `git`. Empty string if blank.
export function firstToken(command: string): string {
  return command.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
}
