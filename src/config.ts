import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Local config. Phase 2: noise denylist. Phase 4: embeddings on/off.
// (Phase 5 will grow this file with more keys — the path stays the same.)
//
// The file is OPTIONAL. If missing or unreadable we silently use the
// built-ins. A user `denylist` array EXTENDS the built-ins (union,
// case-insensitive) — it never replaces them, so adding one word can't
// accidentally un-filter everything else.
//
// Example ~/.mnemyx/config.json:
//   { "denylist": ["vim", "nano", "htop"], "embeddings": false }
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
  if (existsSync(configPath)) {
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
        denylist?: unknown;
        embeddings?: unknown;
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
    } catch (err) {
      console.error(
        `[mnemyx] ignoring unreadable config at ${configPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { denylist: [...denied], embeddings };
}

// First whitespace-separated token, lowercased — the "command name".
// `ls -la` -> `ls`; `  GIT status` -> `git`. Empty string if blank.
export function firstToken(command: string): string {
  return command.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
}
