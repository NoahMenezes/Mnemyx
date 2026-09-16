import {
  initDb,
  bulkInsert,
  applyExitCodes,
  type HistoryEntry,
} from "./db.ts";
import { parseAllAvailableHistory } from "./historyParser.ts";
import { parseExitLog } from "./exitLog.ts";
import { loadConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Phase 5: the one import pipeline, shared by the MCP server (index.ts) and
// the setup CLI (cli.ts) so both can never drift apart.
// Steps: open DB (+migrations) -> parse histories -> age filter ->
// bulk insert -> stamp exit codes. All steps idempotent.
// ---------------------------------------------------------------------------

export interface ImportResult {
  /** Entries parsed from history files (post dedupe, pre age-filter). */
  parsed: number;
  /** Entries dropped by maxHistoryAgeDays (0 when unlimited). */
  ageFilteredOut: number;
  /** Rows newly inserted (re-runs insert only genuinely new commands). */
  added: number;
  /** Distinct commands seen in the exit-code log. */
  exitOutcomes: number;
  /** History rows annotated with an exit code this run. */
  exitUpdated: number;
  /** False when config disables exit-code reading (log ignored entirely). */
  exitCodesEnabled: boolean;
}

// Pure + unit-testable: keep entries newer than maxAgeDays (unix seconds).
// null/negative/NaN = no limit. `nowSec` is injectable for tests.
export function filterByMaxAge(
  entries: HistoryEntry[],
  maxAgeDays: number | null,
  nowSec: number = Math.floor(Date.now() / 1000)
): HistoryEntry[] {
  if (
    maxAgeDays === null ||
    !Number.isFinite(maxAgeDays) ||
    maxAgeDays < 0
  ) {
    return entries;
  }
  const cutoff = nowSec - Math.floor(maxAgeDays) * 86400;
  return entries.filter((e) => e.timestamp >= cutoff);
}

export interface ImportOptions {
  /** Override DB path (default: per-user production path). Tests use temp files. */
  dbPath?: string;
  /** Override config path (default: ~/.mnemyx/config.json). */
  configPath?: string;
  /** Override exit-code log path (default: ~/.mnemyx/exit-codes.log). */
  exitLogPath?: string;
  /** Pre-parsed entries, bypassing history-file parsing (tests). */
  entries?: HistoryEntry[];
  /** Injected clock for the age filter (tests). Unix seconds. */
  nowSec?: number;
}

export function runImport(opts: ImportOptions = {}): ImportResult {
  if (opts.dbPath !== undefined) initDb(opts.dbPath);
  else initDb();
  const cfg = loadConfig(opts.configPath);
  const parsed = opts.entries ?? parseAllAvailableHistory();
  const entries = filterByMaxAge(parsed, cfg.maxHistoryAgeDays, opts.nowSec);
  const added = bulkInsert(entries);
  let exitOutcomes = 0;
  let exitUpdated = 0;
  if (cfg.exitCodes) {
    const outcomes = parseExitLog(opts.exitLogPath);
    exitOutcomes = outcomes.size;
    if (exitOutcomes > 0) {
      exitUpdated = applyExitCodes(outcomes);
    }
  }
  return {
    parsed: parsed.length,
    ageFilteredOut: parsed.length - entries.length,
    added,
    exitOutcomes,
    exitUpdated,
    exitCodesEnabled: cfg.exitCodes,
  };
}
