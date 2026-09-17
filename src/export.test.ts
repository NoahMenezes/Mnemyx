import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initDb,
  closeDb,
  bulkInsert,
  bulkInsertCommits,
  applyExitCodes,
  dbPathFor,
} from "./db.ts";
import { clusterSessions } from "./sessions.ts";
import { buildSessionExport, buildStoryExport } from "./export.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-export-test-"));
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

async function runCli(home: string, args: string[]): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home } as Record<string, string>,
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out, err };
}

function mkHome(): string {
  return mkdtempSync(join(dir, "home-"));
}

function dbFor(home: string): string {
  return dbPathFor(process.platform, home, undefined);
}

// Builders take formatted text only: frontmatter + verbatim body,
// secrets already masked upstream.
test("buildSessionExport wraps detail with frontmatter, counts redactions", () => {
  const detail = "```text\n│ export AWS_SECRET=[redacted] │\n```";
  const { markdown, redactedCount } = buildSessionExport("s1-r", detail);
  expect(redactedCount).toBe(1);
  expect(markdown).toContain("source: mnemyx export (local-only,");
  expect(markdown).toContain("type: session s1-r");
  expect(markdown).toContain("secrets: masked (1 redaction)");
  expect(markdown).toContain(detail);
});

test("buildStoryExport reports zero redactions honestly", () => {
  const { markdown, redactedCount } = buildStoryExport("abc1234", "a".repeat(40), "## What changed");
  expect(redactedCount).toBe(0);
  expect(markdown).toContain("type: commit-story abc1234");
  expect(markdown).toContain("secrets: masked (0 redactions)");
});

// Seed a stub-HOME DB, return the HOME + one session id + one commit hash.
async function seedHome(): Promise<{ home: string; sessionId: string; hash: string }> {
  const home = mkHome();
  initDb(dbFor(home));
  bulkInsert([
    { command: "export AWS_SECRET=hunter2", timestamp: 1000, sourceFile: "/h", shell: "zsh", timestampApproximate: false },
    { command: "git commit -m ship", timestamp: 1100, sourceFile: "/h", shell: "zsh", timestampApproximate: false },
  ]);
  applyExitCodes(
    new Map([
      ["export AWS_SECRET=hunter2", { exit: 0, cwd: "/r", repo: "/r" }],
      ["git commit -m ship", { exit: 0, cwd: "/r", repo: "/r" }],
    ])
  );
  const hash = "d".repeat(40);
  bulkInsertCommits([{ hash, repoPath: "/r", message: "ship it", authorTs: 1200, filesChanged: ["a.ts"] }]);
  const [s] = clusterSessions({ gapMinutes: 30 });
  const sessionId = s?.id ?? "";
  expect(sessionId).not.toBe("");
  closeDb();
  return { home, sessionId, hash };
}

test("export --session prints redacted markdown to stdout", async () => {
  const { home, sessionId } = await seedHome();
  const r = await runCli(home, ["export", "--session", sessionId]);
  expect(r.exit).toBe(0);
  expect(r.out).toContain("source: mnemyx export");
  expect(r.out).toContain(`type: session ${sessionId}`);
  expect(r.out).toContain("[redacted]");
  expect(r.out).not.toContain("hunter2");
});

test("export --commit prints the story, secrets masked", async () => {
  const { home, hash } = await seedHome();
  const r = await runCli(home, ["export", "--commit", hash.slice(0, 7)]);
  expect(r.exit).toBe(0);
  expect(r.out).toContain("type: commit-story");
  expect(r.out).toContain("ship it");
  expect(r.out).not.toContain("hunter2");
});

test("export misuse exits 2; unknown ids exit 1 with hints", async () => {
  const { home } = await seedHome();
  expect((await runCli(home, ["export"])).exit).toBe(2);
  expect((await runCli(home, ["export", "--bogus"])).exit).toBe(2);
  const both = await runCli(home, ["export", "--session", "s1-x", "--commit", "abc1234"]);
  expect(both.exit).toBe(2);
  const wd = await runCli(home, ["export", "--session", "s1-x", "--with-diff"]);
  expect(wd.exit).toBe(2);
  const missSession = await runCli(home, ["export", "--session", "s0-nope"]);
  expect(missSession.exit).toBe(1);
  expect(missSession.err).toContain("list_sessions");
  const missCommit = await runCli(home, ["export", "--commit", "deadbee"]);
  expect(missCommit.exit).toBe(1);
  expect(missCommit.err).toContain("reindex");
});

test("export --out writes owner-only, refuses clobber without --force", async () => {
  const { home, sessionId } = await seedHome();
  const out = join(dir, `notes-${Date.now()}.md`);
  const first = await runCli(home, ["export", "--session", sessionId, "--out", out]);
  expect(first.exit).toBe(0);
  expect(first.out).toContain(`wrote ${out}`);
  expect(existsSync(out)).toBe(true);
  expect((statSync(out).mode & 0o777)).toBe(0o600);
  expect(readFileSync(out, "utf8")).toContain("source: mnemyx export");
  const second = await runCli(home, ["export", "--session", sessionId, "--out", out]);
  expect(second.exit).toBe(1);
  expect(second.err).toContain("--force");
  const forced = await runCli(home, ["export", "--session", sessionId, "--out", out, "--force"]);
  expect(forced.exit).toBe(0);
});

test("export --commit --with-diff masks secrets from a real diff", async () => {
  const home = mkHome();
  const repo = join(dir, `diffrepo-${Date.now()}`);
  mkdirSync(repo, { recursive: true });
  const env = { ...process.env as Record<string, string>, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t@t", GIT_COMMITTER_EMAIL: "t@t" };
  Bun.spawnSync(["git", "init", "-q"], { cwd: repo });
  writeFileSync(join(repo, "s.txt"), "a\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env });
  Bun.spawnSync(["git", "commit", "-qm", "base"], { cwd: repo, env });
  writeFileSync(join(repo, "s.txt"), "a\npassword=hunter2\n");
  Bun.spawnSync(["git", "add", "."], { cwd: repo, env });
  Bun.spawnSync(["git", "commit", "-qm", "oops"], { cwd: repo, env });
  const hash = String(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repo, stdout: "pipe" }).stdout).trim();
  initDb(dbFor(home));
  bulkInsertCommits([{ hash, repoPath: repo, message: "oops", authorTs: 2000, filesChanged: ["s.txt"] }]);
  closeDb();
  const r = await runCli(home, ["export", "--commit", hash, "--with-diff"]);
  expect(r.exit).toBe(0);
  expect(r.out).toContain("[redacted]");
  expect(r.out).not.toContain("hunter2");
  // Without --with-diff the preview is omitted (diffs eat context).
  const plain = await runCli(home, ["export", "--commit", hash]);
  expect(plain.exit).toBe(0);
  expect(plain.out).not.toContain("```diff");
});
