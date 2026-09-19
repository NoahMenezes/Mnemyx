// ---------------------------------------------------------------------------
// `mnemyx doctor`: deployment self-check for end users.
//
// Answers the one question `status` can't: "will my AI client be able to
// spawn the server?" Checks bun resolution, server entry existence,
// page.html bundling, DB writability, config validity, and a real MCP
// stdio handshake — the exact thing that surfaces as
// `MCP error -32000: Connection closed` when broken.
// Exit 0 when the server is launchable, 1 otherwise.
// ---------------------------------------------------------------------------

import { existsSync } from "node:fs";
import { accessSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { VERSION, SERVER_PATH, BUN_BIN, BUN_BIN_OK, INSTALLED } from "./shared.ts";
import { getDefaultDbPath } from "../db.ts";
import { getConfigPath } from "../config.ts";
import { getHistoryFilePaths } from "../historyParser.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function handshake(timeoutMs = 15000): Promise<{ ok: boolean; detail: string }> {
  const init = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "mnemyx-doctor", version: VERSION } },
  });
  try {
    const proc = Bun.spawn([BUN_BIN, "run", SERVER_PATH], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.write(`${init}\n`);
    proc.stdin.flush();
    const out: string[] = [];
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }, timeoutMs);
    try {
      for await (const chunk of proc.stdout) {
        const text = new TextDecoder().decode(chunk);
        out.push(text);
        if (text.includes("serverInfo") && text.includes("mnemyx")) break;
      }
    } finally {
      clearTimeout(timer);
      try {
        proc.kill();
      } catch {
        // already exited
      }
    }
    const joined = out.join("");
    if (joined.includes("serverInfo") && joined.includes("mnemyx")) {
      return { ok: true, detail: "initialize → serverInfo mnemyx" };
    }
    return { ok: false, detail: `no serverInfo in handshake output (${joined.slice(0, 160) || "empty"})` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function cmdDoctor(): Promise<number> {
  const checks: Check[] = [];

  checks.push({
    name: "bun binary",
    ok: BUN_BIN_OK,
    detail: BUN_BIN_OK
      ? BUN_BIN
      : `${BUN_BIN} (NOT FOUND — GUI clients need the absolute path from \`which bun\`, usually ~/.bun/bin/bun)`,
  });

  const serverExists = existsSync(SERVER_PATH);
  checks.push({
    name: "server entry",
    ok: serverExists,
    detail: serverExists
      ? `${SERVER_PATH}${INSTALLED ? (isExecutable(SERVER_PATH) ? " (executable)" : " (not executable — reinstall)") : " (source checkout)"}`
      : `${SERVER_PATH} MISSING — ${INSTALLED ? "reinstall the package (global installs use dist/index.js, never src/index.ts)" : "are you in the right checkout?"}`,
  });

  if (INSTALLED) {
    const page = join(dirname(SERVER_PATH), "page.html");
    const pageOk = existsSync(page);
    checks.push({
      name: "dashboard page",
      ok: pageOk,
      detail: pageOk ? page : `${page} MISSING — dashboard will fail (rebuild/reinstall)`,
    });
  }

  try {
    const dbPath = getDefaultDbPath();
    const dir = join(dbPath, "..");
    const probe = join(dir, ".mnemyx-doctor-write-test");
    try {
      Bun.write(probe, "");
      const { rmSync } = await import("node:fs");
      rmSync(probe);
      checks.push({ name: "db writable", ok: true, detail: dir });
    } catch {
      checks.push({ name: "db writable", ok: false, detail: `${dir} not writable — fix permissions` });
    }
  } catch (err) {
    checks.push({ name: "db writable", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  try {
    const cfgPath = getConfigPath();
    const { loadConfig } = await import("../config.ts");
    loadConfig();
    checks.push({
      name: "config",
      ok: true,
      detail: existsSync(cfgPath) ? cfgPath : `${cfgPath} (absent — using built-ins, fine)`,
    });
  } catch (err) {
    checks.push({ name: "config", ok: false, detail: err instanceof Error ? err.message : String(err) });
  }

  const found = getHistoryFilePaths().filter((s) => existsSync(s.path));
  checks.push({
    name: "history files",
    ok: found.length > 0,
    detail: found.length > 0 ? found.map((s) => s.path).join(", ") : "no ~/.zsh_history or ~/.bash_history found — nothing to index",
  });

  // The load-bearing check: can this machine actually spawn the server?
  if (serverExists && BUN_BIN_OK) {
    const h = await handshake();
    checks.push({ name: "MCP handshake", ok: h.ok, detail: h.ok ? h.detail : `${h.detail} — this is what clients report as -32000` });
  } else {
    checks.push({ name: "MCP handshake", ok: false, detail: "skipped (bun or server entry missing)" });
  }

  console.log(`mnemyx doctor (v${VERSION})\n`);
  let failed = 0;
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    if (!c.ok) failed++;
  }
  if (failed === 0) {
    console.log(`\nAll checks pass. Register with: mnemyx init (then restart your client).`);
    return 0;
  }
  console.log(`\n${failed} check(s) failed. Fix above, then re-run: mnemyx init && mnemyx doctor (and restart your client).`);
  return 1;
}
