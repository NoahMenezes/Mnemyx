import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDb,
  closeDb,
  bulkInsert,
  bulkInsertCommits,
  applyExitCodes,
} from "./db.ts";
import {
  clusterSessions,
  getSession,
  formatSessions,
  formatSession,
  clampGapMinutes,
  DEFAULT_SESSION_GAP_MIN,
} from "./sessions.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-sess-test-"));
let n = 0;
const dbPath = (): string => join(dir, `t${n++}.db`);

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function cmd(
  command: string,
  timestamp: number,
  repo: string | null = null
): {
  command: string;
  timestamp: number;
  sourceFile: string;
  shell: "zsh";
  timestampApproximate: boolean;
} {
  return { command, timestamp, sourceFile: "/h", shell: "zsh", timestampApproximate: false };
}

function seed(commands: { command: string; timestamp: number; repo?: string | null }[]): void {
  bulkInsert(commands.map((c) => cmd(c.command, c.timestamp)));
  const outcomes = new Map(
    commands
      .filter((c) => c.repo !== undefined)
      .map((c) => [c.command, { exit: 0, cwd: c.repo as string, repo: c.repo as string }] as [string, { exit: number; cwd: string; repo: string }])
  );
  if (outcomes.size > 0) applyExitCodes(outcomes);
}

test("clampGapMinutes bounds wild input", () => {
  expect(clampGapMinutes(30)).toBe(30);
  expect(clampGapMinutes(0)).toBe(1);
  expect(clampGapMinutes(9999)).toBe(180);
  expect(clampGapMinutes(NaN)).toBe(DEFAULT_SESSION_GAP_MIN);
});

test("time gap splits sessions; tight bursts stay together", () => {
  initDb(dbPath());
  seed([
    { command: "deploy one", timestamp: 1000 },
    { command: "deploy two", timestamp: 1000 + 10 * 60 },
    { command: "deploy three", timestamp: 1000 + 60 * 60 },
  ]);
  const sessions = clusterSessions({ gapMinutes: 30 });
  expect(sessions).toHaveLength(2);
  // Newest first; older session holds the two tight commands (story order).
  expect(sessions[0]?.commands.map((c) => c.command)).toEqual(["deploy three"]);
  expect(sessions[1]?.commands.map((c) => c.command)).toEqual(["deploy one", "deploy two"]);
});

test("repo change splits even without a time gap; NULL inherits", () => {
  initDb(dbPath());
  seed([
    { command: "work a1", timestamp: 1000, repo: "/a" },
    { command: "work b1", timestamp: 1001, repo: "/b" },
    { command: "legacy cmd", timestamp: 1002 },
  ]);
  const sessions = clusterSessions({ gapMinutes: 30 });
  // /a | /b+NULL(null inherits running session)
  expect(sessions).toHaveLength(2);
  expect(sessions[0]?.commands.map((c) => c.command)).toEqual(["work b1", "legacy cmd"]);
  expect(sessions[0]?.repo).toBe("/b");
  expect(sessions[0]?.mixed).toBe(false);
});

test("mixed repos across a gap label honestly", () => {
  initDb(dbPath());
  seed([
    { command: "work a1", timestamp: 1000, repo: "/a" },
    // Same session (tight), different repo — can't happen via repo-split,
    // so force via NULL bridge: gap keeps them apart instead. Two sessions.
    { command: "work b1", timestamp: 1000 + 60 * 60, repo: "/b" },
  ]);
  const sessions = clusterSessions({ gapMinutes: 30 });
  expect(sessions).toHaveLength(2);
  expect(sessions.map((s) => s.mixed)).toEqual([false, false]);
});

test("onlyRepo restricts strictly; boost sorts scoped first", () => {
  initDb(dbPath());
  seed([
    { command: "cmd in a", timestamp: 1000, repo: "/a" },
    { command: "cmd in b", timestamp: 2000, repo: "/b" },
  ]);
  const strict = clusterSessions({ gapMinutes: 30, repo: "/a", onlyRepo: true });
  expect(strict).toHaveLength(1);
  expect(strict[0]?.repo).toBe("/a");
  const boosted = clusterSessions({ gapMinutes: 30, repo: "/b" });
  expect(boosted).toHaveLength(2);
  expect(boosted[0]?.repo).toBe("/b");
});

