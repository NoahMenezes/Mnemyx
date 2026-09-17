import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initDb,
  closeDb,
  bulkInsert,
  bulkInsertCommits,
  applyExitCodes,
  dbPathFor,
} from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-dash-test-"));
const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

let child: ReturnType<typeof Bun.spawn> | null = null;
let base = "";

afterAll(() => {
  try {
    child?.kill();
  } catch {
    // Already exited.
  }
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

async function waitFor(url: string, tries = 60): Promise<void> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) {
        await res.text();
        return;
      }
    } catch {
      // Not up yet.
    }
    await Bun.sleep(250);
  }
  throw new Error(`dashboard never came up at ${url}`);
}

// Seed a stub-HOME DB once, boot one dashboard subprocess for the file.
async function boot(): Promise<string> {
  if (base !== "") return base;
  const home = mkdtempSync(join(dir, "home-"));
  initDb(dbPathFor(process.platform, home, undefined));
  bulkInsert([
    { command: "export AWS_SECRET=hunter2", timestamp: 1000, sourceFile: "/h", shell: "zsh", timestampApproximate: false },
    { command: "git commit -m dashboard seed", timestamp: 1100, sourceFile: "/h", shell: "zsh", timestampApproximate: false },
  ]);
  applyExitCodes(
    new Map([
      ["export AWS_SECRET=hunter2", { exit: 0, cwd: "/r", repo: "/r" }],
      ["git commit -m dashboard seed", { exit: 0, cwd: "/r", repo: "/r" }],
    ])
  );
  bulkInsertCommits([
    { hash: "e".repeat(40), repoPath: "/r", message: "seed commit", authorTs: 1200, filesChanged: ["a.ts"] },
  ]);
  closeDb();
  const ports = [48799, 48809, 48819, 48829];
  for (const port of ports) {
    const proc = Bun.spawn(["bun", "run", CLI, "dashboard", "--port", String(port), "--no-open"], {
      cwd: dir,
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, HOME: home } as Record<string, string>,
    });
    try {
      await waitFor(`http://127.0.0.1:${port}/api/status`, 40);
      child = proc;
      base = `http://127.0.0.1:${port}`;
      return base;
    } catch {
      try {
        proc.kill();
      } catch {
        // Never started.
      }
    }
  }
  throw new Error("no free dashboard test port");
}

async function api(path: string, method = "GET"): Promise<{ status: number; body: string }> {
  const b = await boot();
  const res = await fetch(`${b}${path}`, { method });
  return { status: res.status, body: await res.text() };
}

test("status reports version and seeded counts", async () => {
  const { status, body } = await api("/api/status");
  expect(status).toBe(200);
  const s = JSON.parse(body) as { version: string; commands: number; commits: number };
  expect(typeof s.version).toBe("string");
  expect(s.commands).toBe(2);
  expect(s.commits).toBe(1);
});

test("search masks secrets, recent lists seeded rows", async () => {
  const found = JSON.parse((await api("/api/search?q=AWS_SECRET")).body) as {
    rows: { command: string }[];
  };
  expect(found.rows.length).toBeGreaterThan(0);
  expect(JSON.stringify(found)).toContain("[redacted]");
  expect(JSON.stringify(found)).not.toContain("hunter2");
  const recent = JSON.parse((await api("/api/recent?limit=5")).body) as {
    rows: unknown[];
  };
  expect(recent.rows).toHaveLength(2);
});

test("sessions list and detail round-trip", async () => {
  const list = JSON.parse((await api("/api/sessions?limit=10")).body) as {
    sessions: { id: string }[];
  };
  expect(list.sessions.length).toBeGreaterThan(0);
  const id = list.sessions[0]?.id as string;
  const detail = JSON.parse((await api(`/api/session?id=${encodeURIComponent(id)}`)).body) as {
    id: string;
    commands: unknown[];
  };
  expect(detail.id).toBe(id);
  expect(detail.commands.length).toBeGreaterThan(0);
  const missing = await api("/api/session?id=s0-nope");
  expect(missing.status).toBe(404);
});

test("commits and error search serve masked JSON", async () => {
  const commits = JSON.parse((await api("/api/commits?q=seed")).body) as {
    commits: { message: string }[];
  };
  expect(commits.commits[0]?.message).toContain("seed commit");
  const missing = await api("/api/commits");
  expect(missing.status).toBe(400);
});

test("unknown routes 404, non-GET 405, page serves HTML", async () => {
  expect((await api("/nope")).status).toBe(404);
  expect((await api("/api/search?q=x", "POST")).status).toBe(405);
  const page = await api("/");
  expect(page.status).toBe(200);
  expect(page.body).toContain("mnemyx dashboard");
  expect(page.body).toContain("<table");
});
