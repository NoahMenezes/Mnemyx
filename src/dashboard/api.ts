// ---------------------------------------------------------------------------
// Dashboard JSON API. Same queries as the MCP tools, mapped to masked
// JSON rows for the browser UI. Every string field passes through the
// same choke point as tool output (redact → sanitize → collapse), so the
// browser can never receive a secret the terminal UI wouldn't show.
// Read-only: no handler here writes anything.
// ---------------------------------------------------------------------------

import {
  searchCommands,
  getRecentCommands,
  searchByError,
  searchCommits,
  getProjectProfile,
  boxCell,
  sanitizeForDisplay,
  type CommandRow,
  type GitCommit,
} from "../db.ts";
import { clusterSessions, getSession } from "../sessions.ts";
import { semanticSearch } from "../embeddings.ts";
import { loadConfig } from "../config.ts";
import { redactSecrets } from "../redact.ts";

export interface ApiCommand {
  id: number;
  command: string;
  redacted: boolean;
  ts: number;
  approx: boolean;
  shell: string;
  exit: number | null;
  repo: string | null;
}

export interface ApiCommit {
  hash: string;
  short: string;
  date: string;
  message: string;
  files: string[];
  fileCount: number;
  repo: string;
}

export interface ApiError {
  id: number;
  command: string;
  ts: number;
  exit: number | null;
  snippet: string;
}

function masked(text: string, width = 300): { text: string; redacted: boolean } {
  const r = redactSecrets(text, loadConfig().redactPatterns);
  return { text: boxCell(sanitizeForDisplay(r.text), width), redacted: r.redacted };
}

export function toApiCommand(r: CommandRow): ApiCommand {
  const m = masked(r.command);
  return {
    id: r.id,
    command: m.text,
    redacted: m.redacted,
    ts: r.timestamp,
    approx: r.timestampApproximate,
    shell: r.shell,
    exit: r.exitCode,
    repo: r.repo,
  };
}

export function toApiCommit(c: GitCommit): ApiCommit {
  const m = masked(c.message, 200);
  return {
    hash: c.hash,
    short: c.hash.slice(0, 7),
    date: new Date(c.authorTs * 1000).toISOString(),
    message: m.text,
    files: c.filesChanged.slice(0, 5).map((f) => boxCell(sanitizeForDisplay(f), 80)),
    fileCount: c.filesChanged.length,
    repo: c.repoPath,
  };
}

function toApiError(r: CommandRow): ApiError {
  const m = masked(r.command, 200);
  let snippet =
    r.stderrSnippet === null
      ? "(no captured output)"
      : sanitizeForDisplay(redactSecrets(r.stderrSnippet, loadConfig().redactPatterns).text);
  if (snippet.length > 800) snippet = snippet.slice(0, 800) + "… [truncated]";
  return { id: r.id, command: m.text, ts: r.timestamp, exit: r.exitCode, snippet };
}

export function intParam(raw: string | null, def: number, min: number, max: number): number {
  const n = raw === null ? NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function boolParam(raw: string | null): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

// GET /api/search?q&limit&mode&repo&only_repo&only_successful
export async function handleSearch(params: URLSearchParams): Promise<Response> {
  const q = (params.get("q") ?? "").trim();
  if (!q) return json({ error: "missing q" }, 400);
  const limit = intParam(params.get("limit"), 20, 1, 100);
  const repo = params.get("repo") || null;
  const onlyRepo = boolParam(params.get("only_repo"));
  const onlySuccessful = boolParam(params.get("only_successful"));
  const mode = params.get("mode") === "keyword" ? "keyword" : "auto";
  const opts = { limit, onlySuccessful, repo, onlyRepo };
  let note: string | null = null;
  let rows: CommandRow[];
  if (mode !== "keyword" && loadConfig().embeddings) {
    try {
      rows = await semanticSearch(q, opts);
    } catch (err) {
      note = `semantic unavailable (${err instanceof Error ? err.message : String(err)}); keyword results`;
      rows = searchCommands(q, opts);
    }
  } else {
    rows = searchCommands(q, opts);
  }
  return json({ rows: rows.map(toApiCommand), note });
}

// GET /api/recent?limit&repo&only_repo
export function handleRecent(params: URLSearchParams): Response {
  const rows = getRecentCommands({
    limit: intParam(params.get("limit"), 10, 1, 100),
    repo: params.get("repo") || null,
    onlyRepo: boolParam(params.get("only_repo")),
  });
  return json({ rows: rows.map(toApiCommand) });
}

// GET /api/error?q&limit&repo&only_repo
export function handleError(params: URLSearchParams): Response {
  const q = (params.get("q") ?? "").trim();
  if (!q) return json({ error: "missing q" }, 400);
  try {
    const rows = searchByError(q, {
      limit: intParam(params.get("limit"), 20, 1, 100),
      repo: params.get("repo") || null,
      onlyRepo: boolParam(params.get("only_repo")),
    });
    return json({ rows: rows.map(toApiError) });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

// GET /api/sessions?limit&repo&only_repo&gap&since
export function handleSessions(params: URLSearchParams): Response {
  const sessions = clusterSessions({
    scanLimit: 2000,
    gapMinutes: intParam(params.get("gap"), 30, 1, 180),
    repo: params.get("repo") || null,
    onlyRepo: boolParam(params.get("only_repo")),
    sinceDays: params.get("since") === null ? undefined : intParam(params.get("since"), 30, 1, 90),
  }).slice(0, intParam(params.get("limit"), 10, 1, 30));
  return json({
    sessions: sessions.map((s) => ({
      id: s.id,
      startTs: s.startTs,
      endTs: s.endTs,
      repo: s.repo,
      mixed: s.mixed,
      commands: s.commands.length,
      success: s.success,
      failed: s.failed,
      unknown: s.unknown,
      top: s.topTokens.slice(0, 3).map((t) => t.token),
      commits: s.commits.map((c) => c.hash.slice(0, 7)),
    })),
  });
}

// GET /api/session?id&gap
export function handleSession(params: URLSearchParams): Response {
  const id = (params.get("id") ?? "").trim();
  if (!id) return json({ error: "missing id" }, 400);
  const s = getSession(id, {
    scanLimit: 2000,
    gapMinutes: intParam(params.get("gap"), 30, 1, 180),
  });
  if (!s) return json({ error: "unknown session — ids shift as new commands land; refresh the list" }, 404);
  return json({
    id: s.id,
    startTs: s.startTs,
    endTs: s.endTs,
    repo: s.repo,
    mixed: s.mixed,
    success: s.success,
    failed: s.failed,
    unknown: s.unknown,
    top: s.topTokens,
    commands: s.commands.map(toApiCommand),
    commits: s.commits.map(toApiCommit),
  });
}

// GET /api/commits?q&limit
export function handleCommits(params: URLSearchParams): Response {
  const q = (params.get("q") ?? "").trim();
  if (!q) return json({ error: "missing q" }, 400);
  try {
    return json({ commits: searchCommits(q, intParam(params.get("limit"), 20, 1, 100)).map(toApiCommit) });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
}

// GET /api/profile?repo
export function handleProfile(params: URLSearchParams): Response {
  const repo = (params.get("repo") ?? "").trim();
  if (!repo) return json({ error: "missing repo" }, 400);
  const p = getProjectProfile(repo);
  if (!p) return json({ error: "missing repo" }, 400);
  const share = p.totalCommands > 0 ? Math.round((p.inRepo / p.totalCommands) * 100) : 100;
  return json({ ...p, share });
}
