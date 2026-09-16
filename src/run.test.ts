import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-run-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

async function runCli(home: string, args: string[]): Promise<{ exit: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: home } as Record<string, string>,
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, out, err };
}

function mkHome(): string {
  return mkdtempSync(join(dir, "home-"));
}

test("run passes through exit codes and stderr", async () => {
  const home = mkHome();
  const ok = await runCli(home, ["run", "--", "sh", "-c", "exit 0"]);
  expect(ok.exit).toBe(0);
  const fail = await runCli(home, ["run", "--", "sh", "-c", "echo oops-err 1>&2; exit 3"]);
  expect(fail.exit).toBe(3);
  expect(fail.err).toContain("oops-err");
  const log = join(home, ".mnemyx", "exit-codes.log");
  expect(existsSync(log)).toBe(true);
  const lines = readFileSync(log, "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  const last = JSON.parse(lines[1] as string) as { exit: unknown; cmd: unknown; err: unknown; cwd: unknown };
  expect(last.exit).toBe(3);
  expect(last.cmd).toBe("mnemyx run -- sh -c echo oops-err 1>&2; exit 3");
  expect(last.err).toContain("oops-err");
  expect(typeof last.cwd).toBe("string");
});

test("run without a command is a usage error", async () => {
  const home = mkHome();
  const r = await runCli(home, ["run"]);
  expect(r.exit).toBe(2);
  expect(r.err).toContain("usage");
});

test("run of a missing binary exits 127 without a log line", async () => {
  const home = mkHome();
  const r = await runCli(home, ["run", "--", "mnemyx-definitely-missing-bin"]);
  expect(r.exit).toBe(127);
  expect(existsSync(join(home, ".mnemyx", "exit-codes.log"))).toBe(false);
});
