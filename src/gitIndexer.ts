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
  const n = Number.isFinite(limit)
    ? Math.min(MAX_GRAPH_COMMITS, Math.max(1, Math.floor(limit)))
    : 15;
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

// Resolve a user-supplied path against a repo root. Returns the
// repo-relative path, or null when it escapes the repo (traversal),
// is empty, or the repo isn't a directory. Shared by blame/diff/status.
export function resolveRepoRel(repoPath: string, relPath: string): string | null {
  if (typeof relPath !== "string" || relPath.trim() === "") return null;
  if (!isDir(repoPath)) return null;
  const repoNorm = normalize(resolve(repoPath));
  const target = normalize(resolve(repoNorm, relPath));
  if (target !== repoNorm && !target.startsWith(repoNorm + sep)) return null;
  const rel = target.slice(repoNorm.length + 1);
  if (rel === "" || rel.includes("..")) return null;
  return rel;
}

// Which commit last touched one line? Thin wrapper over `git blame
// --porcelain` (stable: first token of the first line is the hash).
// Path traversal guarded: relPath must resolve INSIDE repoPath.
// Returns the 40-char hash or null (untracked file, bad line, no git).
export function blameLine(
  repoPath: string,
  relPath: string,
  line: number
): string | null {
  if (!Number.isInteger(line) || line < 1 || line > 10_000_000) return null;
  const rel = resolveRepoRel(repoPath, relPath);
  if (rel === null) return null;
  const repoNorm = normalize(resolve(repoPath));
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

/** Defaults: enough to read a real change, small enough to protect context. */
export const MAX_DIFF_LINES = 120;
export const MAX_DIFF_FILES = 5;

export interface DiffOptions {
  /** Single file (repo-relative). Traversal-guarded; null/omitted = all. */
  file?: string;
  maxLines?: number;
  maxFiles?: number;
}

// Unified diff for one commit, rendered like a code-review diff view:
// per-file `---/+++` headers with `+A −D` counts, `@@` hunks, context and
// `+`/`-` lines. Near-passthrough of `git show` (no re-diffing), with
// three guards: line/file caps with labeled truncation, binary files
// collapsed to one line, every line secret-masked. Null = bad hash,
// non-repo, unknown commit, or empty diff.
export function getCommitDiff(
  repoPath: string,
  hash: string,
  opts: DiffOptions = {}
): string | null {
  const h = hash.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(h)) return null;
  if (!isDir(repoPath)) return null;
  const maxLines = Number.isFinite(opts.maxLines)
    ? Math.min(500, Math.max(10, Math.floor(opts.maxLines as number)))
    : MAX_DIFF_LINES;
  const maxFiles = Number.isFinite(opts.maxFiles)
    ? Math.min(20, Math.max(1, Math.floor(opts.maxFiles as number)))
    : MAX_DIFF_FILES;
  const args = [
    "git",
    "show",
    "--unified=3",
    "--no-ext-diff",
    "--no-color",
    h,
  ];
  if (opts.file !== undefined) {
    const rel = resolveRepoRel(repoPath, opts.file);
    if (rel === null) return null;
    args.push("--", rel);
  } else {
    args.push("--");
  }
  let raw: string;
  try {
    const proc = Bun.spawnSync(args, {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return null;
    raw = String(proc.stdout);
    if (!raw.trim()) return null;
  } catch {
    return null;
  }
  interface FileBlock {
    header: string;
    lines: string[];
    added: number;
    deleted: number;
    binary: boolean;
  }
  const files: FileBlock[] = [];
  let cur: FileBlock | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/f b/f` — keep the two paths as the section title.
      cur = { header: line.slice("diff --git ".length), lines: [], added: 0, deleted: 0, binary: false };
      files.push(cur);
      continue;
    }
    const b: FileBlock | null = cur;
    if (b === null) continue; // commit header lines before first file
    if (line.startsWith("Binary files ")) {
      b.binary = true;
      b.lines = [`[${line.trim()}]`];
      continue;
    }
    if (
      line.startsWith("index ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("similarity ") ||
      line.startsWith("rename ")
    ) {
      continue; // plumbing the header line already summarizes
    }
    if (line.startsWith("+") && !line.startsWith("+++")) b.added++;
    else if (line.startsWith("-") && !line.startsWith("---")) b.deleted++;
    b.lines.push(line);
  }
  const shownFiles = files.filter((f) => f.lines.length > 0 || f.binary);
  if (shownFiles.length === 0) return null;
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalDeleted = files.reduce((s, f) => s + f.deleted, 0);
  const extra = loadConfig().redactPatterns;
  const mask = (line: string): string => {
    const r = redactSecrets(sanitizeForDisplay(line), extra);
    if (r.redacted) maskedLines++;
    return r.text;
  };
  let maskedLines = 0;
  const out: string[] = [
    `diff ${h.slice(0, 7)} (${shownFiles.length} file${shownFiles.length === 1 ? "" : "s"}, +${totalAdded} −${totalDeleted})`,
  ];
  let emitted = 0;
  let cutFiles = 0;
  let cutLines = 0;
  for (let i = 0; i < shownFiles.length; i++) {
    const f = shownFiles[i] as FileBlock;
    if (i >= maxFiles) {
      cutFiles++;
      cutLines += f.lines.length;
      continue;
    }
    out.push(`--- ${f.header} | +${f.added} −${f.deleted}`);
    for (const line of f.lines) {
      if (emitted >= maxLines) break;
      out.push(mask(line));
      emitted++;
    }
  }
  // Exact remainder: content lines of shown files minus what we emitted.
  const totalLines = shownFiles
    .slice(0, maxFiles)
    .reduce((s, f) => s + f.lines.length, 0);
  cutLines +=
    totalLines - emitted +
    shownFiles.slice(maxFiles).reduce((s, f) => s + f.lines.length, 0);
  if (cutFiles > 0 || cutLines > 0) {
    const parts: string[] = [];
    if (cutLines > 0) parts.push(`${cutLines} more lines`);
    if (cutFiles > 0) parts.push(`${cutFiles} more files`);
    out.push(`… [truncated, ${parts.join(" across ")}]`);
  }
  if (maskedLines > 0) {
    out.push(`(${REDACTED}: secrets masked in ${maskedLines} line${maskedLines === 1 ? "" : "s"})`);
  }
  return out.join("\n");
}

/** Cap for status lines: dirty trees can list thousands of files. */
export const MAX_STATUS_LINES = 50;
/** Cap for per-file commit entries. */
export const MAX_FILE_HISTORY = 10;

export interface FileHistoryEntry {
  hash: string;
  authorTs: number;
  message: string;
  added: number;
  deleted: number;
}

// What's dirty RIGHT NOW: branch + ahead/behind, staged / unstaged /
// untracked, relabeled from porcelain codes so an LLM reads them cold.
// Single spawn, capped, masked. Null = not a repo / git failure.
export function getRepoStatus(repoPath: string): string | null {
  if (!isDir(repoPath)) return null;
  let raw: string;
  try {
    const proc = Bun.spawnSync(
      ["git", "status", "--porcelain=v1", "-b", "--"],
      { cwd: repoPath, stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) return null;
    raw = String(proc.stdout);
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((l) => l !== "");
  if (lines.length === 0) return `clean — no staged, unstaged, or untracked changes in ${repoPath}`;
  const first = lines.shift() as string;
  const branch = first.startsWith("## ") ? first.slice(3) : "(unknown branch)";
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const path = line.slice(3);
    if (x === "?" && y === "?") untracked.push(path);
    else {
      if (x !== " " && x !== "?") staged.push(`${x} ${path}`);
      if (y !== " " && y !== "?") unstaged.push(`${y} ${path}`);
    }
  }
  const out: string[] = [`branch: ${branch}`];
  const push = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    out.push(`${label} (${items.length}):`);
    for (const item of items.slice(0, MAX_STATUS_LINES)) out.push(`  ${item}`);
    if (items.length > MAX_STATUS_LINES) {
      out.push(`  … [truncated, ${items.length - MAX_STATUS_LINES} more]`);
    }
  };
  push("staged", staged);
  push("unstaged", unstaged);
  push("untracked", untracked);
  return redactGitOutput(out.join("\n"));
}

// Per-file history: every commit touching relPath (`--follow` tracks
// renames), newest first, with +added −deleted for THIS file from
// --numstat. This is where per-file numbers live — stored nowhere.
// Empty array = bad path / untracked / not a repo (never throws).
export function getFileHistory(
  repoPath: string,
  relPath: string,
  limit = 10
): FileHistoryEntry[] {
  const rel = resolveRepoRel(repoPath, relPath);
  if (rel === null) return [];
  const n = Number.isFinite(limit)
    ? Math.min(50, Math.max(1, Math.floor(limit)))
    : MAX_FILE_HISTORY;
  let raw: string;
  try {
    const proc = Bun.spawnSync(
      [
        "git",
        "log",
        "--follow",
        "--pretty=format:%H%x1f%at%x1f%s",
        "--numstat",
        "-n",
        String(n),
        "--",
        rel,
      ],
      { cwd: normalize(resolve(repoPath)), stdout: "pipe", stderr: "pipe" }
    );
    if (proc.exitCode !== 0) return [];
    raw = String(proc.stdout);
  } catch {
    return [];
  }
  const out: FileHistoryEntry[] = [];
  // Records: `hash\x1f ts \x1f subject` line, then numstat lines
  // (`added \t deleted \t path`), blank-separated.
  let cur: { hash: string; authorTs: number; message: string } | null = null;
  let added = 0;
  let deleted = 0;
  const flush = (): void => {
    if (cur !== null) {
      const done: FileHistoryEntry = {
        hash: cur.hash,
        authorTs: cur.authorTs,
        message: cur.message,
        added,
        deleted,
      };
      out.push(done);
      cur = null;
    }
    added = 0;
    deleted = 0;
  };
  for (const line of raw.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (cur === null && /^[0-9a-f]{40}\x1f/.test(line)) {
      const parts = line.split("\x1f");
      const h = (parts[0] ?? "").trim();
      const tsNum = Number.parseInt((parts[1] ?? "").trim(), 10);
      if (!/^[0-9a-f]{40}$/.test(h) || !Number.isFinite(tsNum)) continue;
      cur = { hash: h, authorTs: tsNum, message: parts.slice(2).join("\x1f").trim() };
      continue;
    }
    const m = /^(\d+|-)\s+(\d+|-)\s+/.exec(line);
    if (m !== null && cur !== null) {
      // Binary files show `- - path`: counts unknown, keep 0/0.
      if (m[1] !== "-") added += Number.parseInt(m[1] as string, 10);
      if (m[2] !== "-") deleted += Number.parseInt(m[2] as string, 10);
    }
  }
  flush();
  return out;
}

// One file's history rendered for an LLM: short hash, date, +A −D,
// message — the file-level answer to "what changed here".
export function formatFileHistory(
  repoPath: string,
  relPath: string,
  entries: FileHistoryEntry[]
): string {
  if (entries.length === 0) {
    return `No history for ${relPath} in ${repoPath} (untracked, bad path, or not a repo).`;
  }
  const lines = entries.map((e) => {
    const date = new Date(e.authorTs * 1000).toISOString().slice(0, 10);
    return `- ${e.hash.slice(0, 7)} ${date} +${e.added} −${e.deleted} ${sanitizeForDisplay(e.message).slice(0, 200)}`;
  });
  return [`history of ${relPath} (${entries.length} commits, newest first):`, ...lines].join("\n");
}
