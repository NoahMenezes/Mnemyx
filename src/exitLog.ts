import { existsSync } from "node:fs";
import { join } from "node:path";
import { requireHome } from "./config.ts";
import { readTailWindow } from "./fsutil.ts";

// ---------------------------------------------------------------------------
// Exit-code log written by the opt-in shell hook (see README + hook.ts).
//
// The hook appends one JSON object per line after every interactive command.
// v1 lines: {"ts": 1720000000, "exit": 0, "cmd": "git push"}
// v2 lines add context: {..., "cwd": "/home/you/proj", "repo": "/home/you/proj"}
// (repo is "" outside a git checkout). v1 lines keep parsing — cwd/repo
// simply read back as null (unknown, like a missing exit code).
//
// A single fixed path on all platforms (next to the Phase 2 config file)
// so one copy-paste hook snippet works on both macOS and Linux. The log's
// absence IS the off switch: no file -> no outcomes -> everything behaves
// exactly as Phase 2 (all exit codes unknown).
// ---------------------------------------------------------------------------

export function getExitLogPath(): string {
  return join(requireHome(), ".mnemyx", "exit-codes.log");
}

// Same unbounded-growth guard as history files: the log is append-only and
// never rotated by the hook, so cap the parse window (tail wins).
export const MAX_EXIT_LOG_BYTES = 8 * 1024 * 1024;

export interface ExitRecord {
  /** Exact command text, as captured by the hook. */
  command: string;
  /** Process exit code (0 = success). */
  exit: number;
  /** Unix epoch seconds, when the command finished. */
  timestamp: number;
  /** Working directory at run time (v2 hook). Null = unknown (v1 lines). */
  cwd: string | null;
  /** Enclosing git repo root (v2 hook). Null = unknown or not a repo. */
  repo: string | null;
}

// Cap absurd path lengths from a hostile/hand-edited log: the value is
// stored per row, so one 10MB cwd must not bloat the DB.
const MAX_CONTEXT_PATH_CHARS = 1024;

function cleanContextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().normalize("NFC");
  if (trimmed === "") return null;
  return trimmed.length > MAX_CONTEXT_PATH_CHARS
    ? trimmed.slice(0, MAX_CONTEXT_PATH_CHARS)
    : trimmed;
}

// Parse the log into command -> LATEST observed outcome. Later lines win:
// a command run five times keeps its most recent exit code. One corrupt
// line never kills the parse (or the server) — it's skipped with a warning.
export function parseExitLog(
  logPath: string = getExitLogPath()
): Map<string, ExitRecord> {
  const outcomes = new Map<string, ExitRecord>();
  if (!existsSync(logPath)) return outcomes;
  const raw = readTailWindow(logPath, MAX_EXIT_LOG_BYTES);
  if (raw === null) {
    console.error(
      `[mnemyx] ignoring unreadable exit-code log at ${logPath}`
    );
    return outcomes;
  }
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as {
        cmd?: unknown;
        exit?: unknown;
        ts?: unknown;
        cwd?: unknown;
        repo?: unknown;
      };
      if (typeof obj.cmd !== "string" || !obj.cmd.trim()) {
        skipped++;
        continue;
      }
      // NFC to match history import normalization (macOS NFD filenames).
      const command = obj.cmd.normalize("NFC");
      if (
        typeof obj.exit !== "number" ||
        !Number.isInteger(obj.exit) ||
        obj.exit < 0 ||
        obj.exit > 255
      ) {
        skipped++;
        continue;
      }
      outcomes.set(command, {
        command,
        exit: obj.exit,
        timestamp:
          typeof obj.ts === "number" && Number.isFinite(obj.ts)
            ? Math.floor(obj.ts)
            : 0,
        cwd: cleanContextPath(obj.cwd),
        repo: cleanContextPath(obj.repo),
      });
    } catch {
      skipped++;
    }
  }
  if (skipped > 0) {
    console.error(
      `[mnemyx] skipped ${skipped} malformed line(s) in ${logPath}`
    );
  }
  return outcomes;
}
