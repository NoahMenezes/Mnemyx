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

test("unreadable path (a directory) parses to empty without throwing", () => {
  expect(parseExitLog("/tmp").size).toBe(0);
});
