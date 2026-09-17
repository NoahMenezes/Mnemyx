import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchCommands,
  getRecentCommands,
  formatRows,
  countEmbeddings,
  closeDb,
  searchCommits,
  formatCommits,
  countCommits,
  searchByError,
  formatErrorRows,
  getProjectProfile,
  formatProjectProfile,
  mdTable,
  type CommandRow,
} from "./db.ts";
import { runImport } from "./import.ts";
import { getExitLogPath } from "./exitLog.ts";
import { loadConfig } from "./config.ts";
import {
  indexAllRepos,
  getDiffStat,
  getCommitGraph,
  getCommitDiff,
  getRepoStatus,
  getFileHistory,
  formatFileHistory,
} from "./gitIndexer.ts";
import {
  getCommandsNearCommit,
  resolveCommit,
  formatCommitStory,
  explainLine,
  clampWindowMinutes,
} from "./correlate.ts";
import {
  semanticSearch,
  backfillMissingEmbeddings,
  EMBEDDING_MODEL_ID,
} from "./embeddings.ts";
import {
  clusterSessions,
  getSession,
  formatSessions,
  formatSession,
  DEFAULT_SESSION_GAP_MIN,
} from "./sessions.ts";
import packageJson from "../package.json" with { type: "json" };

// NOTE: all logging goes to stderr (console.error). stdout is owned by the
// MCP stdio transport (JSON-RPC frames) — writing there corrupts the protocol.

const server = new McpServer({
  name: "mnemyx",
  version: packageJson.version,
});

server.tool(
  "search_history",
  "Search your past shell commands. Understands natural phrasing via local semantic search (e.g. 'docker wont start' finds a past systemctl restart docker fix), with keyword fallback. Proven-successful commands (exit 0, from the opt-in shell hook) rank first and failures last. Common noise commands (ls, cd, clear, …) are filtered out. Each hit is annotated [exit N] when its outcome is known. Pass repo_path to scope to one project (same-repo hits first); only_repo restricts strictly. Omit both for global search.",
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
  "Search your past FAILED commands by error message. Paste a traceback or error line — it is normalized (paths, pids, line numbers stripped) and matched against real past stderr, exact matches first. Each hit shows the command plus the error output proving the match. Pass repo_path to prefer this project's failures; only_repo restricts strictly.",
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
  "Return the N most recent shell commands. Useful for general context without a specific search query. Pass repo_path to see this project's recent commands first; only_repo restricts strictly.",
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

server.tool(
  "search_commits",
  "Search indexed git commit messages and file lists across your local repos. Returns hash, date, message, files, and repo path so results are attributable.",
  {
    query: z.string().describe("Keyword query over commit messages and file paths"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results to return (default 20, max 100)"),
  },
  async ({ query, limit }) => {
    const rows = searchCommits(query, limit ?? 20);
    return { content: [{ type: "text" as const, text: formatCommits(rows) }] };
  }
);

server.tool(
  "get_commit_context",
  "Show what one commit changed: message, date, files, repo, plus an on-demand diff stat from local git. Accepts a full hash or short prefix (min 7 hex chars).",
  {
    commit_hash: z.string().describe("Full commit hash or short prefix"),
  },
  async ({ commit_hash }) => {
    const commit = resolveCommit(commit_hash);
    if (!commit) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No indexed commit matches ${JSON.stringify(commit_hash)}. The index may be stale — run reindex_repos and retry.`,
          },
        ],
      };
    }
    const story = formatCommitStory(commit, [], getDiffStat(commit.repoPath, commit.hash));
    return { content: [{ type: "text" as const, text: story }] };
  }
);

server.tool(
  "get_commit_story",
  "Commit context PLUS the shell commands you ran in the time window before it — a rough timeline of what you did, then what you committed. Same-repo commands (v2 hook) sort first; the rest are time-only, so treat them as 'around then'.",
  {
    commit_hash: z.string().describe("Full commit hash or short prefix"),
    window_minutes: z
      .number()
      .int()
      .min(1)
      .max(180)
      .optional()
      .describe("Lookback window in minutes (default 30, max 180)"),
    with_diff: z
      .boolean()
      .optional()
      .describe(
        "Append a capped unified diff preview (default false — diffs eat context)"
      ),
  },
  async ({ commit_hash, window_minutes, with_diff }) => {
    const commit = resolveCommit(commit_hash);
    if (!commit) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No indexed commit matches ${JSON.stringify(commit_hash)}. The index may be stale — run reindex_repos and retry.`,
          },
        ],
      };
    }
    const window = clampWindowMinutes(window_minutes ?? 30);
    const story = formatCommitStory(
      commit,
      getCommandsNearCommit(commit, window),
      getDiffStat(commit.repoPath, commit.hash),
      with_diff === true ? getCommitDiff(commit.repoPath, commit.hash) : null
    );
    return { content: [{ type: "text" as const, text: story }] };
  }
);

