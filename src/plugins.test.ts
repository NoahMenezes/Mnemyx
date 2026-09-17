import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, bulkInsert, searchCommands } from "./db.ts";
import { runImport } from "./import.ts";
import {
  loadPluginEntries,
  parsePsqlHistory,
  getPluginsDir,
} from "./plugins.ts";
import type { HistoryEntry } from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-plugins-test-"));
let n = 0;

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function plugDir(tag: string): string {
  const d = join(dir, `plugins-${tag}-${n++}`);
  return mkdtempSync(d + "-");
}

function writePlugin(d: string, file: string, body: string, mode = 0o600): string {
  const p = join(d, file);
  writeFileSync(p, body);
  chmodSync(p, mode);
  return p;
}

const GOOD = `export default {
  name: "testplug",
  parse: () => [
    { command: "plugin cmd one", timestamp: 1000, sourceFile: "/origin", shell: "zsh" },
    { command: "   ", timestamp: 1001, sourceFile: "/origin", shell: "zsh" },
  ],
};`;

test("parsePsqlHistory keeps lines, flags approximate time", () => {
  const rows = parsePsqlHistory("select 1;\n\n  \\dt\n", "/h/.psql_history", 500);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({ command: "select 1;", timestamp: 500, timestampApproximate: true });
  expect(rows[1]?.shell).toBe("bash");
});

test("getPluginsDir resolves under home, empty without one", () => {
  expect(getPluginsDir("/home/u")).toBe(join("/home/u", ".mnemyx", "plugins"));
  expect(getPluginsDir("")).toBe("");
});

test("valid plugin loads with namespaced provenance", async () => {
  const d = plugDir("good");
  writePlugin(d, "a.mjs", GOOD);
  const r = await loadPluginEntries(d);
  expect(r.loaded).toEqual(["testplug"]);
  expect(r.skipped).toEqual([]);
  expect(r.entries).toHaveLength(1); // blank command dropped
  expect(r.entries[0]?.sourceFile).toBe("plugin:testplug:/origin");
});

test("throwing, shapeless, insecure, duplicate, non-js plugins skip safely", async () => {
  const d = plugDir("bad");
  writePlugin(d, "throw.mjs", `export default { name: "boom", parse() { throw new Error("kaput"); } };`);
  writePlugin(d, "shape.mjs", `export default { nope: 1 };`);
  writePlugin(d, "perms.mjs", GOOD.replace("testplug", "openplug"), 0o666);
  writePlugin(d, "dup-a.mjs", GOOD);
  writePlugin(d, "dup-b.mjs", GOOD);
  writeFileSync(join(d, "notes.txt"), "not a plugin");
  const r = await loadPluginEntries(d);
  // dup-a wins (sorted first), everything else skips; notes.txt ignored.
  expect(r.loaded).toEqual(["testplug"]);
  expect(r.skipped.length).toBeGreaterThanOrEqual(3);
  expect(r.skipped.map((s) => s.file).join(",")).toContain("throw.mjs");
});

test("disabled names skip silently; empty and missing dirs are empty", async () => {
  const d = plugDir("disabled");
  writePlugin(d, "a.mjs", GOOD);
  const off = await loadPluginEntries(d, ["testplug"]);
  expect(off.loaded).toEqual([]);
  expect(off.skipped).toEqual([]);
  expect(off.entries).toEqual([]);
  const empty = await loadPluginEntries(plugDir("empty"));
  expect(empty).toMatchObject({ entries: [], loaded: [], skipped: [] });
  const missing = await loadPluginEntries(join(dir, "no-such-dir"));
  expect(missing.entries).toEqual([]);
});

test("bad plugin names rejected", async () => {
  const d = plugDir("names");
  writePlugin(d, "a.mjs", `export default { name: "../evil", parse: () => [] };`);
  const r = await loadPluginEntries(d);
  expect(r.loaded).toEqual([]);
  expect(r.entries).toEqual([]);
});

function mk(command: string, timestamp: number): HistoryEntry {
  return { command, timestamp, sourceFile: "/tmp/fake/.zsh_history", shell: "zsh", timestampApproximate: false };
}

test("runImport merges plugin rows: searchable, namespaced, idempotent", async () => {
  const tag = `plug-import-${n++}`;
  const db = join(dir, `${tag}.db`);
  const cfg = join(dir, `${tag}.config.json`);
  writeFileSync(cfg, JSON.stringify({}));
  const pd = plugDir("import");
  writePlugin(pd, "a.mjs", GOOD);
  const opts = {
    dbPath: db,
    configPath: cfg,
    exitLogPath: join(dir, `${tag}.exit.log`),
    pluginsDir: pd,
    entries: [mk("plain cmd", 1000)],
    nowSec: 2000,
  };
  const r1 = await runImport(opts);
  expect(r1.pluginEntries).toBe(1);
  expect(r1.pluginsLoaded).toEqual(["testplug"]);
  expect(r1.added).toBe(2);
  const [hit] = searchCommands("plugin cmd one", 5);
  expect(hit?.sourceFile).toBe("plugin:testplug:/origin");
  const r2 = await runImport(opts);
  expect(r2.added).toBe(0);
  expect(r2.pluginEntries).toBe(1);
});

test("runImport with plugins:false ignores the dir entirely", async () => {
  const tag = `plug-off-${n++}`;
  const db = join(dir, `${tag}.db`);
  const cfg = join(dir, `${tag}.config.json`);
  writeFileSync(cfg, JSON.stringify({ plugins: false }));
  const pd = plugDir("off");
  writePlugin(pd, "a.mjs", GOOD);
  const r = await runImport({
    dbPath: db,
    configPath: cfg,
    exitLogPath: join(dir, `${tag}.exit.log`),
    pluginsDir: pd,
    entries: [mk("plain cmd", 1000)],
    nowSec: 2000,
  });
  expect(r.pluginEntries).toBe(0);
  expect(r.pluginsLoaded).toEqual([]);
  expect(searchCommands("plugin cmd one", 5)).toEqual([]);
});
