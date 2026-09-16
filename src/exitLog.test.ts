import { test, expect } from "bun:test";
import { parseExitLog } from "./exitLog.ts";

test("missing log file parses to an empty map", () => {
  expect(
    parseExitLog("/tmp/mnemyx-test-missing-log-12345.log").size
  ).toBe(0);
});

test("later entries win; malformed lines are skipped", async () => {
  const p = `/tmp/mnemyx-exit-${process.pid}.log`;
  await Bun.write(
    p,
    [
      '{"ts": 100, "exit": 1, "cmd": "deploy alpha"}',
      "not json at all",
      '{"ts": 101, "exit": 0, "cmd": "deploy alpha"}',
      '{"exit": 2, "cmd": "deploy beta"}',
      '{"exit": 300, "cmd": "bad-range"}',
      '{"exit": -1, "cmd": "bad-negative"}',
      '{"exit": 1.5, "cmd": "bad-float"}',
      '{"exit": 0}',
      '{"exit": 0, "cmd": "   "}',
      "",
    ].join("\n")
  );
  try {
    const m = parseExitLog(p);
    expect(m.size).toBe(2);
    expect(m.get("deploy alpha")?.exit).toBe(0);
    expect(m.get("deploy alpha")?.timestamp).toBe(101);
    expect(m.get("deploy beta")?.exit).toBe(2);
    expect(m.has("bad-range")).toBe(false);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("v1 lines read cwd/repo as null; v2 lines parse them", async () => {
  const p = `/tmp/mnemyx-exit-v2-${process.pid}.log`;
  await Bun.write(
    p,
    [
      '{"ts": 100, "exit": 0, "cmd": "old cmd"}',
      '{"ts": 101, "exit": 0, "cmd": "new cmd", "cwd": "/home/u/proj", "repo": "/home/u/proj"}',
      '{"ts": 102, "exit": 1, "cmd": "outside repo", "cwd": "/tmp", "repo": ""}',
      '{"ts": 103, "exit": 0, "cmd": "junk ctx", "cwd": 42, "repo": null}',
    ].join("\n")
  );
  try {
    const m = parseExitLog(p);
    expect(m.get("old cmd")?.cwd).toBeNull();
    expect(m.get("old cmd")?.repo).toBeNull();
    expect(m.get("new cmd")?.cwd).toBe("/home/u/proj");
    expect(m.get("new cmd")?.repo).toBe("/home/u/proj");
    expect(m.get("outside repo")?.cwd).toBe("/tmp");
    expect(m.get("outside repo")?.repo).toBeNull();
    expect(m.get("junk ctx")?.cwd).toBeNull();
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("v3 lines parse stderr tails; blanks and junk read null", async () => {
  const p = `/tmp/mnemyx-exit-v3-${process.pid}.log`;
  await Bun.write(
    p,
    [
      '{"ts": 104, "exit": 1, "cmd": "boom", "err": "Traceback (most recent call last):\\nValueError: bad"}',
      '{"ts": 105, "exit": 0, "cmd": "fine", "err": ""}',
      '{"ts": 106, "exit": 1, "cmd": "junk", "err": 42}',
      '{"ts": 107, "exit": 1, "cmd": "v1style"}',
    ].join("\n")
  );
  try {
    const m = parseExitLog(p);
    expect(m.get("boom")?.stderr).toContain("ValueError: bad");
    expect(m.get("fine")?.stderr).toBeNull();
    expect(m.get("junk")?.stderr).toBeNull();
    expect(m.get("v1style")?.stderr).toBeNull();
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("oversized stderr keeps the tail (exception last), capped", async () => {
  const p = `/tmp/mnemyx-exit-v3cap-${process.pid}.log`;
  const head = "noise\n".repeat(2000);
  await Bun.write(
    p,
    JSON.stringify({ ts: 1, exit: 1, cmd: "big", err: `${head}FINAL: kaboom` })
  );
  try {
    const err = parseExitLog(p).get("big")?.stderr ?? "";
    expect(err.length).toBeLessThanOrEqual(2000);
    expect(err).toContain("FINAL: kaboom");
    // Tail kept (dropped ~10k of head), starts on a line boundary.
    expect(err.startsWith("noise")).toBe(true);
    expect(err.length).toBeLessThan(`${head}FINAL: kaboom`.length);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("oversized cwd values are capped, not stored whole", async () => {
  const p = `/tmp/mnemyx-exit-v2cap-${process.pid}.log`;
  await Bun.write(
    p,
    JSON.stringify({ ts: 1, exit: 0, cmd: "big", cwd: "/x".padEnd(5000, "y") })
  );
  try {
    const cwd = parseExitLog(p).get("big")?.cwd ?? "";
    expect(cwd.length).toBeLessThanOrEqual(1024);
  } finally {
    await Bun.$`rm -f ${p}`.quiet();
  }
});

test("unreadable path (a directory) parses to empty without throwing", () => {
  expect(parseExitLog("/tmp").size).toBe(0);
});
