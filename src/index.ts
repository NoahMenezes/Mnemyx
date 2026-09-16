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
} from "./db.ts";
import { runImport } from "./import.ts";
import { getExitLogPath } from "./exitLog.ts";
import { loadConfig } from "./config.ts";
import {
  indexAllRepos,
  getDiffStat,
  getCommitGraph,
  getCommitDiff,
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
import packageJson from "../package.json" with { type: "json" };

// NOTE: all logging goes to stderr (console.error). stdout is owned by the
// MCP stdio transport (JSON-RPC frames) — writing there corrupts the protocol.

const server = new McpServer({
  name: "mnemyx",
  version: packageJson.version,
});

server.tool(
  "search_history",
  "Search your past shell commands. Understands natural phrasing via local semantic search (e.g. 'docker wont start' finds a past systemctl restart docker fix), with keyword fallback. Proven-successful commands (exit 0, from the opt-in shell hook) rank first and failures last. Common noise commands (ls, cd, clear, …) are filtered out. Each hit is annotated [exit N] when its outcome is known.",
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
  },
  async ({ query, limit, only_successful, mode }) => {
    const opts = {
      limit: limit ?? 20,
      onlySuccessful: only_successful ?? false,
    };
    const useSemantic =
      (mode ?? "auto") !== "keyword" && loadConfig().embeddings;
    if (useSemantic) {
      try {
        const rows = await semanticSearch(query, opts);
        return {
          content: [{ type: "text" as const, text: formatRows(rows) }],
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[mnemyx] semantic search unavailable (${reason}), keyword fallback`);
        if ((mode ?? "auto") === "semantic") {
          const rows = searchCommands(query, opts);
          return {
            content: [
              {
                type: "text" as const,
                text: `(semantic search unavailable: ${reason}; showing keyword results)\n\n${formatRows(rows)}`,
              },
            ],
          };
        }
        // auto mode: silent fallback, keyword results below.
      }
    }
    const rows = searchCommands(query, opts);
    return { content: [{ type: "text" as const, text: formatRows(rows) }] };
  }
);

server.tool(
  "get_recent_commands",
  "Return the N most recent shell commands. Useful for general context without a specific search query.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many recent commands to return (default 10, max 100)"),
  },
  async ({ limit }) => {
    const rows = getRecentCommands(limit ?? 10);
    return { content: [{ type: "text" as const, text: formatRows(rows) }] };
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
          text: `Line ${line_number} of ${file_path} last touched by:\n\n${story}`,
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
    return {
      content: [
        {
          type: "text" as const,
          text:
            r.repos === 0
              ? "No repos discovered under repoRoots — check ~/.mnemyx/config.json."
              : `Indexed ${r.repos} repos: ${r.commitsAdded} new commits (${r.commitsSeen} seen)${r.errors > 0 ? `, ${r.errors} skipped` : ""}.`,
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
