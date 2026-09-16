import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverRepos,
  isGitRepo,
  MAX_SCAN_DEPTH,
  MAX_REPOS,
} from "./repoScanner.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-scan-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function mkRepo(p: string, gitAsFile = false): string {
  mkdirSync(p, { recursive: true });
  if (gitAsFile) {
    // Worktree/submodule style: .git is a file, not a dir.
    writeFileSync(join(p, ".git"), "gitdir: /elsewhere\n");
  } else {
    mkdirSync(join(p, ".git"), { recursive: true });
  }
  return p;
}

test("isGitRepo accepts .git dir and .git file, rejects others", () => {
  const a = mkRepo(join(dir, "repo-a"));
  const b = mkRepo(join(dir, "repo-b"), true);
  const plain = join(dir, "plain");
  mkdirSync(plain, { recursive: true });
  expect(isGitRepo(a)).toBe(true);
  expect(isGitRepo(b)).toBe(true);
  expect(isGitRepo(plain)).toBe(false);
  expect(isGitRepo(join(dir, "missing"))).toBe(false);
  const f = join(dir, "afile");
  writeFileSync(f, "x");
  expect(isGitRepo(f)).toBe(false);
});

test("discovers nested repos up to depth, skips node_modules and dot-dirs", () => {
  const root = join(dir, "root1");
  const r1 = mkRepo(join(root, "proj"));
  const r2 = mkRepo(join(root, "group", "nested"));
  // Too deep with maxDepth=1: root/group/nested is depth 2.
  expect(discoverRepos([root], { maxDepth: 1, home: dir }).sort()).toEqual([r1]);
  // Default depth finds both.
  expect(discoverRepos([root], { home: dir }).sort()).toEqual([r1, r2].sort());
  // node_modules never descended.
  const nmRepo = join(root, "node_modules", "hidden-repo");
  mkRepo(nmRepo);
  expect(discoverRepos([root], { home: dir })).not.toContain(nmRepo);
  // Hidden dirs never descended.
  const dotRepo = join(root, ".hidden", "repo");
  mkRepo(dotRepo);
  expect(discoverRepos([root], { home: dir })).not.toContain(dotRepo);
});

test("root that is itself a repo is included", () => {
  const root = mkRepo(join(dir, "selfrepo"));
  expect(discoverRepos([root], { home: dir })).toEqual([root]);
});

test("missing/unreadable roots and blanks never throw", () => {
  expect(discoverRepos([], { home: dir })).toEqual([]);
  expect(
    discoverRepos(["", "   ", join(dir, "nope-missing")], { home: dir })
  ).toEqual([]);
  // Fresh empty dir (shared `dir` accumulates repos from other tests).
  const empty = mkdtempSync(join(tmpdir(), "mnemyx-scan-empty-"));
  try {
    expect(discoverRepos([empty], { home: dir })).toEqual([]);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("overlapping roots dedupe, output sorted", () => {
  const root = join(dir, "root2");
  const b = mkRepo(join(root, "b"));
  const a = mkRepo(join(root, "a"));
  const got = discoverRepos([root, join(root, "a")], { home: dir });
  expect(got).toEqual([a, b]);
});

test("symlinked dirs are not followed (cycle guard)", () => {
  const root = join(dir, "root3");
  mkdirSync(root, { recursive: true });
  const real = mkRepo(join(root, "real"));
  try {
    symlinkSync(real, join(root, "link"));
  } catch {
    // Windows / restricted fs: symlinks unavailable — skip assertion.
    return;
  }
  const got = discoverRepos([root], { home: dir });
  expect(got).toEqual([real]);
});

test("maxRepos cap stops the scan", () => {
  const root = join(dir, "root4");
  for (let i = 0; i < 5; i++) mkRepo(join(root, `r${i}`));
  const got = discoverRepos([root], { home: dir, maxRepos: 2 });
  expect(got).toHaveLength(2);
});

test("scan depth constant is sane", () => {
  expect(MAX_SCAN_DEPTH).toBe(3);
  expect(MAX_REPOS).toBeGreaterThanOrEqual(50);
});
