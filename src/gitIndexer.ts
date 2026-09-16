// ---------------------------------------------------------------------------
// Phase 6: git history indexing. One `git log` spawn PER REPO (never per
// commit) keeps startup fast: ~2000 commits parse from a single stdout
// buffer. No git library — plain CLI via Bun.spawnSync, local only.
//
// Stored: hash + subject + author time + file list. Full diffs are NOT
// stored (size); fetched on demand via getDiffStat() when a tool needs one.
// Every failure mode (no git binary, not a repo, permission) skips the
// repo with a stderr note — indexing never crashes the server.
// ---------------------------------------------------------------------------

import { statSync } from "node:fs";
import { normalize, resolve, sep } from "node:path";
import { bulkInsertCommits, sanitizeForDisplay } from "./db.ts";
import { discoverReposFromConfig } from "./repoScanner.ts";
import { redactSecrets, REDACTED } from "./redact.ts";
import { loadConfig } from "./config.ts";

/** Upper bound per repo: keeps one giant monorepo from stalling startup. */
export const MAX_COMMITS_PER_REPO = 2000;
/** Truncation for on-demand diff stat output (tool display, not storage). */
export const MAX_DIFF_STAT_CHARS = 4000;

export interface RepoIndexResult {
  repo: string;
  added: number;
  total: number;
  skipped?: string;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Parse one `git log` stdout buffer into NewCommit rows. Format produced by
// indexRepo(): pretty `%x1e%H%x1f%at%x1f%s` + `--name-only`, so each record
// is `\x1e hash \x1f ts \x1f subject \n file…` — the separator LEADS each
// record so a commit's header stays glued to its own file list. (%s is the
// one-line subject: no newlines, no control chars in practice.) Malformed
// records are dropped, never throw.
export function parseGitLog(
  output: string,
  repoPath: string
): { hash: string; repoPath: string; message: string; authorTs: number; filesChanged: string[] }[] {
  const out: { hash: string; repoPath: string; message: string; authorTs: number; filesChanged: string[] }[] = [];
  for (const record of output.split("\x1e")) {
    if (!record.trim()) continue;
    const nl = record.indexOf("\n");
    const header = (nl < 0 ? record : record.slice(0, nl)).replace(/\x1e$/, "");
    const parts = header.split("\x1f");
    if (parts.length < 3) continue;
    const [hashRaw = "", tsRaw = "", ...subjectParts] = parts;
    const hash = hashRaw.trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(hash)) continue;
    const authorTs = Number.parseInt(tsRaw.trim(), 10);
    if (!Number.isFinite(authorTs) || authorTs < 0) continue;
    const message = subjectParts.join("\x1f").trim();
    if (!message) continue;
    const rest = nl < 0 ? "" : record.slice(nl + 1);
    const filesChanged = rest
      .split("\n")
      .map((f) => f.trim())
      .filter((f) => f !== "")
      .slice(0, 100);
    out.push({ hash, repoPath, message, authorTs, filesChanged });
  }
  return out;
}

// Index one repo: single git spawn -> parse -> bulk insert. Never throws
// for expected conditions (missing dir, git failure); returns skipped note.
export function indexRepo(repoPath: string): RepoIndexResult {
  const repo = normalize(repoPath);
  if (!isDir(repo)) {
    return { repo, added: 0, total: 0, skipped: "not a directory" };
  }
  let proc: { exitCode: number | null; stdout: unknown; stderr: unknown };
  try {
    proc = Bun.spawnSync(
      [
        "git",
        "-c",
        "log.showSignature=false",
        "log",
        `--max-count=${MAX_COMMITS_PER_REPO}`,
        "--pretty=format:%x1e%H%x1f%at%x1f%s",
        "--name-only",
      ],
      { cwd: repo, stdout: "pipe", stderr: "pipe" }
    );
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`[mnemyx] skipping git repo ${repo}: ${reason}`);
    return { repo, added: 0, total: 0, skipped: reason };
  }
  if (proc.exitCode !== 0) {
    const reason = String(proc.stderr).trim().slice(0, 200) || `exit ${proc.exitCode}`;
    console.error(`[mnemyx] skipping git repo ${repo}: ${reason}`);
    return { repo, added: 0, total: 0, skipped: reason };
  }
  const commits = parseGitLog(String(proc.stdout), repo);
  const added = commits.length > 0 ? bulkInsertCommits(commits) : 0;
  return { repo, added, total: commits.length };
}

export interface IndexAllResult {
  repos: number;
  commitsSeen: number;
  commitsAdded: number;
  errors: number;
}

