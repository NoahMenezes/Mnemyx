import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, searchCommands } from "./db.ts";
import { filterByMaxAge, runImport } from "./import.ts";
import type { HistoryEntry } from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-import-test-"));
const paths = (tag: string): { db: string; cfg: string; log: string } => ({
  db: join(dir, `${tag}.db`),
  cfg: join(dir, `${tag}.config.json`),
  log: join(dir, `${tag}.exit.log`),
});

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function mk(command: string, timestamp: number): HistoryEntry {
  return {
    command,
    timestamp,
    sourceFile: "/tmp/fake/.zsh_history",
    shell: "zsh",
    timestampApproximate: false,
  };
}

const NOW = 2_000_000;

test("filterByMaxAge keeps recent, drops old, boundary inclusive", () => {
  const rows = [mk("new", NOW), mk("edge", NOW - 30 * 86400), mk("old", NOW - 31 * 86400)];
  expect(filterByMaxAge(rows, 30, NOW).map((r) => r.command)).toEqual([
    "new",
    "edge",
  ]);
});

test("filterByMaxAge: null/negative/NaN means unlimited; zero keeps only now", () => {
  const rows = [mk("a", NOW - 1), mk("b", NOW)];
  expect(filterByMaxAge(rows, null, NOW)).toHaveLength(2);
  expect(filterByMaxAge(rows, -5, NOW)).toHaveLength(2);
  expect(filterByMaxAge(rows, NaN, NOW)).toHaveLength(2);
  expect(filterByMaxAge(rows, 0, NOW).map((r) => r.command)).toEqual(["b"]);
});

test("runImport wires parse+filter+exit codes on explicit paths", async () => {
  const p = paths("wired");
  await Bun.write(
    p.cfg,
    JSON.stringify({ maxHistoryAgeDays: 30, exitCodes: true })
  );
  await Bun.write(
    p.log,
    '{"ts": 1, "exit": 0, "cmd": "deploy fresh"}\n'
  );
  const entries = [
    mk("deploy fresh", NOW),
    mk("deploy ancient", NOW - 400 * 86400),
  ];
  const r = runImport({
    dbPath: p.db,
    configPath: p.cfg,
    exitLogPath: p.log,
    entries,
    nowSec: NOW,
  });
  expect(r.parsed).toBe(2);
  expect(r.ageFilteredOut).toBe(1);
  expect(r.added).toBe(1);
  expect(r.exitCodesEnabled).toBe(true);
  expect(r.exitOutcomes).toBe(1);
  expect(r.exitUpdated).toBe(1);
  const [hit] = searchCommands("deploy fresh", 5);
  expect(hit?.exitCode).toBe(0);
  // Idempotent rerun: nothing new, no-op exit stamping.
  const r2 = runImport({
    dbPath: p.db,
    configPath: p.cfg,
    exitLogPath: p.log,
    entries,
    nowSec: NOW,
  });
  expect(r2.added).toBe(0);
  expect(r2.exitUpdated).toBe(0);
});

test("runImport with exitCodes:false ignores the log entirely", async () => {
  const p = paths("off");
  await Bun.write(p.cfg, JSON.stringify({ exitCodes: false }));
  await Bun.write(p.log, '{"ts": 1, "exit": 0, "cmd": "deploy x"}\n');
  const r = runImport({
    dbPath: p.db,
    configPath: p.cfg,
    exitLogPath: p.log,
    entries: [mk("deploy x", NOW)],
    nowSec: NOW,
  });
  expect(r.exitCodesEnabled).toBe(false);
  expect(r.exitOutcomes).toBe(0);
  expect(r.exitUpdated).toBe(0);
  const [hit] = searchCommands("deploy x", 5);
  expect(hit?.exitCode).toBeNull();
});
