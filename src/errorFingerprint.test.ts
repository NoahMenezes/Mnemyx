import { test, expect } from "bun:test";
import { normalizeError, MAX_FINGERPRINT_CHARS, EXTRA_NORMALIZERS } from "./errorFingerprint.ts";

test("same Python exception from different paths groups together", () => {
  const a = 'Traceback (most recent call last):\n  File "/home/noah/a.py", line 10, in <module>\nValueError: bad literal';
  const b = 'Traceback (most recent call last):\n  File "/tmp/x/b.py", line 99, in main\nValueError: bad literal';
  expect(normalizeError(a)).toBe(normalizeError(b));
  expect(normalizeError(a)).toContain("ValueError");
});

test("different exception types do not group", () => {
  const a = "ValueError: bad";
  const b = "TypeError: bad";
  expect(normalizeError(a)).not.toBe(normalizeError(b));
});

test("Node stacks keep the head, drop jittering frames", () => {
  const a = "TypeError: x is not a function\n    at foo (/a/b.js:10:5)\n    at bar (/c.js:2:1)";
  const b = "TypeError: x is not a function\n    at foo (/x/y.js:99:9)";
  expect(normalizeError(a)).toBe(normalizeError(b));
});

test("Rust and Go panics keep the message, drop locations", () => {
  expect(normalizeError("thread 'main' panicked at 'index oob', src/main.rs:12:3")).toBe(
    normalizeError("thread 'main' panicked at 'index oob', src/other.rs:99:1")
  );
  expect(normalizeError("panic: kaboom\n goroutine 1 [running]:")).toContain("kaboom");
});

test("volatile details blanked: addresses, UUIDs, timestamps, pids, line numbers", () => {
  expect(normalizeError("fault at 0x7f3a2b1c")).toContain("<ADDR>");
  expect(normalizeError("id 550e8400-e29b-41d4-a716-446655440000 failed")).toContain("<ID>");
  expect(normalizeError("at 2026-09-16T10:53:22 boom")).toContain("<TS>");
  expect(normalizeError("died on pid 12345")).toContain("pid <N>");
  expect(normalizeError("app.py:123 exploded")).toContain("app.py:<N>");
});

test("secrets redacted before anything else (store-time policy)", () => {
  const fp = normalizeError("deploy failed with password=hunter2 at /home/u/x.py:1");
  expect(fp).not.toContain("hunter2");
  expect(fp).toContain("[redacted]");
});

test("total function: empty/hostile input, capped output", () => {
  expect(normalizeError("")).toBe("");
  expect(normalizeError("   ")).toBe("");
  expect(normalizeError("x".repeat(10000)).length).toBeLessThanOrEqual(MAX_FINGERPRINT_CHARS);
});

test("throwing custom normalizers never break indexing", () => {
  EXTRA_NORMALIZERS.push(() => {
    throw new Error("evil");
  });
  try {
    expect(normalizeError("plain error")).toContain("plain error");
  } finally {
    EXTRA_NORMALIZERS.pop();
  }
});