// Discover + index every repo. Failures count, never throw.
export function indexAllRepos(configPath?: string): IndexAllResult {
  let roots: string[];
  try {
    roots = discoverReposFromConfig(configPath);
  } catch (err) {
    console.error(
      `[mnemyx] repo discovery failed: ${err instanceof Error ? err.message : String(err)}`
    );
    return { repos: 0, commitsSeen: 0, commitsAdded: 0, errors: 1 };
  }
  let commitsSeen = 0;
  let commitsAdded = 0;
  let errors = 0;
  for (const repo of roots) {
    try {
      const r = indexRepo(repo);
      commitsSeen += r.total;
      commitsAdded += r.added;
      if (r.skipped !== undefined) errors++;
    } catch (err) {
      errors++;
      console.error(
        `[mnemyx] skipping git repo ${repo}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { repos: roots.length, commitsSeen, commitsAdded, errors };
}

// On-demand `git show --stat` for one commit. Hash strictly validated
// (hex only) and passed as argv — no shell — so injection is impossible.
// Secrets masked (a filename can contain a token-ish string); returns
// truncated stdout or null when unavailable.
export function getDiffStat(repoPath: string, hash: string): string | null {
  const h = hash.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(h)) return null;
  if (!isDir(repoPath)) return null;
  try {
    const proc = Bun.spawnSync(
      ["git", "show", "--stat", "--oneline", h, "--"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) return null;
    const out = String(proc.stdout);
    if (!out.trim()) return null;
    const cleaned = redactGitOutput(
      out.length > MAX_DIFF_STAT_CHARS
        ? out.slice(0, MAX_DIFF_STAT_CHARS) + "\n… [truncated]"
        : out
    );
    return cleaned;
  } catch {
    return null;
  }
}

// Shared choke point for ALL git CLI output shown to the AI: sanitize
// terminal/control chars, mask secrets line-by-line (a diff can easily
// contain a pasted key), append one [redacted] note when anything hid.
// Mirrors formatRows()'s policy: store raw (git objects), display masked.
export function redactGitOutput(text: string): string {
  const extra = loadConfig().redactPatterns;
  let hit = false;
  const lines = text.split("\n").map((line) => {
    const clean = sanitizeForDisplay(line);
    const r = redactSecrets(clean, extra);
    if (r.redacted) hit = true;
    return r.text;
  });
  const out = lines.join("\n");
  return hit ? `${out}\n(${REDACTED}: secrets masked in git output)` : out;
}

/** Default/max graph depth: enough for orientation, not a full history dump. */
export const MAX_GRAPH_COMMITS = 30;
export const MAX_GRAPH_CHARS = 4000;

// ASCII commit graph (`git log --graph`): branches/merges drawn by git
// itself — no parsing to maintain. Single spawn, secrets-masked.
// Null = not a repo / git failure / empty.
export function getCommitGraph(repoPath: string, limit = 15): string | null {
  if (!isDir(repoPath)) return null;
  const n = Math.min(
    MAX_GRAPH_COMMITS,
    Math.max(1, Math.floor(limit))
  );
  if (!Number.isFinite(n)) return null;
  try {
    const proc = Bun.spawnSync(
      [
        "git",
        "log",
        "--graph",
        "--pretty=format:%h %ad %s",
        "--date=short",
        "-n",
        String(n),
      ],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) return null;
    const out = String(proc.stdout);
    if (!out.trim()) return null;
    const cut =
      out.length > MAX_GRAPH_CHARS
        ? out.slice(0, MAX_GRAPH_CHARS) + "\n… [truncated]"
        : out;
    return redactGitOutput(cut);
  } catch {
    return null;
  }
}

// Which commit last touched one line? Thin wrapper over `git blame
// --porcelain` (stable63: first token of the first line is the hash).
// Path traversal guarded: relPath must resolve INSIDE repoPath.
// Returns the 40-char hash or null (untracked file, bad line, no git).
export function blameLine(
  repoPath: string,
  relPath: string,
  line: number
): string | null {
  if (!Number.isInteger(line) || line < 1 || line > 10_000_000) return null;
  if (!isDir(repoPath)) return null;
  const repoNorm = normalize(resolve(repoPath));
  const target = normalize(resolve(repoNorm, relPath));
  if (target !== repoNorm && !target.startsWith(repoNorm + sep)) return null;
  const rel = target.slice(repoNorm.length + 1);
  if (rel === "" || rel.includes("..")) return null;
  try {
    const proc = Bun.spawnSync(
      ["git", "blame", "-L", `${line},${line}`, "--porcelain", "--", rel],
      { cwd: repoNorm, stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) return null;
    const first = String(proc.stdout).split("\n", 1)[0] ?? "";
    const m = /^([0-9a-f]{40})\s/.exec(first);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}
