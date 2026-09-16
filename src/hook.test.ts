import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  zshSnippet,
  bashSnippet,
  detectShell,
  rcPath,
  hookInstalled,
  hookOutdated,
  upgradeHook,
  installHook,
  HOOK_BEGIN,
  HOOK_END,
  HOOK_VERSION_TAG,
} from "./hook.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-hook-test-"));

test("snippets are self-contained blocks with begin/end markers", () => {
  for (const s of [zshSnippet(), bashSnippet()]) {
    expect(s).toContain(HOOK_BEGIN);
    expect(s).toContain(HOOK_END);
    expect(s).toContain("exit-codes.log");
    expect(s).toContain("python3");
    expect(s).toContain('return "$code"');
  }
  expect(zshSnippet()).toContain("precmd");
  expect(zshSnippet()).toContain("fc -ln -1");
  expect(bashSnippet()).toContain("PROMPT_COMMAND");
  expect(bashSnippet()).toContain("history 1");
});

test("v2 snippets capture cwd+repo and carry the version tag", () => {
  for (const s of [zshSnippet(), bashSnippet()]) {
    expect(s).toContain(HOOK_VERSION_TAG);
    expect(s).toContain("MNEMYX_CWD");
    expect(s).toContain("MNEMYX_REPO");
    expect(s).toContain("git rev-parse --show-toplevel");
    expect(s).toContain('"cwd"');
    expect(s).toContain('"repo"');
  }
});

test("hookOutdated detects v1 blocks, upgradeHook replaces in place", () => {
  const rc = join(dir, ".zshrc-v1");
  // Simulate a v1 install: same markers, no version tag, user content kept.
  writeFileSync(
    rc,
    `export PATH=/x\n${HOOK_BEGIN}: old header\nold body\n${HOOK_END}\n`
  );
  expect(hookInstalled(rc)).toBe(true);
  expect(hookOutdated(rc)).toBe(true);
  expect(upgradeHook(rc, "zsh").upgraded).toBe(true);
  const content = readFileSync(rc, "utf8");
  expect(content.startsWith("export PATH=/x\n")).toBe(true);
  expect(content).toContain(HOOK_VERSION_TAG);
  expect(content).toContain("MNEMYX_CWD");
  expect(content).not.toContain("old body");
  // Second run is a no-op.
  expect(hookOutdated(rc)).toBe(false);
  expect(upgradeHook(rc, "zsh").upgraded).toBe(false);
  // No block / missing file: nothing to upgrade.
  expect(upgradeHook(join(dir, "missing-rc"), "zsh").upgraded).toBe(false);
  const plain = join(dir, "plain-rc");
  writeFileSync(plain, "export A=1\n");
  expect(hookOutdated(plain)).toBe(false);
  expect(upgradeHook(plain, "zsh").upgraded).toBe(false);
});

test("detectShell honors override, then $SHELL, null when unrecognized", () => {
  expect(detectShell("bash")).toBe("bash");
  expect(detectShell("zsh")).toBe("zsh");
  const saved = process.env.SHELL;
  try {
    process.env.SHELL = "/bin/bash";
    expect(detectShell()).toBe("bash");
    process.env.SHELL = "/bin/zsh";
    expect(detectShell()).toBe("zsh");
    process.env.SHELL = "/usr/bin/fish";
    expect(detectShell()).toBeNull();
    process.env.SHELL = "/bin/dash";
    expect(detectShell()).toBeNull();
    delete process.env.SHELL;
    expect(detectShell()).toBe("zsh");
  } finally {
    if (saved === undefined) delete process.env.SHELL;
    else process.env.SHELL = saved;
  }
});

test("rcPath resolves per shell under the given home", () => {
  expect(rcPath("zsh", "/tmp/h")).toBe("/tmp/h/.zshrc");
  expect(rcPath("bash", "/tmp/h")).toBe("/tmp/h/.bashrc");
});

test("installHook appends once, detects install, preserves content", () => {
  const rc = join(dir, ".zshrc");
  writeFileSync(rc, "export PATH=/x\n"); // no trailing newline
  expect(hookInstalled(rc)).toBe(false);
  expect(installHook(rc, "zsh", dir).written).toBe(true);
  const content = readFileSync(rc, "utf8");
  expect(content.startsWith("export PATH=/x\n")).toBe(true);
  expect(hookInstalled(rc)).toBe(true);
  expect(installHook(rc, "zsh", dir).written).toBe(false);
  const count =
    content.split("\n").filter((l) => l.includes("precmd")).length;
  expect(count).toBeGreaterThan(0);
  // Rerun adds zero bytes.
  const before = readFileSync(rc, "utf8").length;
  installHook(rc, "zsh", dir);
  expect(readFileSync(rc, "utf8").length).toBe(before);
});

test("installHook creates a missing rc file and the .mnemyx dir", () => {
  const rc = join(dir, "sub", ".bashrc");
  expect(installHook(rc, "bash", dir).written).toBe(true);
  expect(hookInstalled(rc)).toBe(true);
});

test("installHook pre-creates the exit log owner-only", () => {
  const home = join(dir, "h2");
  const rc = join(home, ".zshrc");
  installHook(rc, "zsh", home);
  const logPath = join(home, ".mnemyx", "exit-codes.log");
  expect(statSync(logPath).size).toBe(0);
  expect(statSync(logPath).mode & 0o777).toBe(0o600);
});

// Cleanup after all hook tests in this file.
afterAll(() => rmSync(dir, { recursive: true, force: true }));
