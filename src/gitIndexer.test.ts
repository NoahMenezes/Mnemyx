import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, countCommits, searchCommits, getCommitsByHash, getRecentCommits, bulkInsertCommits } from "./db.ts";
import {
  parseGitLog,
  indexRepo,
  indexAllRepos,
  getDiffStat,
  getCommitGraph,
  getCommitDiff,
  getRepoStatus,
  getFileHistory,
  formatFileHistory,
  blameLine,
} from "./gitIndexer.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-git-test-"));
let n = 0;
const dbPath = (): string => join(dir, `t${n++}.db`);

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

function gitEnv(): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

function makeRepo(name: string): string {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "first commit"], { cwd: repo, env: gitEnv() });
  writeFileSync(join(repo, "b.txt"), "world\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "second: add b"], { cwd: repo, env: gitEnv() });
  return repo;
}

test("parseGitLog parses headers+files, drops malformed", () => {
  const out =
    `\x1e${HASH_A}\x1f100\x1ffix login\n` +
    `src/a.ts\nsrc/b.ts\n` +
    `\x1enot-a-record\n` +
    `\x1e${HASH_B}\x1f200\x1fadd feature\n` +
    `\n`;
  const rows = parseGitLog(out, "/r");
  expect(rows).toHaveLength(2);
  expect(rows[0]?.hash).toBe(HASH_A);
  expect(rows[0]?.authorTs).toBe(100);
  expect(rows[0]?.filesChanged).toEqual(["src/a.ts", "src/b.ts"]);
  expect(rows[1]?.filesChanged).toEqual([]);
  expect(parseGitLog("", "/r")).toEqual([]);
});

test("indexRepo indexes a real repo, idempotent on rerun", () => {
  initDb(dbPath());
  const repo = makeRepo("repo1");
  const r1 = indexRepo(repo);
  expect(r1.total).toBe(2);
  expect(r1.added).toBe(2);
  expect(countCommits()).toBe(2);
  const r2 = indexRepo(repo);
  expect(r2.added).toBe(0);
  expect(searchCommits("second").map((c) => c.message)).toEqual(["second: add b"]);
  expect(getRecentCommits(10).map((c) => c.message).sort()).toEqual(
    ["first commit", "second: add b"].sort()
  );
});

test("indexRepo skips missing dirs and non-repos without throwing", () => {
  initDb(dbPath());
  const missing = indexRepo(join(dir, "nope"));
  expect(missing.added).toBe(0);
  expect(missing.skipped).toBeDefined();
  const plain = join(dir, "plain1");
  mkdirSync(plain, { recursive: true });
  const r = indexRepo(plain);
  expect(r.added).toBe(0);
  expect(r.skipped).toBeDefined();
  expect(countCommits()).toBe(0);
});

test("getCommitsByHash matches full and short prefix, rejects junk", () => {
  initDb(dbPath());
  bulkInsertCommits([
    { hash: HASH_A, repoPath: "/r", message: "m", authorTs: 1, filesChanged: [] },
  ]);
  expect(getCommitsByHash(HASH_A)).toHaveLength(1);
  expect(getCommitsByHash(HASH_A.slice(0, 7))).toHaveLength(1);
  expect(getCommitsByHash("xyz")).toEqual([]);
  expect(getCommitsByHash("abc")).toEqual([]); // too short
});

test("getDiffStat returns stat for a real commit, null for junk", () => {
  const repo = makeRepo("repo2");
  const hash = String(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout).trim();
  const stat = getDiffStat(repo, hash);
  expect(stat).not.toBeNull();
  expect(stat as string).toContain("b.txt");
  expect(getDiffStat(repo, "notahash")).toBeNull();
  expect(getDiffStat("/nope", hash)).toBeNull();
});

test("blameLine finds the committing hash, guards traversal", () => {
  const repo = makeRepo("repo3");
  const head = String(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout).trim();
  // b.txt:2 doesn't exist; line 1 of b.txt came from HEAD commit.
  expect(blameLine(repo, "b.txt", 1)).toBe(head);
  expect(blameLine(repo, "../outside.txt", 1)).toBeNull();
  expect(blameLine(repo, "b.txt", 0)).toBeNull();
  expect(blameLine(repo, "missing.txt", 1)).toBeNull();
});

test("indexAllRepos discovers via config file", async () => {
  initDb(dbPath());
  const repo = makeRepo("repo4");
  const cfg = join(dir, "cfg.json");
  await Bun.write(cfg, JSON.stringify({ repoRoots: [repo] }));
  const r = indexAllRepos(cfg);
  expect(r.repos).toBe(1);
  expect(r.commitsAdded).toBe(2);
});

