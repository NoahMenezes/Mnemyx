#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// `mnemyx` setup CLI. Command implementations live in src/cli/* (one per
// file); this entry point only prints usage and dispatches. The bin target
// (package.json) stays here, so installed `mnemyx` keeps working.
// ---------------------------------------------------------------------------
import { VERSION } from "./cli/shared.ts";
import { collectStatus, printStatus } from "./cli/status.ts";
import { cmdInit } from "./cli/init.ts";
import { cmdRun } from "./cli/run.ts";
import { cmdExport } from "./cli/exportCmd.ts";

function usage(): string {
  return `mnemyx v${VERSION} — searchable memory of your shell history (local-first)

Usage:
  mnemyx init [--yes] [--no-hook] [--shell zsh|bash]   First-time setup wizard
  mnemyx status                                        Health report (changes nothing)
  mnemyx bench [--rows N] [--queries N] [--skip-semantic]  Synthetic perf baseline (temp DB, changes nothing)
  mnemyx run -- <cmd...>                               Run a command, log its exit + stderr tail locally
  mnemyx export (--session <id> | --commit <hash>) [--with-diff] [--out FILE] [--force]
                                                           Shareable redacted markdown (stdout, or FILE owner-only)
  mnemyx --help | -h                                   This text
  mnemyx --version | -v                                Print version`;
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
  if (cmd === "run") {
    return await cmdRun(rest);
  }
  if (cmd === "export") {
    return await cmdExport(rest);
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
