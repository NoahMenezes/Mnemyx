import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailWindow } from "./fsutil.ts";
import { afterAll } from "bun:test";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-fsutil-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("small files pass through whole", () => {
  const p = join(dir, "small.log");
  writeFileSync(p, "line1\nline2\n");
  expect(readTailWindow(p, 1024)).toBe("line1\nline2\n");
});

test("oversized files return the tail minus the leading fragment", () => {
  const p = join(dir, "big.log");
  // 10 full lines of 10 bytes each ("line0000\n" …), cap keeps last ~35 bytes.
  let content = "";
  for (let i = 0; i < 10; i++) content += `line${String(i).padStart(4, "0")}\n`;
  writeFileSync(p, content);
  const got = readTailWindow(p, 35);
  expect(got).not.toBeNull();
  // Must start at a line boundary (no fragment) and end with the file end.
  expect(got!).toMatch(/^(line\d+\n)+$/);
  expect(got!.endsWith("line0009\n")).toBe(true);
  expect(got!.length).toBeLessThanOrEqual(35);
  expect(got!).not.toContain("line0000");
});

test("missing/unreadable paths return null", () => {
  expect(readTailWindow(join(dir, "nope.log"), 100)).toBeNull();
  expect(readTailWindow(dir, 100)).toBeNull(); // a directory
});