function makeBranchRepo(name: string): { repo: string; featureHash: string } {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "base\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base commit"], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "checkout", "-qb", "feature"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "base\nfeature\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "feature work"], { cwd: repo, env: gitEnv() });
  const featureHash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  Bun.spawnSync(["git", "checkout", "-q", "main"], { cwd: repo });
  Bun.spawnSync(["git", "merge", "--no-ff", "-qm", "merge feature", "feature"], { cwd: repo, env: gitEnv() });
  return { repo, featureHash };
}

test("getCommitGraph draws branches with hashes", () => {
  const { repo, featureHash } = makeBranchRepo("graphrepo");
  const graph = getCommitGraph(repo, 10);
  expect(graph).not.toBeNull();
  expect(graph as string).toContain("*");
  expect(graph as string).toContain(featureHash.slice(0, 7));
  expect(graph as string).toContain("merge feature");
  expect(getCommitGraph(join(dir, "missing"), 10)).toBeNull();
  const plain = join(dir, "plain-graph");
  mkdirSync(plain, { recursive: true });
  expect(getCommitGraph(plain, 10)).toBeNull();
});

test("getDiffStat masks secrets in git output", () => {
  const repo = join(dir, "secretrepo");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  // Secret lives in the commit MESSAGE (filename-free case).
  writeFileSync(join(repo, "a.txt"), "x\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "rotate password=hunter2 now"], {
    cwd: repo,
    env: gitEnv(),
  });
  const hash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  const stat = getDiffStat(repo, hash);
  expect(stat).not.toBeNull();
  expect(stat as string).not.toContain("hunter2");
  expect(stat as string).toContain("[redacted]");
});

function makeDiffRepo(name: string): { repo: string; hash: string } {
  const repo = join(dir, name);
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "code.txt"), "one\ntwo\nthree\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env: gitEnv() });
  writeFileSync(join(repo, "code.txt"), "one\nTWO\nthree\nfour\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "change two add four"], { cwd: repo, env: gitEnv() });
  const hash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  return { repo, hash };
}

test("getCommitDiff renders hunks with exact +/- lines and counts", () => {
  const { repo, hash } = makeDiffRepo("diffrepo");
  const diff = getCommitDiff(repo, hash);
  expect(diff).not.toBeNull();
  const d = diff as string;
  expect(d).toContain("-two");
  expect(d).toContain("+TWO");
  expect(d).toContain("+four");
  expect(d).toContain("@@");
  expect(d).toContain("+2 −1");
  expect(getCommitDiff(repo, "deadbee")).toBeNull();
  expect(getCommitDiff(join(dir, "missing"), hash)).toBeNull();
});

test("getCommitDiff masks secrets and rejects escaping file filters", () => {
  const repo = join(dir, "diffsecret");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "s.txt"), "a\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env: gitEnv() });
  writeFileSync(join(repo, "s.txt"), "a\npassword=hunter2\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "oops"], { cwd: repo, env: gitEnv() });
  const hash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  const diff = getCommitDiff(repo, hash) as string;
  expect(diff).not.toContain("hunter2");
  expect(diff).toContain("[redacted]");
  expect(getCommitDiff(repo, hash, { file: "../evil.txt" })).toBeNull();
  expect(getCommitDiff(repo, hash, { file: "s.txt" })).toContain("+password=");
});

test("getCommitDiff truncates huge diffs with exact remainders", () => {
  const repo = join(dir, "bigdiff");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "b.txt"), "x\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env: gitEnv() });
  const big = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n") + "\n";
  writeFileSync(join(repo, "b.txt"), big);
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "big"], { cwd: repo, env: gitEnv() });
  const hash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  const diff = getCommitDiff(repo, hash, { maxLines: 50 }) as string;
  expect(diff).toContain("… [truncated,");
  expect(diff).toContain("+500");
  expect(diff.split("\n").length).toBeLessThan(100);
});

test("getCommitDiff collapses binary files to one line", () => {
  const repo = join(dir, "bindiff");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "a.bin"), Buffer.from([0, 1, 2, 3]));
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env: gitEnv() });
  writeFileSync(join(repo, "a.bin"), Buffer.from([9, 8, 7, 6, 5]));
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "bin change"], { cwd: repo, env: gitEnv() });
  const hash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  const diff = getCommitDiff(repo, hash) as string;
  expect(diff).toContain("Binary files");
});

