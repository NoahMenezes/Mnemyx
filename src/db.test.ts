import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  initDb,
  closeDb,
  insertCommand,
  bulkInsert,
  searchCommands,
  getRecentCommands,
  applyExitCodes,
  sortByOutcomeTier,
  storeEmbeddings,
  getEmbeddingCandidates,
  getCommandsMissingEmbeddings,
  getCommandsByIds,
  countEmbeddings,
  pruneStaleEmbeddings,
  type HistoryEntry,
} from "./db.ts";
import { EMBEDDING_DIMS } from "./embeddings.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-db-test-"));
let n = 0;
const dbPath = (): string => join(dir, `t${n++}.db`);

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function entry(command: string, timestamp = 1000): HistoryEntry {
  return {
    command,
    timestamp,
    sourceFile: "/tmp/fake/.zsh_history",
    shell: "zsh",
    timestampApproximate: false,
  };
}

function vec(fill: number): Float32Array {
  return new Float32Array(EMBEDDING_DIMS).fill(fill);
}

test("initDb creates schema with all columns + FTS table", () => {
  initDb(dbPath());
  const db = new Database(join(dir, `t${n - 1}.db`), { readonly: true });
  const cols = (
    db.query(`PRAGMA table_info(commands);`).all() as { name: string }[]
  ).map((c) => c.name);
  for (const c of [
    "id",
    "command",
    "timestamp",
    "source_file",
    "shell",
    "is_approximate_timestamp",
    "exit_code",
  ]) {
    expect(cols).toContain(c);
  }
  const fts = db
    .query(`SELECT 1 FROM sqlite_master WHERE name = 'commands_fts';`)
    .get();
  expect(fts).not.toBeNull();
  db.close();
});

test("bulkInsert is idempotent and counts exactly (FTS-trigger-proof)", () => {
  initDb(dbPath());
  const rows = [entry("deploy alpha", 1), entry("deploy beta", 2)];
  expect(bulkInsert(rows)).toBe(2);
  expect(bulkInsert(rows)).toBe(0);
  expect(bulkInsert([entry("deploy alpha", 1)])).toBe(0);
});

test("insertCommand inserts a single row", () => {
  initDb(dbPath());
  insertCommand(entry("mytestcmd --flag", 5));
  expect(searchCommands("mytestcmd", 5).map((r) => r.command)).toEqual([
    "mytestcmd --flag",
  ]);
});

test("fresh rows read back with exitCode null (unknown, not failure)", () => {
  initDb(dbPath());
  bulkInsert([entry("deploy alpha", 1)]);
  const [row] = searchCommands("deploy alpha", 5);
  expect(row?.exitCode).toBeNull();
  expect(row?.timestampApproximate).toBe(false);
});

test("FTS search: multi-word AND narrows, prefix matches", () => {
  initDb(dbPath());
  bulkInsert([
    entry("git commit -m fix", 1),
    entry("git push origin", 2),
    entry("docker ps --all", 3),
  ]);
  expect(searchCommands("git commit", 10).map((r) => r.command)).toEqual([
    "git commit -m fix",
  ]);
  expect(searchCommands("commi", 10).map((r) => r.command)).toEqual([
    "git commit -m fix",
  ]);
});

test("symbol-only query falls back to LIKE instead of returning nothing", () => {
  initDb(dbPath());
  bulkInsert([entry("run x && ok", 1), entry("plain command here", 2)]);
  expect(searchCommands("&&", 10).map((r) => r.command)).toEqual([
    "run x && ok",
  ]);
});

test("empty/blank query returns no rows", () => {
  initDb(dbPath());
  bulkInsert([entry("deploy alpha", 1)]);
  expect(searchCommands("   ", 10)).toEqual([]);
});

test("denylist filters bare noise from search and recents", () => {
  initDb(dbPath());
  bulkInsert([
    entry("ls", 3),
    entry("cd /tmp", 2),
    entry("deploy alpha", 1),
  ]);
  expect(getRecentCommands(10).map((r) => r.command)).toEqual([
    "deploy alpha",
  ]);
  expect(searchCommands("ls", 10)).toEqual([]);
});