server.tool(
  "explain_line",
  "Why does this line exist? Runs git blame on the file/line, then returns the responsible commit plus the story of what you ran around then. repo_path must be an indexed repo; file_path is relative to it.",
  {
    repo_path: z.string().describe("Absolute path of the repo"),
    file_path: z.string().describe("File path relative to the repo root"),
    line_number: z.number().int().min(1).describe("1-based line number"),
  },
  async ({ repo_path, file_path, line_number }) => {
    const { blamedHash, commit } = explainLine(repo_path, file_path, line_number);
    if (blamedHash === null) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Could not blame ${file_path}:${line_number} in ${repo_path} (untracked file, bad line, or not a git repo).`,
          },
        ],
      };
    }
    if (!commit) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Line blamed to ${blamedHash.slice(0, 7)}, but that commit is not indexed — run reindex_repos and retry.`,
          },
        ],
      };
    }
    const story = formatCommitStory(
      commit,
      getCommandsNearCommit(commit),
      getDiffStat(commit.repoPath, commit.hash)
    );
    return {
      content: [
        {
          type: "text" as const,
          text: mdTable(["Line", "File", "Commit"], [
            [String(line_number), file_path, blamedHash.slice(0, 7)],
          ]) + `\n\n${story}`,
        },
      ],
    };
  }
);

server.tool(
  "reindex_repos",
  "Re-scan configured repo roots and index new git commits. Idempotent — re-runs insert nothing new. Run after committing to make fresh commits searchable.",
  {},
  async () => {
    const r = indexAllRepos();
    const extra =
      r.errors > r.failures.length ? `\n… and ${r.errors - r.failures.length} more skipped` : "";
    const skipped =
      r.failures.length > 0
        ? `\n\nSkipped:\n${mdTable(
            ["Repo", "Reason"],
            r.failures.map((f) => [f.repo, f.reason])
          )}${extra}`
        : "";
    return {
      content: [
        {
          type: "text" as const,
          text:
            r.repos === 0
              ? "No repos discovered under repoRoots — check ~/.mnemyx/config.json."
              : `Indexed ${r.repos} repos: ${r.commitsAdded} new commits (${r.commitsSeen} seen)${r.errors > 0 ? `, ${r.errors} skipped` : ""}.${skipped}`,
        },
      ],
    };
  }
);

