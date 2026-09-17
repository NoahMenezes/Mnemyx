// ---------------------------------------------------------------------------
// Activity tools: list_sessions, get_session, export_notes.
// Registered by registerActivityTools.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  clusterSessions,
  getSession,
  formatSessions,
  formatSession,
  DEFAULT_SESSION_GAP_MIN,
} from "../sessions.ts";
import { buildSessionExport, buildStoryExport } from "../export.ts";
import {
  getCommandsNearCommit,
  resolveCommit,
  formatCommitStory,
} from "../correlate.ts";
import { getDiffStat, getCommitDiff } from "../gitIndexer.ts";

export function registerActivityTools(server: McpServer): void {
server.tool(
  "list_sessions",
  "Bursts of related commands (+ the commits they led to) grouped into sessions — the neat overview of what you worked on. One table row per session, newest first. Pass repo_path for this project's sessions; sessions split on 30 min of quiet (tunable) or a repo switch. Results arrive as a preformatted bordered table — quote it verbatim, do not reformat into bullets.",
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
  "Full detail for one session from list_sessions: timing, outcomes, the commands in story order, and the commits they led to. Session ids shift as new commands land — refresh via list_sessions when one misses. Results arrive preformatted (bordered tables plus fenced blocks) — quote verbatim.",
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

server.tool(
  "export_notes",
  "Opt-in shareable export: a session or commit story as clean redacted markdown for PRs or wikis. Same content as get_session / get_commit_story plus a source header; secrets stay masked. Nothing leaves the machine except what you paste. Results arrive preformatted — quote verbatim.",
  {
    kind: z
      .enum(["session", "commit_story"])
      .describe('What to export: "session" (a list_sessions id) or "commit_story" (a commit hash)'),
    id: z.string().describe("Session id or commit hash (full or ≥7-char prefix)"),
    with_diff: z
      .boolean()
      .optional()
      .describe("For commit stories: append the capped diff preview (default false)"),
  },
  async ({ kind, id, with_diff }) => {
    if (kind === "session") {
      const s = getSession(id, { scanLimit: 2000 });
      if (!s) {
        return { content: [{ type: "text" as const, text: formatSession(null) }] };
      }
      const { markdown } = buildSessionExport(s.id, formatSession(s));
      return { content: [{ type: "text" as const, text: markdown }] };
    }
    const commit = resolveCommit(id);
    if (!commit) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No indexed commit matches ${JSON.stringify(id)}. The index may be stale — run reindex_repos and retry.`,
          },
        ],
      };
    }
    const story = formatCommitStory(
      commit,
      getCommandsNearCommit(commit),
      getDiffStat(commit.repoPath, commit.hash),
      with_diff === true ? getCommitDiff(commit.repoPath, commit.hash) : null
    );
    const { markdown } = buildStoryExport(
      commit.hash.slice(0, 7),
      commit.hash,
      story
    );
    return { content: [{ type: "text" as const, text: markdown }] };
  }
);
}
