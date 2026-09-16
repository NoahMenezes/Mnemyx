import { test, expect } from "bun:test";
import {
  loadConfig,
  firstToken,
  requireHome,
  DEFAULT_DENYLIST,
} from "./config.ts";

test("missing config file yields full defaults", () => {
  const cfg = loadConfig("/tmp/mnemyx-test-definitely-missing-12345.json");
  expect(cfg.embeddings).toBe(true);
  expect(cfg.exitCodes).toBe(true);
  expect(cfg.maxHistoryAgeDays).toBeNull();
  expect(cfg.denylist).toContain("ls");
  expect(cfg.denylist).toContain("clear");
  expect(DEFAULT_DENYLIST).toContain("cd");
});

test("user denylist extends built-ins, lowercased, blanks ignored", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-a.json`;
  await Bun.write(
    p,
    JSON.stringify({ denylist: ["Vim", "  HTOP  ", "", 42, null] })
  );
  try {
    const cfg = loadConfig(p);
    for (const w of ["vim", "htop", "ls", "cd"]) {
      expect(cfg.denylist).toContain(w);
    }
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("new keys parse; old denylist-only files stay compatible", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-b.json`;
  await Bun.write(p, JSON.stringify({ denylist: ["vim"] }));
  try {
    const cfg = loadConfig(p);
    expect(cfg.embeddings).toBe(true);
    expect(cfg.exitCodes).toBe(true);
    expect(cfg.maxHistoryAgeDays).toBeNull();
    expect(cfg.denylist).toContain("vim");
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("malformed values warn and fall back, never throw", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-c.json`;
  await Bun.write(
    p,
    JSON.stringify({
      denylist: "nope",
      embeddings: "yes",
      exitCodes: 1,
      maxHistoryAgeDays: -5,
    })
  );
  try {
    const cfg = loadConfig(p);
    expect(cfg.embeddings).toBe(true);
    expect(cfg.exitCodes).toBe(true);
    expect(cfg.maxHistoryAgeDays).toBeNull();
    expect(cfg.denylist).toContain("ls");
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
  const badPath = `/tmp/mnemyx-cfg-${process.pid}-d.json`;
  await Bun.write(badPath, "{not json");
  try {
    const cfg = loadConfig(badPath);
    expect(cfg.embeddings).toBe(true);
    expect(cfg.denylist).toContain("ls");
  } finally {
    await Bun.$`rm -f ${badPath}`.quiet();
  }
});

test("maxHistoryAgeDays accepts zero and floors fractions", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-e.json`;
  await Bun.write(p, JSON.stringify({ maxHistoryAgeDays: 30.9 }));
  try {
    expect(loadConfig(p).maxHistoryAgeDays).toBe(30);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("firstToken lowercases and takes the command name", () => {
  expect(firstToken("  GIT status")).toBe("git");
  expect(firstToken("ls -la /tmp")).toBe("ls");
  expect(firstToken("")).toBe("");
  expect(firstToken("   ")).toBe("");
});

test("requireHome prefers HOME, falls back, then throws actionably", () => {
  expect(requireHome({ HOME: "/tmp/x" })).toBe("/tmp/x");
  expect(requireHome({ HOME: "" }, () => "/fallback")).toBe("/fallback");
  expect(() =>
    requireHome({}, () => {
      throw new Error("no passwd entry");
    })
  ).toThrow(/set HOME/);
});
