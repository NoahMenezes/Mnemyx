// ---------------------------------------------------------------------------
// LLM-facing text rendering: command rows, commit rows. The single choke
// point where secrets get masked and hostile terminal sequences stripped
// before anything reaches an AI client or terminal UI.
//
// Rendering rule (all tools): GitHub-flavored markdown tables for lists,
// fenced blocks for preformatted git output. Tables render in every major
// coding agent; fences preserve graphs/diffs byte-for-byte.
// ---------------------------------------------------------------------------

import type { CommandRow, GitCommit } from "./types.ts";
import { loadConfig } from "../config.ts";
import { redactSecrets, REDACTED } from "../redact.ts";

// Hardening: tool output flows straight into LLM prompts AND terminal UIs,
// so command text is sanitized (ANSI escapes/control chars stripped — a
// history line could otherwise inject terminal sequences or prompt text)
// and truncated (a single pathological entry can't blow up context).
export const MAX_COMMAND_DISPLAY_LENGTH = 2000;

/** Cell width for command text inside tables (full text stays searchable). */
export const TABLE_COMMAND_WIDTH = 300;
/** Defensive row cap: callers cap already, the helper never emits more. */
export const MAX_TABLE_ROWS = 100;

export function sanitizeForDisplay(text: string): string {
  // Strip ANSI escape sequences (CSI … letter, OSC … BEL, stray ESC),
  // then all control chars except newline/tab (multiline commands keep
  // their real line breaks).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the entire purpose of this function
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\x1b/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export interface TableColumn {
  header: string;
  /** Numeric columns align right, everything else left. Default left. */
  align?: "left" | "right";
  /** Truncate cells past this width with …. Default: no cap. */
  maxWidth?: number;
}

/**
 * One table cell of already display-ready text (sanitized + redacted by
 * the caller): collapses newlines to ↵ (a table row must stay one line),
 * escapes pipes (commands contain them constantly), squeezes whitespace,
 * and truncates past maxWidth. Exported for tests.
 */
export function mdCell(text: string, maxWidth?: number): string {
  let out = text.replace(/\s*\n\s*/g, " ↵ ").replace(/\|/g, "\\|");
  out = out.replace(/[ \t]+/g, " ").trim();
  if (maxWidth !== undefined && maxWidth > 0 && out.length > maxWidth) {
    out = out.slice(0, Math.max(0, maxWidth - 1)) + "…";
  }
  return out;
}

/**
 * GitHub-flavored markdown table. The shared builder every tool uses, so
 * all tabular output escapes, truncates, and caps identically. Rows past
 * MAX_TABLE_ROWS are cut with a trailing "… and N more" line (outside the
 * table, so it never breaks column counts).
 */
export function mdTable(
  headers: (string | TableColumn)[],
  rows: string[][]
): string {
  const cols: TableColumn[] = headers.map((h) =>
    typeof h === "string" ? { header: h } : h
  );
  const head = `| ${cols.map((c) => c.header).join(" | ")} |`;
  const sep = `| ${cols.map((c) => (c.align === "right" ? "---:" : "---")).join(" | ")} |`;
  const capped = rows.slice(0, MAX_TABLE_ROWS);
  const body = capped.map((r) => {
    const cells = cols.map((c, i) => mdCell(r[i] ?? "", c.maxWidth));
    return `| ${cells.join(" | ")} |`;
  });
  const out = [head, sep, ...body].join("\n");
  if (rows.length > capped.length) {
    return `${out}\n… and ${rows.length - capped.length} more rows`;
  }
  return out;
}

/** Compact exit badge: ✅ 0 / ❌ N / — (unknown, never implies failure). */
export function exitBadge(exitCode: number | null): string {
  if (exitCode === null) return "—";
  return exitCode === 0 ? "✅ 0" : `❌ ${exitCode}`;
}

/** Short UTC stamp for table cells: "09-16 14:22" ( "~" suffix = approx). */
export function shortDateTime(ts: number, approx = false): string {
  const s = new Date(ts * 1000).toISOString().slice(5, 16).replace("T", " ");
  return approx ? `${s}~` : s;
}

/** Short UTC day for table cells: "2026-09-16". */
export function shortDay(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Compact duration: "45s" / "39m" / "2h05m". */
export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

// Format rows for an LLM to read, in the caller's relevance order, with
// date, shell, and outcome — one table row per command (multiline commands
// collapse newlines to ↵ so the row survives).
// Phase 3 adds the outcome signal: ✅ worked, ❌ failed, — unknown
// (pre-hook history) — unknown is not failure.
// Step 2 redacts secrets on output (store raw, display masked): masked hits
// carry a [redacted] tag so the reader knows something was hidden.
export function formatRows(rows: CommandRow[]): string {
  if (rows.length === 0) {
    return "No matching commands found in shell history.";
  }
  const extraPatterns = loadConfig().redactPatterns;
  const body = rows.map((r, i) => {
    const redacted = redactSecrets(r.command, extraPatterns);
    const marker = redacted.redacted ? ` ${REDACTED}` : "";
    const shown = sanitizeForDisplay(redacted.text) + marker;
    return [
      String(i + 1),
      shortDateTime(r.timestamp, r.timestampApproximate),
      r.shell,
      exitBadge(r.exitCode),
      shown,
    ];
  });
  return mdTable(
    ["#", "Date", "Shell", "Exit", { header: "Command", maxWidth: TABLE_COMMAND_WIDTH }],
    body
  );
}

// Commits as a table: short hash, day, message, file count + first path,
// repo basename (full paths stay one `get_commit_context` away).
export function formatCommits(rows: GitCommit[]): string {
  if (rows.length === 0) {
    return "No matching commits found in indexed repos.";
  }
  const body = rows.map((c) => {
    const files =
      c.filesChanged.length === 0
        ? "—"
        : `${c.filesChanged.length} file${c.filesChanged.length === 1 ? "" : "s"} · ${(c.filesChanged[0] ?? "").split("/").pop() ?? ""}`;
    const repoBase = c.repoPath.split("/").pop() ?? c.repoPath;
    return [
      c.hash.slice(0, 7),
      shortDay(c.authorTs),
      sanitizeForDisplay(c.message),
      files,
      repoBase,
    ];
  });
  return mdTable(
    [
      "Commit",
      "Date",
      { header: "Message", maxWidth: 100 },
      { header: "Files", maxWidth: 60 },
      { header: "Repo", maxWidth: 30 },
    ],
    body
  );
}
