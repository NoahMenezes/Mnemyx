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
 * Terminal display width: most chars count 1, CJK wide chars and emoji
 * (✅ ❌ ─ │ …) count 2, combining marks count 0. Box borders only line
 * up when padding uses this instead of string length. Best-effort ranges
 * (East Asian Wide/Fullwidth + emoji blocks) — exported for tests.
 */
export function dispWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp >= 0x0300 && cp <= 0x036f) continue; // combining marks
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x2600 && cp <= 0x27bf) ||
      (cp >= 0x2b00 && cp <= 0x2bff) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

/**
 * One table cell of already display-ready text (sanitized + redacted by
 * the caller): collapses newlines to ↵ (a row must stay one line),
 * squeezes whitespace, truncates past maxWidth by display width with ….
 * Pipes need no escaping — borders are drawn, not delimited. Exported
 * for tests.
 */
export function boxCell(text: string, maxWidth?: number): string {
  let out = text.replace(/\s*\n\s*/g, " ↵ ").replace(/[ \t]+/g, " ").trim();
  if (maxWidth !== undefined && maxWidth > 0 && dispWidth(out) > maxWidth) {
    let acc = "";
    let w = 0;
    for (const ch of out) {
      const cw = dispWidth(ch);
      if (w + cw > maxWidth - 1) break;
      acc += ch;
      w += cw;
    }
    out = `${acc}…`;
  }
  return out;
}

function padCell(s: string, width: number, right: boolean): string {
  const pad = Math.max(0, width - dispWidth(s));
  return right ? `${" ".repeat(pad)}${s}` : `${s}${" ".repeat(pad)}`;
}

/**
 * Bordered Unicode table (rounded corners) — the shared builder every
 * tool uses, so all tabular output truncates, pads, and caps identically.
 * Rendered inside ```text fences by callers: agents pass fenced blocks
 * through verbatim instead of paraphrasing them into bullets. Rows past
 * MAX_TABLE_ROWS are cut with a trailing "… and N more" line outside the
 * table, so borders never break.
 */
export function boxTable(
  headers: (string | TableColumn)[],
  rows: string[][]
): string {
  const cols: TableColumn[] = headers.map((h) =>
    typeof h === "string" ? { header: h } : h
  );
  const cells = rows
    .slice(0, MAX_TABLE_ROWS)
    .map((r) => cols.map((c, i) => boxCell(r[i] ?? "", c.maxWidth)));
  const widths = cols.map((c, i) => {
    let w = dispWidth(c.header);
    for (const row of cells) w = Math.max(w, dispWidth(row[i] as string));
    return w;
  });
  const rule = (l: string, m: string, r: string): string =>
    l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const line = (items: string[], alignsRight: boolean[]): string =>
    `│ ${items
      .map((s, i) => padCell(s, widths[i] as number, alignsRight[i] === true))
      .join(" │ ")} │`;
  const out = [
    rule("┌", "┬", "┐"),
    line(
      cols.map((c) => c.header),
      cols.map(() => false)
    ),
    rule("├", "┼", "┤"),
    ...cells.map((row) =>
      line(
        row,
        cols.map((c) => c.align === "right")
      )
    ),
    rule("└", "┴", "┘"),
  ];
  if (rows.length > cells.length) {
    out.push(`… and ${rows.length - cells.length} more rows`);
  }
  return out.join("\n");
}

/** Box table wrapped in a ```text fence (agents pass fences through). */
export function fencedBox(
  headers: (string | TableColumn)[],
  rows: string[][]
): string {
  return ["```text", boxTable(headers, rows), "```"].join("\n");
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
  return fencedBox(
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
  return fencedBox(
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
