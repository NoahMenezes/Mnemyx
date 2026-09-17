import { test, expect } from "bun:test";
import {
  loadConfig,
  firstToken,
  requireHome,
  DEFAULT_DENYLIST,
  DEFAULT_REPO_ROOT_NAMES,
  MAX_REPO_ROOTS,
  expandRepoRoot,
  getDefaultRepoRoots,
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

test("repoRoots default to dev/projects/code/Desktop under HOME", () => {
  const cfg = loadConfig("/tmp/mnemyx-test-definitely-missing-12345.json");
  expect(DEFAULT_REPO_ROOT_NAMES).toEqual(["dev", "projects", "code", "Desktop"]);
  for (const name of DEFAULT_REPO_ROOT_NAMES) {
    expect(cfg.repoRoots.some((r) => r.endsWith(`/${name}`))).toBe(true);
  }
  expect(getDefaultRepoRoots("/home/u")).toEqual([
    "/home/u/dev",
    "/home/u/projects",
    "/home/u/code",
    "/home/u/Desktop",
  ]);
});

test("expandRepoRoot handles ~, absolute, relative, blanks", () => {
  expect(expandRepoRoot("~/dev", "/home/u")).toBe("/home/u/dev");
  expect(expandRepoRoot("~", "/home/u")).toBe("/home/u");
  expect(expandRepoRoot("/x/y", "/home/u")).toBe("/x/y");
  expect(expandRepoRoot("work", "/home/u")).toBe("/home/u/work");
  expect(expandRepoRoot("   ", "/home/u")).toBeNull();
});

test("user repoRoots replace defaults, expand, dedupe, drop junk", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-roots.json`;
  await Bun.write(
    p,
    JSON.stringify({
      repoRoots: ["~/dev", "/abs/path", "rel", "~/dev", "", 42, null],
    })
  );
  try {
    const cfg = loadConfig(p);
    expect(cfg.repoRoots).toContain(`${process.env.HOME}/dev`);
    expect(cfg.repoRoots).toContain("/abs/path");
    expect(cfg.repoRoots).toContain(`${process.env.HOME}/rel`);
    // Dedupe: ~/dev once.
    expect(cfg.repoRoots.filter((r) => r.endsWith("/dev"))).toHaveLength(1);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("malformed repoRoots warn and fall back to defaults, never throw", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-roots-bad.json`;
  await Bun.write(p, JSON.stringify({ repoRoots: "nope" }));
  try {
    const cfg = loadConfig(p);
    expect(cfg.repoRoots.length).toBeGreaterThan(0);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("repoRoots capped at MAX_REPO_ROOTS", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-roots-cap.json`;
  const many = Array.from({ length: MAX_REPO_ROOTS + 5 }, (_, i) => `/r${i}`);
  await Bun.write(p, JSON.stringify({ repoRoots: many }));
  try {
    expect(loadConfig(p).repoRoots).toHaveLength(MAX_REPO_ROOTS);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("ranking weights parse, partial allowed, malformed falls back", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-ranking.json`;
  await Bun.write(
    p,
    JSON.stringify({ ranking: { frequencyWeight: 2, recencyHalfLifeDays: 7 } })
  );
  try {
    const full = loadConfig(p);
    expect(full.ranking).toEqual({ frequencyWeight: 2, recencyWeight: 1.0, recencyHalfLifeDays: 7 });
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
  const q = `/tmp/mnemyx-cfg-${process.pid}-ranking-bad.json`;
  await Bun.write(q, JSON.stringify({ ranking: { frequencyWeight: "lots", recencyWeight: -1 } }));
  try {
    const bad = loadConfig(q);
    expect(bad.ranking.frequencyWeight).toBe(1.0);
    expect(bad.ranking.recencyWeight).toBe(1.0);
    expect(bad.ranking.recencyHalfLifeDays).toBe(30);
  } finally {
    await Bun.$`rm -f ${q}`.quiet();
  }
});

test("plugins flags parse, malformed falls back", async () => {
  const p = `/tmp/mnemyx-cfg-${process.pid}-plugins.json`;
  await Bun.write(p, JSON.stringify({ plugins: false, disabledPlugins: ["a", "", 42] }));
  try {
    const cfg = loadConfig(p);
    expect(cfg.plugins).toBe(false);
    expect(cfg.disabledPlugins).toEqual(["a"]);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
  const q = `/tmp/mnemyx-cfg-${process.pid}-plugins-bad.json`;
  await Bun.write(q, JSON.stringify({ plugins: "yes", disabledPlugins: "nope" }));
  try {
    const bad = loadConfig(q);
    expect(bad.plugins).toBe(true);
    expect(bad.disabledPlugins).toEqual([]);
  } finally {
    await Bun.$`rm -f ${q}`.quiet();
  }
});
