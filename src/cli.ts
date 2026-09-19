#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// `mnemyx` setup CLI. Command implementations live in src/cli/* (one per
// file); this entry point only prints usage and dispatches. `bun run build`
// bundles this file to dist/cli.js — the installed `mnemyx` bin target — so
// keep this module free of src-relative path assumptions (see cli/shared.ts).
// ---------------------------------------------------------------------------
import { VERSION } from "./cli/shared.ts";
import { collectStatus, printStatus } from "./cli/status.ts";
import { cmdInit } from "./cli/init.ts";
import { cmdRun } from "./cli/run.ts";
import { cmdExport } from "./cli/exportCmd.ts";
import { cmdDashboard } from "./cli/dashboardCmd.ts";
import { cmdDoctor } from "./cli/doctor.ts";

function usage(): string {
  return `mnemyx v${VERSION} — searchable memory of your shell history (local-first)

Usage:
  mnemyx init [--yes] [--no-hook] [--shell zsh|bash]   First-time setup wizard
  mnemyx status                                        Health report (changes nothing)
  mnemyx doctor                                        Deployment self-check (bun, server entry, MCP handshake)
  mnemyx bench [--rows N] [--queries N] [--skip-semantic]  Synthetic perf baseline (temp DB, changes nothing)
  mnemyx run -- <cmd...>                               Run a command, log its exit + stderr tail locally
  mnemyx export (--session <id> | --commit <hash>) [--with-diff] [--out FILE] [--force]
                                                           Shareable redacted markdown (stdout, or FILE owner-only)
  mnemyx dashboard [--port 4877] [--no-open]               Local-only web UI (timeline, search, sessions)
  mnemyx --help | -h                                   This text
  mnemyx --version | -v                                Print version

Platforms:
  Linux / macOS — fully supported (zsh + bash).
  Windows — not natively supported; use WSL2 (Ubuntu) and follow the Linux steps.
  Commands are identical on every platform; only install paths differ (see README).

Run it:
  Linux/macOS (global install):  mnemyx status
  Linux/macOS (source checkout): bun run src/cli.ts status
  Windows (WSL2 Ubuntu):         wsl -- bun run src/cli.ts status

Docs: README "Platform support" + "CLI reference" (per-OS paths, hooks, examples).
Verify: mnemyx status && mnemyx doctor`;
}

// --- main -----------------------------------------------------------------------
async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === undefined || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(usage());
    return 0;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`mnemyx ${VERSION}`);
    return 0;
  }
  if (cmd === "status") {
    if (rest.length > 0) {
      console.error(`status takes no arguments (see mnemyx --help)`);
      return 2;
    }
    printStatus(collectStatus());
    return 0;
  }
  if (cmd === "init") {
    return await cmdInit(rest);
  }
  if (cmd === "doctor") {
    if (rest.length > 0) {
      console.error(`doctor takes no arguments (see mnemyx --help)`);
      return 2;
    }
    return await cmdDoctor();
  }
  if (cmd === "run") {
    return await cmdRun(rest);
  }
  if (cmd === "export") {
    return await cmdExport(rest);
  }
  if (cmd === "dashboard") {
    return await cmdDashboard(rest);
  }
  if (cmd === "bench") {    const { runBench, formatBench } = await import("./bench.ts");
    let rows: number | undefined;
    let queries: number | undefined;
    let skipSemantic = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--rows") rows = Number.parseInt(rest[++i] as string, 10);
      else if (a === "--queries") queries = Number.parseInt(rest[++i] as string, 10);
      else if (a === "--skip-semantic") skipSemantic = true;
      else {
        console.error(`unknown flag for bench: ${a} (see mnemyx --help)`);
        return 2;
      }
    }
    if (rows !== undefined && (!Number.isFinite(rows) || rows <= 0)) {
      console.error(`--rows expects a positive number`);
      return 2;
    }
    console.log(formatBench(await runBench({ rows, queries, skipSemantic })));
    return 0;
  }
  console.error(`unknown command: ${JSON.stringify(cmd)}\n\n${usage()}`);
  return 2;
}

// Entry guard: importing this module must never run the CLI.
if (import.meta.main) {
  const code = await main(Bun.argv.slice(2)).catch((err) => {
    console.error(`[mnemyx] fatal: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  });
  process.exit(code);
}
