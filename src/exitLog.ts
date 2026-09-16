import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Phase 3: exit-code log written by the opt-in shell hook (see README).
//
// The hook appends one JSON object per line after every interactive command:
//   {"ts": 1720000000, "exit": 0, "cmd": "git push"}
//
// A single fixed path on all platforms (next to the Phase 2 config file)
// so one copy-paste hook snippet works on both macOS and Linux. The log's
// absence IS the off switch: no file -> no outcomes -> everything behaves
// exactly as Phase 2 (all exit codes unknown).
// ---------------------------------------------------------------------------

export function getExitLogPath(): string {
  const home = process.env.HOME || homedir();
  return join(home, ".mnemyx", "exit-codes.log");
}

export interface ExitRecord {
  /** Exact command text, as captured by the hook. */
  command: string;
  /** Process exit code (0 = success). */
  exit: number;
  /** Unix epoch seconds, when the command finished. */
  timestamp: number;
}

// Parse the log into command -> LATEST observed outcome. Later lines win:
// a command run five times keeps its most recent exit code. One corrupt
// line never kills the parse (or the server) — it's skipped with a warning.
export function parseExitLog(
  logPath: string = getExitLogPath()
): Map<string, ExitRecord> {
  const outcomes = new Map<string, ExitRecord>();
  if (!existsSync(logPath)) return outcomes;
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (err) {
    console.error(
      `[mnemyx] ignoring unreadable exit-code log at ${logPath}: ${err instanceof Error ? err.message : String(err)}`
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
      };
      if (typeof obj.cmd !== "string" || !obj.cmd.trim()) {
        skipped++;
        continue;
      }
      if (
        typeof obj.exit !== "number" ||
        !Number.isInteger(obj.exit) ||
        obj.exit < 0 ||
        obj.exit > 255
      ) {
        skipped++;
        continue;
      }
      outcomes.set(obj.cmd, {
        command: obj.cmd,
        exit: obj.exit,
        timestamp:
          typeof obj.ts === "number" && Number.isFinite(obj.ts)
            ? Math.floor(obj.ts)
            : 0,
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
