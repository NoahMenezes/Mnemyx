import { existsSync, statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { HistoryEntry, SupportedShell } from "./db.ts";

// ---------------------------------------------------------------------------
// History file locations per OS.
// ---------------------------------------------------------------------------

interface HistorySource {
  path: string;
  shell: SupportedShell;
  /** Which parser to use for this file. */
  format: "zsh-extended" | "plain";
}

// Candidate history files. Phase 1 scope: macOS/Linux, zsh + bash only.
// Callers probe each path and skip missing ones — most users have 1-2 of these.
export function getHistoryFilePaths(): HistorySource[] {
  const home = homedir();
  return [
    { path: join(home, ".zsh_history"), shell: "zsh", format: "zsh-extended" },
    { path: join(home, ".bash_history"), shell: "bash", format: "plain" },
  ];
}

// ---------------------------------------------------------------------------
// zsh extended history.
//
// Each entry is ONE logical line shaped like:
//
//   : <unix-timestamp>:<duration-seconds>;<command>
//
// e.g. `: 1787806104:0;sudo dnf install foo -y`
//
// Why this regex: the header is `: `, then digits (timestamp), then `:`,
// then digits (how long the command ran), then `;`. The command itself may
// contain `;` (e.g. `make; make install`), so we split on the FIRST `;`
// after the header, and capture everything after it verbatim.
//
// Multiline commands are stored with a literal backslash + newline inside
// the file, so we first join continuation lines (trailing `\`) into one
// logical line before matching. Lines that don't match the header (user
// disabled EXTENDED_HISTORY) fall back to plain-command handling with an
// approximate timestamp.
// ---------------------------------------------------------------------------

const ZSH_LINE_RE = /^: (\d+):(\d+);([\s\S]*)$/;

// Multiline commands: zsh escapes each embedded newline in the file as
// `\` + real newline. Crucially, if the user's command line itself already
// ended with a `\` (shell line-continuation, e.g. `make && \`), the file
// then contains TWO backslashes + newline (`&& \\`). Verified against a
// real ~/.zsh_history (multiline install script stored exactly this way).
//
// So continuation detection is NOT "odd number of trailing backslashes".
// Instead we use one line of lookahead: a segment ending in `\` continues
// the entry being accumulated IFF the next physical line is NOT itself a
// `: ts:dur;` header. The single escape backslash is stripped and the
// newline restored, which reconstructs the user's original command text
// byte-for-byte in both cases:
//
//   file `foo\` + NL + `bar`    -> command `foo` + NL + `bar`
//   file `foo && \\` + NL + `bar` -> command `foo && \` + NL + `bar`
//
// A trailing `\` at the very end of an entry (literal backslash in the
// command, next line is a header or EOF) is kept verbatim.
function joinZshLines(physical: string[]): string[] {
  const logical: string[] = [];
  let current = "";
  for (let i = 0; i < physical.length; i++) {
    const line = physical[i] as string;
    const next = physical[i + 1];
    current += line;
    const nextIsHeader =
      next !== undefined && ZSH_LINE_RE.test(next);
    if (current.endsWith("\\") && !nextIsHeader && next !== undefined) {
      // Escaped embedded newline: drop the escape char, restore the newline,
      // keep accumulating into the same logical entry.
      current = current.slice(0, -1) + "\n";
    } else {
      logical.push(current);
      current = "";
    }
  }
  if (current) logical.push(current);
  return logical;
}

export function parseZshHistory(
  content: string,
  sourceFile: string,
  fallbackTimestamp: number
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of joinZshLines(content.split("\n"))) {
    if (!line.trim()) continue;
    const m = ZSH_LINE_RE.exec(line);
    if (m?.[1] !== undefined && m[3] !== undefined) {
      const command = m[3].trim();
      if (!command) continue;
      entries.push({
        command,
        timestamp: Number.parseInt(m[1], 10),
        sourceFile,
        shell: "zsh",
        timestampApproximate: false,
      });
    } else {
      // Plain line in a zsh file (EXTENDED_HISTORY off) — keep it, approximate time.
      const command = line.trim();
      if (!command) continue;
      entries.push({
        command,
        timestamp: fallbackTimestamp,
        sourceFile,
        shell: "zsh",
        timestampApproximate: true,
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Plain bash history.
// One command per line, no timestamps. We use the file's mtime as a rough
// fallback so results still sort sanely, flagged approximate.
// ---------------------------------------------------------------------------

export function parsePlainHistory(
  content: string,
  sourceFile: string,
  shell: SupportedShell,
  fallbackTimestamp: number
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of content.split("\n")) {
    const command = line.trim();
    if (!command) continue;
    entries.push({
      command,
      timestamp: fallbackTimestamp,
      sourceFile,
      shell,
      timestampApproximate: true,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Top-level: auto-detect which history files exist, parse + merge them.
// Never throws for a missing/unreadable file — most users have 1-2 shells.
// ---------------------------------------------------------------------------

export function parseAllAvailableHistory(): HistoryEntry[] {
  // Log context only; we probe ALL candidates regardless of $SHELL because
  // users commonly have both zsh and bash history on disk.
  const detectedShell = process.env.SHELL ?? "(unknown)";
  console.error(
    `[mnemyx] platform=${process.platform} $SHELL=${detectedShell}`
  );

  const all: HistoryEntry[] = [];
  for (const source of getHistoryFilePaths()) {
    if (!existsSync(source.path)) continue;
    try {
      const content = readFileSync(source.path, "utf8");
      // mtime fallback for formats without timestamps (seconds).
      const mtime = Math.floor(statSync(source.path).mtimeMs / 1000);
      let entries: HistoryEntry[];
      switch (source.format) {
        case "zsh-extended":
          entries = parseZshHistory(content, source.path, mtime);
          break;
        case "plain":
          entries = parsePlainHistory(
            content,
            source.path,
            source.shell,
            mtime
          );
          break;
      }
      console.error(
        `[mnemyx] indexed ${entries.length} commands from ${source.path} (${source.shell})`
      );
      all.push(...entries);
    } catch (err) {
      // Skip gracefully — a single unreadable file must not kill the server.
      console.error(
        `[mnemyx] skipping ${source.path}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  console.error(`[mnemyx] total ${all.length} commands from history`);
  return all;
}
