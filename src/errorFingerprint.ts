// ---------------------------------------------------------------------------
// Phase 8: error fingerprinting. Failed commands carry a stderr tail;
// matching raw text almost never hits twice (paths, pids, timestamps
// differ every run), so both stored rows and incoming queries go through
// normalizeError() first and matching happens on fingerprints.
//
// Two deliberate policies (read before touching):
// 1. Redact BEFORE normalize/store. redactSecrets() runs first so a pasted
//    key becomes "[redacted]" in BOTH snippet and fingerprint — the raw
//    secret never reaches SQLite (not even WAL). Command text keeps the
//    old store-raw/display-masked rule; stderr is the exception, because
//    error output is never something you search BY secret.
// 2. Unknown formats degrade to redacted verbatim tail, never "". A
//    fingerprint that preserves *something* still matches reruns of the
//    same failure, which is the common case.
//
// Rule list is intentionally small and ordered: each rule is one regex +
// comment + example. Error formats vary hugely (Python/Node/Rust/Go/CLI)
// — cover the common shapes, leave EXTRA_NORMALIZERS for the rest.
// ---------------------------------------------------------------------------

import { redactSecrets } from "./redact.ts";

/** Fingerprints longer than this are truncated (match column stays lean). */
export const MAX_FINGERPRINT_CHARS = 500;

/**
 * Extra normalizers run AFTER the built-ins (tests/stubs hook in here
 * without touching the rule list). Keep each one total (no exceptions —
 * a throwing normalizer must never break indexing; normalizeError
 * guards the whole chain anyway).
 */
export const EXTRA_NORMALIZERS: ((s: string) => string)[] = [];

// One rule: pattern + replacement + why (example in comment).
// Replacements may be strings or functions (for match-dependent output).
const RULES: { re: RegExp; to: string | ((m: string) => string) }[] = [
  // /home/noah/proj/app.py, C:\Users\noah\app.py -> <PATH> (machine-specific).
  { re: /(\/[^/\s:]+)+(\.\w+)?/g, to: "<PATH>" },
  { re: /[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, to: "<PATH>" },
  // 0x7f3a2b1c4d50 -> <ADDR> (ASLR changes it every run).
  { re: /\b0x[0-9a-fA-F]+\b/g, to: "<ADDR>" },
  // 550e8400-e29b-41d4-a716-446655440000 -> <ID> (uuids, request ids).
  { re: /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, to: "<ID>" },
  // 2026-09-16T10:53:22, 10:53:22.123, 2026/09/16 -> <TS>.
  { re: /\b\d{4}[-/]\d{2}[-/]\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, to: "<TS>" },
  { re: /\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, to: "<TS>" },
  // app.py:123, app.js:10:5 -> file:<N> (line numbers shift with edits).
  // Runs AFTER path blanking, so this catches the bare `name.ext:N` form.
  { re: /\b([\w.-]+\.\w+):\d+(?::\d+)?\b/g, to: "$1:<N>" },
  // pid 12345, port 8080, exit code 1 -> <N> (PIDs/ports vary).
  { re: /\b(?:pid|port|exit code|code|errno)\s+\d+\b/gi, to: (m: string) => m.replace(/\d+$/, "<N>") },
  // Long digit runs (counts, byte sizes, offsets) -> <N>, but keep
  // single small digits (they're often semantic: "expected 2 args").
  { re: /\b\d{4,}\b/g, to: "<N>" },
];

// Python: `Traceback ... File ...` frames point at user code; the signal
// is the LAST line (`ValueError: bad`). Keep the exception line plus the
// exception TYPE of every chained cause (`During handling...` noise goes).
function pythonHead(text: string): string | null {
  if (!text.includes("Traceback (most recent call last):")) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  // Exception lines look like `ValueError: msg` or bare `KeyboardInterrupt`.
  const exc = lines.filter((l) => /^[A-Za-z_][\w.]*Error\b|^[\w.]*Exception\b|^[A-Z][a-zA-Z]*: /.test(l) || /^[A-Za-z_]+: /.test(l));
  const last = lines[lines.length - 1] as string;
  // No frame count: traceback LENGTH jitters between runs of the same bug.
  return (exc.length > 0 ? exc.slice(-3) : [last]).join(" | ");
}

// Node: `ErrorType: msg` head + first user frame hint; drop the `at …`
// stack (paths already blanked, but frame ORDER still jitters).
function nodeHead(text: string): string | null {
  const first = text.split("\n", 2)[0]?.trim() ?? "";
  // `TypeError: x is not a function`, `Error: ENOENT: ...`, `SyntaxError: ...`
  if (!/^[A-Za-z_][\w.]*Error\b/.test(first) && !/^Error: /.test(first)) return null;
  return first;
}

// Rust: `thread 'main' panicked at 'msg', src/main.rs:12:3` -> keep msg.
// Go: `panic: msg` head line.
function panicHead(text: string): string | null {
  const rust = /panicked at '([^']+)'/.exec(text);
  if (rust?.[1] !== undefined) return `panic: ${rust[1]}`;
  const go = /^panic: (.+)$/m.exec(text);
  if (go?.[1] !== undefined) return `panic: ${go[1].trim()}`;
  return null;
}

// Normalize stderr into a matchable fingerprint. Total function: any
// input (even hostile/empty) yields a short string, never throws.
export function normalizeError(stderrText: string, extraPatterns: string[] = []): string {
  try {
    // 1. Secrets first (policy: redact before store — see header).
    let text = redactSecrets(stderrText, extraPatterns).text;
    // 2. Language-aware head extraction (keeps signal, drops frames).
    const lang = pythonHead(text) ?? nodeHead(text) ?? panicHead(text);
    if (lang !== null) text = lang;
    // 3. Volatile-detail rules, in listed order.
    for (const r of RULES) {
      text = typeof r.to === "string" ? text.replace(r.re, r.to) : text.replace(r.re, r.to);
    }
    for (const fn of EXTRA_NORMALIZERS) {
      try {
        text = fn(text);
      } catch {
        // A custom normalizer must never break indexing.
      }
    }
    // 4. Collapse whitespace runs (indentation jitter) and cap length.
    text = text.replace(/\s+/g, " ").trim();
    if (text.length > MAX_FINGERPRINT_CHARS) {
      text = text.slice(0, MAX_FINGERPRINT_CHARS);
    }
    return text;
  } catch {
    return "";
  }
}