test("getRepoStatus labels staged/unstaged/untracked, clean when empty", () => {
  const repo = join(dir, "statusrepo");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-qb", "main"], { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "x\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env: gitEnv() });
  expect(getRepoStatus(repo)).toContain("clean");
  writeFileSync(join(repo, "a.txt"), "dirty\n");
  writeFileSync(join(repo, "new.txt"), "untracked\n");
  const dirty = getRepoStatus(repo) as string;
  expect(dirty).toContain("branch: main");
  expect(dirty).toContain("unstaged");
  expect(dirty).toContain("a.txt");
  expect(dirty).toContain("untracked");
  expect(dirty).toContain("new.txt");
  expect(dirty).toContain("│ Status");
  expect(dirty).toContain("│ File");
  expect(getRepoStatus(join(dir, "missing"))).toBeNull();
});

test("getFileHistory lists commits newest-first with +A -D", () => {  const repo = join(dir, "histrepo");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "one\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "add one"], { cwd: repo, env: gitEnv() });
  writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "add two lines"], { cwd: repo, env: gitEnv() });
  const entries = getFileHistory(repo, "f.txt", 10);
  expect(entries).toHaveLength(2);
  expect(entries[0]?.message).toBe("add two lines");
  expect(entries[0]?.added).toBe(2);
  expect(entries[1]?.added).toBe(1);
  expect(formatFileHistory(repo, "f.txt", entries)).toContain("+2");
  expect(formatFileHistory(repo, "f.txt", entries)).toContain("−0");
  // Guards: traversal, missing file, bad repo.
  expect(getFileHistory(repo, "../evil.txt")).toEqual([]);
  expect(getFileHistory(repo, "missing.txt")).toEqual([]);
  expect(getFileHistory(join(dir, "missing"), "f.txt")).toEqual([]);
});

test("diff design: fenced body, file summary as a table", () => {
  const { repo, hash } = makeDiffRepo("designrepo");
  const diff = getCommitDiff(repo, hash) as string;
  const lines = diff.split("\n");
  // Summary + table outside the fence, body fenced exactly once.
  expect(lines[0]).toMatch(/^diff [0-9a-f]{7} \(1 file, \+2 −1\)$/);
  expect(diff).toContain("│ File");
  const tableRow = lines.find((l) => l.includes("code.txt"));
  expect(tableRow).toContain("+2");
  expect(tableRow).toContain("−1");
  const fenceIdx = lines.map((l, i) => (l === "```diff" ? i : -1)).filter((i) => i >= 0);
  const closeIdx = lines.map((l, i) => (l === "```" ? i : -1)).filter((i) => i >= 0);
  expect(fenceIdx).toHaveLength(1);
  // Two closings: the ```text summary table, then the ```diff body.
  expect(closeIdx).toHaveLength(2);
  const diffClose = closeIdx[closeIdx.length - 1] as number;
  expect(diffClose).toBeGreaterThan(fenceIdx[0] as number);
  // Hunk body inside the diff fence.
  const body = lines.slice((fenceIdx[0] as number) + 1, diffClose).join("\n");
  expect(body).toContain("@@");
  expect(body).toContain("-two");
  expect(body).toContain("+TWO");
});

test("diff design: truncation and redaction notes stay outside the fence", () => {
  const repo = join(dir, "designbig");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "b.txt"), "x\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env: gitEnv() });
  const big = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n") + "\n";
  writeFileSync(join(repo, "b.txt"), big);
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "big"], { cwd: repo, env: gitEnv() });
  const hash = String(
    Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout
  ).trim();
  const diff = getCommitDiff(repo, hash, { maxLines: 10 }) as string;
  const lines = diff.split("\n");
  expect(lines[lines.length - 1]?.startsWith("```")).toBe(false);
  expect(diff).toContain("… [truncated,");
  const closeAt = lines.lastIndexOf("```");
  const truncAt = lines.findIndex((l) => l.startsWith("… [truncated,"));
  expect(closeAt).toBeGreaterThan(-1);
  expect(truncAt).toBeGreaterThan(closeAt);
});

test("graph design: header plus plain-fenced graph, redaction note outside", () => {
  const { repo } = makeBranchRepo("designgraph");
  const graph = getCommitGraph(repo, 10) as string;
  const lines = graph.split("\n");
  expect(lines[0] as string).toMatch(/^### Log of /);
  expect(lines[1]).toBe("```");
  expect(lines[lines.length - 1]).toBe("```");
  expect(graph).toContain("*");
});

test("file-history design: markdown table with counts", () => {
  const repo = join(dir, "designhist");
  mkdirSync(repo, { recursive: true });
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "one\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "add one"], { cwd: repo, env: gitEnv() });
  writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env: gitEnv() });
  Bun.spawnSync(["git", "commit", "-qm", "add two"], { cwd: repo, env: gitEnv() });
  const entries = getFileHistory(repo, "f.txt", 10);
  const text = formatFileHistory(repo, "f.txt", entries);
  expect(text).toContain("│ Commit");
  expect(text).toContain("+2");
});
