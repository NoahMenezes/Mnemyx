// ---------------------------------------------------------------------------
// Phase 8: error search. Matches on the normalized fingerprint column —
// the query is normalized with the SAME function as stored rows, so
// volatile details (paths, pids, line numbers) can't break a real match.
// Exact-fingerprint hits rank first, then substring, then recency.
// No denylist here on purpose: a failing `ls` (permission denied) is
// exactly the kind of past error worth resurfacing.
// ---------------------------------------------------------------------------

import { getDb, clampLimit } from "./connection.ts";
import {
  COMMAND_COLS,
  rowToEntry,
  type CommandRow,
  type DbRow,
  type ErrorSearchOptions,
} from "./types.ts";
import { MAX_QUERY_LENGTH, escapeLike, normalizeScopeRepo } from "./scope.ts";
import { sanitizeForDisplay, mdTable, exitBadge, shortDateTime } from "./format.ts";
import { loadConfig } from "../config.ts";
import { redactSecrets } from "../redact.ts";
import { normalizeError } from "../errorFingerprint.ts";

export function searchByError(
  query: string,
  limitOrOptions?: number | ErrorSearchOptions
): CommandRow[] {
  const opts: ErrorSearchOptions =
    typeof limitOrOptions === "number"
      ? { limit: limitOrOptions }
      : (limitOrOptions ?? {});
  const trimmed = query.trim();
  if (!trimmed) return [];
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(
      `query too long (${trimmed.length} chars, max ${MAX_QUERY_LENGTH})`
    );
  }
  const fp = normalizeError(trimmed, loadConfig().redactPatterns);
  if (fp === "") return [];
  const wanted = clampLimit(opts.limit, 20);
  // Phase 7: exact-fingerprint match stays outermost (stronger than repo),
  // then same-repo boost, then recency. onlyRepo restricts strictly.
  const scopeRepo = normalizeScopeRepo(opts.repo ?? null);
  const strictRepo = opts.onlyRepo === true && scopeRepo !== null;
  const boostRepo = !strictRepo ? scopeRepo : null;
  const like = `%${escapeLike(fp)}%`;
  const rows = getDb()
    .query(
      `SELECT ${COMMAND_COLS}
       FROM commands
       WHERE stderr_fp LIKE ? ESCAPE '\\'
         ${strictRepo ? "AND repo = ?" : ""}
       ORDER BY CASE WHEN stderr_fp = ? THEN 0 ELSE 1 END, ${boostRepo !== null ? "CASE WHEN repo = ? THEN 0 ELSE 1 END," : ""} timestamp DESC
       LIMIT ?`
    )
    .all(
      ...(strictRepo && scopeRepo !== null
        ? [like, scopeRepo, fp]
        : [like, fp]),
      ...(boostRepo !== null ? [boostRepo] : []),
      Math.min(wanted * 2, 200)
    ) as DbRow[];
  return rows.slice(0, wanted).map(rowToEntry);
}

// Error matches: one table row per hit (command, single-line), then the
// snippet that PROVES the match in its own fenced block — the LLM (and
// user) can confirm it's the same failure, not a coincidental
// command-text overlap. Snippets are display-masked again even though
// they were redacted at store time (defense in depth). Snippet bodies stay
// multiline on purpose: collapsing them would destroy the evidence.
export const MAX_SNIPPET_DISPLAY_CHARS = 800;

export function formatErrorRows(rows: CommandRow[]): string {
  if (rows.length === 0) {
    return "No past errors match that message.";
  }
  const extraPatterns = loadConfig().redactPatterns;
  const prepared = rows.map((r) => {
    const shown = sanitizeForDisplay(
      redactSecrets(r.command, extraPatterns).text
    );
    let err = r.stderrSnippet === null
      ? "(no captured output)"
      : sanitizeForDisplay(redactSecrets(r.stderrSnippet, extraPatterns).text);
    if (err.length > MAX_SNIPPET_DISPLAY_CHARS) {
      err = err.slice(0, MAX_SNIPPET_DISPLAY_CHARS) + "… [truncated]";
    }
    return { r, shown, err };
  });
  const table = mdTable(
    ["#", "Date", "Exit", { header: "Command", maxWidth: 200 }],
    prepared.map(({ r, shown }, i) => [
      String(i + 1),
      shortDateTime(r.timestamp),
      exitBadge(r.exitCode),
      shown,
    ])
  );
  const proofs = prepared.map(({ err }, i) => `**${i + 1} · error:**\n\`\`\`\n${err}\n\`\`\``);
  return `${table}\n\n${proofs.join("\n\n")}`;
}