server.tool(
  "get_repo_log",
  "ASCII commit graph for one local repo (branches/merges drawn like git log --graph): hash, date, message per line, newest first. Orientation before diving into a diff.",
  {
    repo_path: z.string().describe("Absolute path of the repo"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("Max commits to show (default 15, max 30)"),
  },
  async ({ repo_path, limit }) => {
    const graph = getCommitGraph(repo_path, limit ?? 15);
    return {
      content: [
        {
          type: "text" as const,
          text:
            graph ??
            `No commit graph for ${repo_path} (not a git repo, empty, or unreadable).`,
        },
      ],
    };
  }
);

server.tool(
  "get_commit_diff",
  "Unified diff for one commit, rendered like a code-review view: per-file +added −removed counts, @@ hunks, context and +/- lines. Capped (120 lines, 5 files) with truncation markers; secrets masked; binaries collapsed to one line. Works even for commits the index hasn't seen (reads git directly).",
  {
    commit_hash: z.string().describe("Full commit hash or short prefix"),
    repo_path: z
      .string()
      .optional()
      .describe(
        "Absolute repo path (default: the indexed repo holding the hash; required when the hash is unknown to the index)"
      ),
    file: z
      .string()
      .optional()
      .describe("Single file (repo-relative) to diff — narrows big commits"),
    max_lines: z
      .number()
      .int()
      .min(10)
      .max(500)
      .optional()
      .describe("Max diff lines (default 120, max 500)"),
  },
  async ({ commit_hash, repo_path, file, max_lines }) => {
    const h = commit_hash.trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(h)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Bad commit hash ${JSON.stringify(commit_hash)} (want 7-40 hex chars).`,
          },
        ],
      };
    }
    // Prefer the indexed record: disambiguates short hashes and gives the
    // repo without asking. Explicit repo_path wins when both are given.
    const known = resolveCommit(h);
    const repo = repo_path ?? known?.repoPath;
    if (!repo) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown commit ${h.slice(0, 7)} and no repo_path given — pass the repo holding it.`,
          },
        ],
      };
    }
    const diff = getCommitDiff(repo, h, { file, maxLines: max_lines ?? 120 });
    if (diff === null) {
      const hint = known
        ? "the commit may be missing locally (shallow clone?) or the file filter matches nothing"
        : "run reindex_repos, or check the hash";
      return {
        content: [
          {
            type: "text" as const,
            text: `No diff for ${h.slice(0, 7)} in ${repo} — ${hint}.`,
          },
        ],
      };
    }
    const context =
      known && known.repoPath !== repo
        ? `Note: showing diff from ${repo} (index also knows ${h.slice(0, 7)} in ${known.repoPath}).\n\n`
        : "";
    return { content: [{ type: "text" as const, text: `${context}${diff}` }] };
  }
);

server.tool(
  "get_repo_status",
  "What's dirty right now in one local repo: branch + ahead/behind, staged, unstaged, and untracked files. Cheap — call it before editing to know the starting state.",
  {
    repo_path: z.string().describe("Absolute path of the repo"),
  },
  async ({ repo_path }) => {
    const status = getRepoStatus(repo_path);
    return {
      content: [
        {
          type: "text" as const,
          text: status ?? `No status for ${repo_path} (not a git repo or unreadable).`,
        },
      ],
    };
  }
);

server.tool(
  "get_file_history",
  "Every commit that touched one file (follows renames), newest first, each with +added −removed counts for that file. The file-level answer to 'what changed here'.",
  {
    repo_path: z.string().describe("Absolute path of the repo"),
    file_path: z.string().describe("File path relative to the repo root"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Max commits to show (default 10, max 50)"),
  },
  async ({ repo_path, file_path, limit }) => {
    const entries = getFileHistory(repo_path, file_path, limit ?? 10);
    return {
      content: [
        { type: "text" as const, text: formatFileHistory(repo_path, file_path, entries) },
      ],
    };
  }
);

server.tool(
  "list_sessions",
  "Bursts of related commands (+ the commits they led to) grouped into sessions — the neat overview of what you worked on. One table row per session, newest first. Pass repo_path for this project's sessions; sessions split on 30 min of quiet (tunable) or a repo switch.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe("Max sessions to return (default 10, max 30)"),
    repo_path: z
      .string()
      .optional()
      .describe(
        "Scope to one project: workspace root / git toplevel. Matching sessions sort first. Omit for everything."
      ),
    only_repo: z
      .boolean()
      .optional()
      .describe("With repo_path: restrict strictly to that repo. Default false."),
    gap_minutes: z
      .number()
      .int()
      .min(1)
      .max(180)
      .optional()
      .describe("Quiet gap that splits sessions (default 30, max 180)"),
    since_days: z
      .number()
      .int()
      .min(1)
      .max(90)
      .optional()
      .describe("Only sessions ending within the last N days (max 90)"),
  },
  async ({ limit, repo_path, only_repo, gap_minutes, since_days }) => {
    const sessions = clusterSessions({
      scanLimit: 2000,
      gapMinutes: gap_minutes ?? DEFAULT_SESSION_GAP_MIN,
      repo: repo_path ?? null,
      onlyRepo: only_repo ?? false,
      sinceDays: since_days,
    }).slice(0, limit ?? 10);
    return {
      content: [{ type: "text" as const, text: formatSessions(sessions) }],
    };
  }
);