test("sinceDays bounds the window with injectable clock", () => {
  initDb(dbPath());
  seed([
    { command: "old cmd", timestamp: 1000 },
    { command: "new cmd", timestamp: 1000 + 10 * 86400 },
  ]);
  const all = clusterSessions({ gapMinutes: 30, nowSec: 1000 + 10 * 86400 });
  expect(all.length).toBeGreaterThanOrEqual(1);
  const recent = clusterSessions({ gapMinutes: 30, sinceDays: 2, nowSec: 1000 + 10 * 86400 });
  expect(recent.flatMap((s) => s.commands.map((c) => c.command))).toEqual(["new cmd"]);
});

test("getSession round-trips list ids; bad ids miss cleanly", () => {
  initDb(dbPath());
  seed([{ command: "solo cmd", timestamp: 5000 }]);
  const [listed] = clusterSessions({ gapMinutes: 30 });
  expect(listed).toBeDefined();
  const found = getSession(listed?.id ?? "", { gapMinutes: 30 });
  expect(found?.id).toBe(listed?.id);
  expect(found?.commands.map((c) => c.command)).toEqual(["solo cmd"]);
  expect(getSession("s0-nope")).toBeNull();
  expect(getSession("")).toBeNull();
  expect(formatSession(null)).toContain("list_sessions");
});

test("commits in the window attach same-repo first", () => {
  initDb(dbPath());
  seed([
    { command: "ship one", timestamp: 1999, repo: "/r" },
    { command: "ship it", timestamp: 2000, repo: "/r" },
  ]);
  bulkInsertCommits([
    { hash: "a".repeat(40), repoPath: "/other", message: "unrelated", authorTs: 1999, filesChanged: [] },
    { hash: "b".repeat(40), repoPath: "/r", message: "the fix", authorTs: 2000, filesChanged: ["x.ts"] },
  ]);
  const [s] = clusterSessions({ gapMinutes: 30 });
  expect(s?.commits.map((c) => c.hash)).toEqual(["b".repeat(40), "a".repeat(40)]);
});

test("top tokens ignore ANSI escape fragments", () => {
  initDb(dbPath());
  seed([{ command: "\x1b[32mgreen deploy", timestamp: 9000, repo: "/r" }]);
  const [s] = clusterSessions({ gapMinutes: 30 });
  expect(s?.topTokens.map((t) => t.token)).toEqual(["green"]);
});

test("session ids are content-derived and stable", () => {
  initDb(dbPath());
  seed([{ command: "stable cmd", timestamp: 7000, repo: "/my-proj" }]);
  const [s] = clusterSessions({ gapMinutes: 30 });
  expect(s?.id).toBe("s7000-my-proj");
});

test("tables render: bordered list, detail sections, raw pipes", async () => {
  initDb(dbPath());
  expect(formatSessions([])).toContain("No sessions");
  seed([
    { command: "echo 'a|b' multiline", timestamp: 8000, repo: "/r" },
    { command: "git commit -m fix", timestamp: 8100, repo: "/r" },
  ]);
  applyExitCodes(new Map([["git commit -m fix", { exit: 1 }]]));
  const sessions = clusterSessions({ gapMinutes: 30 });
  expect(sessions).toHaveLength(1);
  const list = formatSessions(sessions);
  expect(list).toContain("│ Session");
  // Border integrity: every table line shares one display width, and the
  // literal pipe in the command surfaces raw inside its bordered row.
  const { dispWidth } = await import("./db.ts");
  const boxLines = list.split("\n").filter((l) => l.startsWith("┌") || l.startsWith("│") || l.startsWith("├") || l.startsWith("└"));
  expect(new Set(boxLines.map((l) => dispWidth(l))).size).toBe(1);
  const detail = formatSession(sessions[0] ?? null);
  const cmdRow = detail.split("\n").find((l) => l.includes("echo"));
  expect(cmdRow).toContain("a|b");
  expect(detail).toContain("## Session");
  expect(detail).toContain("### Commands");
  expect(detail).toContain("### Commits");
  expect(detail).toContain("oldest first");
});
