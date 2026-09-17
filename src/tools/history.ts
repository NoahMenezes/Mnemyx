// ---------------------------------------------------------------------------
// History tools: search_history, search_by_error, get_recent_commands,
// get_project_profile. Registered onto the MCP server by registerHistoryTools.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  searchCommands,
  getRecentCommands,
  formatRows,
  searchByError,
  formatErrorRows,
  getProjectProfile,
  formatProjectProfile,
  type CommandRow,
} from "../db.ts";
import { loadConfig } from "../config.ts";
import { semanticSearch } from "../embeddings.ts";

export function registerHistoryTools(server: McpServer): void {
server.tool(
  "search_history",
  "Search your past shell commands. Understands natural phrasing via local semantic search (e.g. 'docker wont start' finds a past systemctl restart docker fix), with keyword fallback. Proven-successful commands (exit 0, from the opt-in shell hook) rank first and failures last. Common noise commands (ls, cd, clear, …) are filtered out. Each hit is annotated [exit N] when its outcome is known. Pass repo_path to scope to one project (same-repo hits first); only_repo restricts strictly. Omit both for global search. Results arrive as a preformatted bordered table — quote it verbatim, do not reformat into bullets.",
  {
    query: z.string().describe("Keyword or natural-language query"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results to return (default 20, max 100)"),
    only_successful: z
      .boolean()
      .optional()
      .describe(
        "When true, return only commands proven to exit 0. Commands with unknown outcomes (all pre-hook history) are excluded. Default false."
      ),
    mode: z
      .enum(["auto", "semantic", "keyword"])
      .optional()
      .describe(
        "auto (default): semantic search when available, else keyword. semantic: force meaning-based search (falls back to keyword with a note if unavailable). keyword: force FTS5 substring-style search."
      ),
    repo_path: z
      .string()
      .optional()
      .describe(
        "Scope to one project: workspace root / git toplevel (e.g. /home/you/proj). Same-repo commands sort first; pre-hook rows with unknown repo stay global. Omit for global search."
      ),
    only_repo: z
      .boolean()
      .optional()
      .describe(
        "With repo_path: restrict strictly to that repo instead of boosting. Rows with unknown repo are excluded. Default false."
      ),
  },
  async ({ query, limit, only_successful, mode, repo_path, only_repo }) => {
    const opts = {
      limit: limit ?? 20,
      onlySuccessful: only_successful ?? false,
      repo: repo_path ?? null,
      onlyRepo: only_repo ?? false,
    };
    const wanted = limit ?? 20;
    let prefixNote = "";
    let primary: CommandRow[];
    const useSemantic =
      (mode ?? "auto") !== "keyword" && loadConfig().embeddings;
    if (useSemantic) {
      try {
        primary = await semanticSearch(query, opts);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[mnemyx] semantic search unavailable (${reason}), keyword fallback`);
        if ((mode ?? "auto") === "semantic") {
          prefixNote = `(semantic search unavailable: ${reason}; showing keyword results)\n\n`;
        }
        primary = searchCommands(query, opts);
      }
    } else {
      primary = searchCommands(query, opts);
    }
    // Phase 8 backfill: when command-text matches are thin, past ERROR
    // output often holds the answer (same traceback, different command).
    // Skipped for onlySuccessful (errors are failures by construction)
    // and capped at 5 so one section can't drown the primary results.
    // Error search never breaks history search — it fails silent.
    // Phase 7: backfill respects the same repo scope.
    let extra = "";
    if (!opts.onlySuccessful && primary.length < Math.ceil(wanted / 2)) {
      try {
        const seen = new Set(primary.map((r) => r.id));
        const errRows = searchByError(query, {
          limit: 5,
          repo: opts.repo,
          onlyRepo: opts.onlyRepo,
        }).filter((r) => !seen.has(r.id));
        if (errRows.length > 0) {
          extra = `\n\nAlso matched past error output:\n${formatErrorRows(errRows)}`;
        }
      } catch {
        // Best effort only.
      }
    }
    return {
      content: [{ type: "text" as const, text: `${prefixNote}${formatRows(primary)}${extra}` }],
    };
  }
);

server.tool(
  "search_by_error",
  "Search your past FAILED commands by error message. Paste a traceback or error line — it is normalized (paths, pids, line numbers stripped) and matched against real past stderr, exact matches first. Each hit shows the command plus the error output proving the match. Pass repo_path to prefer this project's failures; only_repo restricts strictly. Results arrive as a preformatted bordered table plus fenced error proof — quote verbatim, do not reformat.",
  {
    error_text: z.string().describe("The error message or traceback to match"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results to return (default 20, max 100)"),
    repo_path: z
      .string()
      .optional()
      .describe(
        "Scope to one project: workspace root / git toplevel. Exact-fingerprint matches still rank first, then same-repo, then recency. Omit for global search."
      ),
    only_repo: z
      .boolean()
      .optional()
      .describe(
        "With repo_path: restrict strictly to that repo. Default false."
      ),
  },
  async ({ error_text, limit, repo_path, only_repo }) => {
    const rows = searchByError(error_text, {
      limit: limit ?? 20,
      repo: repo_path ?? null,
      onlyRepo: only_repo ?? false,
    });
    return { content: [{ type: "text" as const, text: formatErrorRows(rows) }] };
  }
);

server.tool(
  "get_recent_commands",
  "Return the N most recent shell commands. Useful for general context without a specific search query. Pass repo_path to see this project's recent commands first; only_repo restricts strictly. Results arrive as a preformatted bordered table — quote it verbatim, do not reformat into bullets.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many recent commands to return (default 10, max 100)"),
    repo_path: z
      .string()
      .optional()
      .describe(
        "Scope to one project: workspace root / git toplevel. Same-repo commands sort first, chronology kept within each group. Omit for global recents."
      ),
    only_repo: z
      .boolean()
      .optional()
      .describe(
        "With repo_path: restrict strictly to that repo. Default false."
      ),
  },
  async ({ limit, repo_path, only_repo }) => {
    const rows = getRecentCommands({
      limit: limit ?? 10,
      repo: repo_path ?? null,
      onlyRepo: only_repo ?? false,
    });
    return { content: [{ type: "text" as const, text: formatRows(rows) }] };
  }
);

server.tool(
  "get_project_profile",
  "Lightweight usage profile for one project: how many indexed commands ran there, outcome split (succeeded/unknown/failed), activity window, and top command names. Pass the workspace root / git toplevel. Read-only; empty repos report zero, never an error.",
  {
    repo_path: z
      .string()
      .describe("Workspace root / git toplevel to profile (e.g. /home/you/proj)"),
  },
  async ({ repo_path }) => {
    const profile = getProjectProfile(repo_path);
    return {
      content: [{ type: "text" as const, text: formatProjectProfile(profile) }],
    };
  }
);
}