server.tool(
  "get_session",
  "Full detail for one session from list_sessions: timing, outcomes, the commands in story order, and the commits they led to. Session ids shift as new commands land — refresh via list_sessions when one misses.",
  {
    session_id: z.string().describe("Session id from list_sessions (e.g. s1726069200-myproj)"),
    gap_minutes: z
      .number()
      .int()
      .min(1)
      .max(180)
      .optional()
      .describe("Same gap used to list it (default 30) — ids depend on it"),
  },
  async ({ session_id, gap_minutes }) => {
    const s = getSession(session_id, {
      scanLimit: 2000,
      gapMinutes: gap_minutes ?? DEFAULT_SESSION_GAP_MIN,
    });
    return { content: [{ type: "text" as const, text: formatSession(s) }] };
  }
);

async function main(): Promise<void> {
  // Shared import pipeline (same code the `mnemyx init` CLI runs).
  const result = runImport();
  console.error(
    `[mnemyx] import complete: ${result.added} new, ${result.parsed - result.added} already indexed`
  );
  if (result.ageFilteredOut > 0) {
    console.error(
      `[mnemyx] age filter: skipped ${result.ageFilteredOut} entries older than the configured max history age`
    );
  }
  if (!result.exitCodesEnabled) {
    console.error(`[mnemyx] exit codes: disabled via config`);
  } else if (result.exitOutcomes > 0) {
    console.error(
      `[mnemyx] exit codes: ${result.exitOutcomes} distinct commands logged, ${result.exitUpdated} history rows annotated`
    );
  } else {
    console.error(
      `[mnemyx] exit codes: no log at ${getExitLogPath()} (hook not installed — see README, optional)`
    );
  }
  // 4. Phase 4: vector backfill runs in the BACKGROUND — the server must
  // serve (keyword path) immediately, never wait on model download/embed.
  // Until vectors exist, semantic queries transparently use keyword search.
  if (loadConfig().embeddings) {
    const stored = countEmbeddings(EMBEDDING_MODEL_ID);
    if (stored > 0) {
      console.error(`[mnemyx] embeddings: ${stored} vectors stored (${EMBEDDING_MODEL_ID})`);
    }
    backfillMissingEmbeddings()
      .then(({ embedded }) => {
        if (embedded > 0) {
          console.error(
            `[mnemyx] embeddings: backfill complete (+${embedded} new vectors)`
          );
        } else {
          console.error(`[mnemyx] embeddings: index up to date`);
        }
      })
      .catch((err) => {
        // Model download failed / offline / inference broken: keyword search
        // keeps working. This session just won't do semantic search.
        console.error(
          `[mnemyx] embeddings disabled for this session: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  } else {
    console.error(`[mnemyx] embeddings disabled via config (keyword search only)`);
  }
  // Phase 6: git indexing runs in the BACKGROUND like embeddings — the
  // server must serve immediately, never wait on `git log` across repos.
  // Until it finishes, git tools just report "not indexed / reindex".
  // Never throws: indexAllRepos counts failures instead of raising.
  try {
    const stored = countCommits();
    if (stored > 0) {
      console.error(`[mnemyx] commits: ${stored} indexed`);
    }
  } catch {
    // Fresh DB edge: table exists post-migration, but stay quiet on error.
  }
  setTimeout(() => {
    try {
      const r = indexAllRepos();
      if (r.repos === 0) {
        console.error(`[mnemyx] commits: no repos under repoRoots`);
      } else if (r.commitsAdded > 0) {
        console.error(
          `[mnemyx] commits: backfill complete (+${r.commitsAdded} new across ${r.repos} repos)`
        );
      } else {
        console.error(`[mnemyx] commits: index up to date (${r.commitsSeen} seen)`);
      }
    } catch (err) {
      console.error(
        `[mnemyx] git indexing skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, 0);
  // 5. Serve over stdio for MCP clients (Claude Code / Desktop / Cursor).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mnemyx] MCP server running on stdio");
}

// Entry guard: importing this module must never launch the server
// (tests and future tooling import it for its pieces).
if (import.meta.main) {
  // Graceful shutdown: checkpoint WAL + close the DB instead of dying
  // mid-transaction when the client kills us (client restarts, timeouts).
  const shutdown = (signal: string): void => {
    try {
      console.error(`[mnemyx] ${signal} received, closing DB`);
      closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  main().catch((err) => {
    console.error(`[mnemyx] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
