// ---------------------------------------------------------------------------
// Git tools: search_commits, get_commit_context, get_commit_story,
// explain_line, reindex_repos, get_repo_log, get_commit_diff,
// get_repo_status, get_file_history. Registered by registerGitTools.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchCommits, formatCommits, fencedBox } from "../db.ts";
import {
  indexAllRepos,
  getDiffStat,
  getCommitGraph,
  getCommitDiff,
  getRepoStatus,
  getFileHistory,
  formatFileHistory,
} from "../gitIndexer.ts";
import {
  getCommandsNearCommit,
  resolveCommit,
  formatCommitStory,
  explainLine,
  clampWindowMinutes,
} from "../correlate.ts";

export function registerGitTools(server: McpServer): void {
server.tool(
  "search_commits",
  "Search indexed git commit messages and file lists across your local repos. Returns hash, date, message, files, and repo path so results are attributable. Results arrive as a preformatted bordered table — quote it verbatim.",
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
          text: fencedBox(["Line", "File", "Commit"], [
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
        ? `\n\nSkipped:\n${fencedBox(
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
  "Unified diff for one commit, rendered like a code-review view: per-file +added −removed counts, @@ hunks, context and +/- lines. Capped (120 lines, 5 files) with truncation markers; secrets masked; binaries collapsed to one line. Works even for commits the index hasn't seen (reads git directly). Results arrive preformatted (bordered file table plus fenced diff) — quote verbatim.",
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
  "What's dirty right now in one local repo: branch + ahead/behind, staged, unstaged, and untracked files. Cheap — call it before editing to know the starting state. Results arrive as a preformatted bordered table — quote it verbatim.",
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
  "Every commit that touched one file (follows renames), newest first, each with +added −removed counts for that file. The file-level answer to 'what changed here'. Results arrive as a preformatted bordered table — quote it verbatim.",
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
}