test("applyExitCodes annotates, counts exactly, reruns as no-op", () => {
  initDb(dbPath());
  bulkInsert([entry("deploy alpha", 1), entry("deploy beta", 2)]);
  expect(
    applyExitCodes(
      new Map([
        ["deploy alpha", { exit: 0 }],
        ["deploy beta", { exit: 2 }],
        ["ghost cmd", { exit: 0 }],
      ])
    )
  ).toBe(2);
  expect(applyExitCodes(new Map([["deploy alpha", { exit: 0 }]]))).toBe(0);
  expect(applyExitCodes(new Map([["deploy alpha", { exit: 5 }]]))).toBe(1);
});

test("onlySuccessful filters to proven exit 0; tiers order success first", () => {
  initDb(dbPath());
  bulkInsert([
    entry("deploy alpha", 3),
    entry("deploy beta", 2),
    entry("deploy gamma", 1),
  ]);
  applyExitCodes(
    new Map([
      ["deploy alpha", { exit: 0 }],
      ["deploy beta", { exit: 3 }],
    ])
  );
  expect(searchCommands("deploy", 10).map((r) => r.command)).toEqual([
    "deploy alpha",
    "deploy gamma",
    "deploy beta",
  ]);
  expect(
    searchCommands("deploy", { onlySuccessful: true }).map((r) => r.command)
  ).toEqual(["deploy alpha"]);
});

test("sortByOutcomeTier is stable within tiers", () => {
  initDb(dbPath());
  bulkInsert([
    entry("deploy alpha", 1),
    entry("deploy beta", 2),
    entry("deploy gamma", 3),
  ]);
  applyExitCodes(new Map([["deploy beta", { exit: 1 }]]));
  const rows = getCommandsByIds([1, 2, 3]);
  const sorted = sortByOutcomeTier(rows).map((r) => r.command);
  // unknown (alpha, gamma, input order kept) before failure (beta)
  expect(sorted).toEqual(["deploy alpha", "deploy gamma", "deploy beta"]);
});

test("vector store round-trips bytes exactly; stale models prune", () => {
  initDb(dbPath());
  bulkInsert([entry("deploy alpha", 1), entry("deploy beta", 2)]);
  storeEmbeddings([1, 2], [vec(0.5), vec(2)], "model-a", EMBEDDING_DIMS);
  const got = getEmbeddingCandidates("model-a", false);
  expect(got).toHaveLength(2);
  expect(Array.from(got[0]?.embedding ?? [])).toEqual(Array.from(vec(0.5)));
  expect(countEmbeddings("model-a")).toBe(2);
  expect(countEmbeddings("model-b")).toBe(0);
  expect(pruneStaleEmbeddings("model-b")).toBe(2);
  expect(countEmbeddings("model-a")).toBe(0);
});

test("missing-embeddings pagination advances past stored rows", () => {
  initDb(dbPath());
  bulkInsert([
    entry("deploy a", 1),
    entry("deploy b", 2),
    entry("deploy c", 3),
    entry("deploy d", 4),
  ]);
  storeEmbeddings([2], [vec(1)], "m", EMBEDDING_DIMS);
  const page1 = getCommandsMissingEmbeddings("m", 2);
  expect(page1.map((r) => r.id)).toEqual([1, 3]);
  const page2 = getCommandsMissingEmbeddings("m", 2, 3);
  expect(page2.map((r) => r.id)).toEqual([4]);
  expect(getCommandsMissingEmbeddings("m", 10, 4)).toEqual([]);
});

test("getCommandsByIds fetches the requested set", () => {
  initDb(dbPath());
  bulkInsert([entry("deploy a", 1), entry("deploy b", 2)]);
  const rows = getCommandsByIds([2, 1, 999]);
  expect(rows.map((r) => r.command).sort()).toEqual(["deploy a", "deploy b"]);
  expect(getCommandsByIds([])).toEqual([]);
});
