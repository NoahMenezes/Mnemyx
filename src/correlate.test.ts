import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, bulkInsert, bulkInsertCommits, applyExitCodes, type GitCommit } from "./db.ts";
import {
  getCommandsNearCommit,
  resolveCommit,
  formatCommitStory,
  explainLine,
  clampWindowMinutes,
  DEFAULT_STORY_WINDOW_MIN,
} from "./correlate.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-corr-test-"));
let n = 0;
const dbPath = (): string => join(dir, `t${n++}.db`);

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const HASH = "c".repeat(40);
function commit(ts: number): GitCommit {
  return { id: 1, hash: HASH, repoPath: "/r", message: "fix it", authorTs: ts, filesChanged: ["a.ts"] };
}

function cmd(command: string, timestamp: number): { command: string; timestamp: number; sourceFile: string; shell: "zsh"; timestampApproximate: boolean } {
  return { command, timestamp, sourceFile: "/h", shell: "zsh", timestampApproximate: false };
}

test("clampWindowMinutes bounds wild input", () => {
  expect(clampWindowMinutes(30)).toBe(30);
  expect(clampWindowMinutes(0)).toBe(1);
  expect(clampWindowMinutes(9999)).toBe(180);
  expect(clampWindowMinutes(NaN)).toBe(DEFAULT_STORY_WINDOW_MIN);
});

test("getCommandsNearCommit takes the window before, not after", () => {
  initDb(dbPath());
  bulkInsert([
    cmd("deploy before", 1000),
    cmd("deploy way too early", 1000 - 31 * 60),
    cmd("deploy after", 1000 + 60),
  ]);
  const got = getCommandsNearCommit(commit(1000), 30).map((r) => r.command);
  expect(got).toEqual(["deploy before"]);
});

test("resolveCommit returns most recent, null when unknown", () => {
  initDb(dbPath());
  expect(resolveCommit(HASH)).toBeNull();
  bulkInsertCommits([
    { hash: HASH, repoPath: "/r", message: "old", authorTs: 1, filesChanged: [] },
    { hash: HASH, repoPath: "/s", message: "new", authorTs: 2, filesChanged: [] },
  ]);
  expect(resolveCommit(HASH)?.message).toBe("new");
  expect(resolveCommit("junk")).toBeNull();
});

test("formatCommitStory labels sections and handles empty window", () => {
  initDb(dbPath());
  const empty = formatCommitStory(commit(1000), [], null);
  expect(empty).toContain("commit ccccccc");
  expect(empty).toContain("no indexed commands");
  expect(empty).not.toContain("time-only");
  bulkInsert([cmd("deploy x", 999)]);
  const [row] = getCommandsNearCommit(commit(1000), 30);
  const full = formatCommitStory(commit(1000), row ? [row] : [], "stat here");
  expect(full).toContain("## Diff stat");
  expect(full).toContain("deploy x");
  // No repo-tracked rows yet → honest time-only caveat.
  expect(full).toContain("time-only match");
  expect(full).toContain("## What changed");
  expect(full).toContain("│ a.ts");
});

test("same-repo commands sort first and lift the caveat", () => {
  initDb(dbPath());
  bulkInsert([cmd("other repo cmd", 999), cmd("same repo cmd", 998)]);
  applyExitCodes(
    new Map([
      ["other repo cmd", { exit: 0, cwd: "/o", repo: "/o" }],
      ["same repo cmd", { exit: 0, cwd: "/r", repo: "/r" }],
    ])
  );
  const got = getCommandsNearCommit(commit(1000), 30).map((r) => r.command);
  expect(got).toEqual(["same repo cmd", "other repo cmd"]);
  const story = formatCommitStory(commit(1000), getCommandsNearCommit(commit(1000), 30), null);
  expect(story).toContain("ran in this repo");
});

test("explainLine blames a real file and rejects traversal", async () => {
  initDb(dbPath());
  const repo = join(dir, "repo");
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env as Record<string, string>, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "f.txt"), "one\ntwo\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env });
  Bun.spawnSync(["git", "commit", "-qm", "add f"], { cwd: repo, env });
  // Stale index: blame works, commit lookup misses with a clear signal.
  const stale = explainLine(repo, "f.txt", 1);
  expect(stale.blamedHash).toMatch(/^[0-9a-f]{40}$/);
  expect(stale.commit).toBeNull();
  // After indexing, the same line resolves fully.
  const { indexRepo } = await import("./gitIndexer.ts");
  indexRepo(repo);
  const fresh = explainLine(repo, "f.txt", 1);
  expect(fresh.commit?.message).toBe("add f");
  expect(explainLine(repo, "../evil.txt", 1)).toEqual({ blamedHash: null, commit: null });
});
