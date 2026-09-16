#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Phase 5: `mnemyx` setup CLI. `mnemyx init` walks a new user through import,
// shell-hook install (explicit consent only — never silent), and MCP client
// registration. `mnemyx status` reports health without changing anything.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runImport } from "./import.ts";
import { getHistoryFilePaths } from "./historyParser.ts";
import { getExitLogPath } from "./exitLog.ts";
import { loadConfig, getConfigPath } from "./config.ts";
import {
  detectShell,
  rcPath,
  hookInstalled,
  hookOutdated,
  upgradeHook,
  installHook,
} from "./hook.ts";
import {
  backfillMissingEmbeddings,
  EMBEDDING_MODEL_ID,
  getModelCacheDir,
} from "./embeddings.ts";
import { getDefaultDbPath } from "./db.ts";
import { discoverReposFromConfig } from "./repoScanner.ts";
import packageJson from "../package.json" with { type: "json" };

const VERSION: string = packageJson.version;
const SERVER_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const BUN_BIN = Bun.which("bun") ?? "bun";

// --- Small helpers -----------------------------------------------------------
function home(): string {
  return process.env.HOME || homedir();
}

function usage(): string {
  return `mnemyx v${VERSION} — searchable memory of your shell history (local-first)

Usage:
  mnemyx init [--yes] [--no-hook] [--shell zsh|bash]   First-time setup wizard
  mnemyx status                                        Health report (changes nothing)
  mnemyx bench [--rows N] [--queries N] [--skip-semantic]  Synthetic perf baseline (temp DB, changes nothing)
  mnemyx --help | -h                                   This text
  mnemyx --version | -v                                Print version`;
}

async function ask(promptText: string): Promise<boolean> {
  process.stdout.write(`${promptText} [y/N] `);
  const line = await readStdinLine();
  const answer = (line ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes"; // EOF / anything else = No
}

// Free-text prompt (for choices). EOF resolves as "".
async function askText(promptText: string): Promise<string> {
  process.stdout.write(promptText);
  const line = await readStdinLine();
  return (line ?? "").trim();
}

// Line reader over raw stdin. Bun's node:readline/promises hangs on the
// SECOND sequential question() with piped stdin (verified empirically), so
// we buffer lines ourselves with a single listener. Works on TTYs (canonical
// line mode) and pipes alike; EOF resolves pending reads as null.
let stdinBuf = "";
let stdinDone = false;
let stdinHooked = false;
const lineWaiters: ((line: string | null) => void)[] = [];
const lineQueue: string[] = [];

function hookStdin(): void {
  if (stdinHooked) return;
  stdinHooked = true;
  if (process.stdin.readableEnded) {
    stdinDone = true;
    return;
  }
  process.stdin.on("data", (chunk: Buffer | string) => {
    stdinBuf += chunk.toString();
    let idx: number;
    while ((idx = stdinBuf.indexOf("\n")) >= 0) {
      const line = stdinBuf.slice(0, idx).replace(/\r$/, "");
      stdinBuf = stdinBuf.slice(idx + 1);
      const waiter = lineWaiters.shift();
      if (waiter) waiter(line);
      else lineQueue.push(line);
    }
  });
  const onEnd = (): void => {
    stdinDone = true;
    let waiter: ((line: string | null) => void) | undefined;
    while ((waiter = lineWaiters.shift())) waiter(null);
  };
  process.stdin.on("end", onEnd);
  process.stdin.on("close", onEnd);
}

function readStdinLine(): Promise<string | null> {
  hookStdin();
  const queued = lineQueue.shift();
  if (queued !== undefined) return Promise.resolve(queued);
  if (stdinDone) return Promise.resolve(null);
  return new Promise((resolve) => lineWaiters.push(resolve));
}

// --- status (read-only) -------------------------------------------------------
interface StatusInfo {
  dbPath: string;
  dbExists: boolean;
  commands: number;
  ftsDocs: number;
  vectors: number;
  commits: number;
  repos: number;
  modelId: string;
  configPath: string;
  hookRcFiles: string[];
  exitLogPath: string;
  exitLogLines: number;
}

function collectStatus(): StatusInfo {
  const dbPath = getDefaultDbPath();
  let commands = 0;
  let ftsDocs = 0;
  let vectors = 0;
  let commits = 0;
  // Repo discovery is a pure fs walk (no writes, no indexing) — cheap
  // enough for status, and it explains a commits:0 honestly.
  let repos = 0;
  try {
    repos = discoverReposFromConfig().length;
  } catch {
    repos = 0;
  }
  const dbExists = existsSync(dbPath);
  if (dbExists) {
    // Single read-only handle, no migrations: status must never modify.
    // (Migrations run on server/CLI import paths instead.)
    const db = new Database(dbPath, { readonly: true });
    try {
      commands = (db.query(`SELECT COUNT(*) AS n FROM commands;`).get() as { n: number }).n;
      const fts = db
        .query(`SELECT 1 FROM sqlite_master WHERE name = 'commands_fts_docsize';`)
        .get();
      ftsDocs =
        fts === undefined || fts === null
          ? -1 // pre-Phase-2 DB without FTS
          : (db.query(`SELECT COUNT(*) AS n FROM commands_fts_docsize;`).get() as { n: number }).n;
      try {
        vectors = (
          db.query(`SELECT COUNT(*) AS n FROM command_embeddings WHERE model = ?;`).get(EMBEDDING_MODEL_ID) as { n: number }
        ).n;
      } catch {
        vectors = 0; // pre-Phase-4 DB without the vector table
      }
      try {
        commits = (db.query(`SELECT COUNT(*) AS n FROM commits;`).get() as { n: number }).n;
      } catch {
        commits = 0; // pre-Phase-6 DB without the commits table
      }
    } finally {
      db.close();
    }
  }
  const cfg = loadConfig();
  const rcs = [join(home(), ".zshrc"), join(home(), ".bashrc")].filter(hookInstalled);
  const logPath = getExitLogPath();
  let exitLogLines = 0;
  if (existsSync(logPath)) {
    try {
      const content = readFileSync(logPath, "utf8");
      exitLogLines = content.split("\n").filter((l) => l.trim()).length;
    } catch {
      exitLogLines = -1;
    }
  }
  return {
    dbPath,
    dbExists,
    commands,
    ftsDocs,
    vectors,
    commits,
    repos,
    modelId: EMBEDDING_MODEL_ID,
    configPath: getConfigPath(),
    hookRcFiles: rcs,
    exitLogPath: logPath,
    exitLogLines,
  };
}

function printStatus(s: StatusInfo): void {
  const cfg = loadConfig();
  console.log(`mnemyx status (v${VERSION})\n`);
  console.log(`Database:  ${s.dbPath} ${s.dbExists ? "" : "(not created yet — run mnemyx init)"}`);
  if (s.dbExists) {
    const fts = s.ftsDocs < 0 ? "missing (pre-Phase-2 DB, rebuilt on next server start)" : `${s.ftsDocs} docs`;
    console.log(`  commands:   ${s.commands}`);
    console.log(`  FTS index:  ${fts}`);
    console.log(`  vectors:    ${s.vectors} (${s.modelId})`);
    console.log(`  commits:    ${s.commits} (git history, Phase 6)`);
    console.log(`  repos:      ${s.repos} discovered under repoRoots`);
  }
  console.log(`Config:    ${s.configPath} ${existsSync(s.configPath) ? "" : "(using built-ins)"}`);
  console.log(`  denylist: ${cfg.denylist.length} entries, embeddings: ${cfg.embeddings}, exit codes: ${cfg.exitCodes}, max age: ${cfg.maxHistoryAgeDays === null ? "unlimited" : `${cfg.maxHistoryAgeDays} days`}`);
  console.log(`Hook:      ${s.hookRcFiles.length > 0 ? `installed in ${s.hookRcFiles.join(", ")}` : "not installed (optional — see README)"}`);
  console.log(`Exit log:  ${existsSync(s.exitLogPath) ? `${s.exitLogLines} lines` : "absent"} (${s.exitLogPath})`);
  console.log(`History files:`);
  for (const src of getHistoryFilePaths()) {
    console.log(`  ${existsSync(src.path) ? "found  " : "missing"}  ${src.path} (${src.shell})`);
  }
  console.log(`Model cache: ${getModelCacheDir()} ${existsSync(getModelCacheDir()) ? "" : "(not downloaded yet)"}`);
}

// --- init ----------------------------------------------------------------------
interface InitFlags {
  yes: boolean;
  noHook: boolean;
  shell?: string;
}

// Preflight: warn (never fail, except Bun version above) about anything
// that degrades mnemyx on this machine. Each check is best-effort and
// exception-proof — a failing check must not break init itself.
function runPreflightWarnings(): void {
  const warn = (msg: string): void => console.log(`      (!) ${msg}`);
  try {
    // python3 powers the exit-code hook. This catches both "not installed"
    // and the macOS stub that pops a Command Line Tools dialog on first run.
    const py = Bun.spawnSync(["python3", "-c", "import json"]);
    if (py.exitCode !== 0) {
      warn(
        "python3 doesn't work — the optional exit-code hook needs it " +
          "(Linux: install python3; macOS: accept the Command Line Tools prompt, or brew install python3)"
      );
    }
  } catch {
    warn("could not probe python3 — the optional exit-code hook needs it");
  }
  try {
    // Native ONNX needs glibc >= 2.28; musl (Alpine) has no prebuild at all.
    // Either way semantic search degrades to keyword — this just explains it.
    if (process.platform === "linux") {
      const ldd = Bun.spawnSync(["ldd", "--version"]);
      const out = `${ldd.stdout}`.split("\n")[0] ?? "";
      if (/musl/i.test(out)) {
        warn(
          "musl libc detected (e.g. Alpine) — no ONNX prebuild exists, semantic search will use keyword fallback"
        );
      } else {
        const m = out.match(/(\d+)\.(\d+)/);
        if (m?.[1] !== undefined && m?.[2] !== undefined) {
          const major = Number.parseInt(m[1], 10);
          const minor = Number.parseInt(m[2], 10);
          if (major < 2 || (major === 2 && minor < 28)) {
            warn(
              `glibc ${major}.${minor} < 2.28 — no ONNX prebuild fits, semantic search will use keyword fallback`
            );
          }
        }
      }
    }
  } catch {
    // ldd missing (minimal containers) — skip silently, fallback covers it.
  }
  if (!Bun.which("bun")) {
    warn(
      "bun is not on PATH — GUI-launched clients (Claude Desktop) spawn with a minimal PATH; register them with the absolute bun path printed below"
    );
  }
  try {
    // Writability probe for the DB directory (read-only HOME, odd mounts).
    const probeDir = join(getDefaultDbPath(), "..");
    mkdirSync(probeDir, { recursive: true });
    const probe = join(probeDir, ".mnemyx-write-test");
    writeFileSync(probe, "");
    rmSync(probe);
  } catch {
    warn(
      `cannot write to the database directory (${join(getDefaultDbPath(), "..")}) — imports will fail until permissions are fixed`
    );
  }
}

function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = { yes: false, noHook: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") flags.yes = true;
    else if (a === "--no-hook") flags.noHook = true;
    else if (a === "--shell") {
      const v = args[i + 1];
      if (v !== "zsh" && v !== "bash") {
        throw new Error(`--shell expects "zsh" or "bash", got ${JSON.stringify(v)}`);
      }
      flags.shell = v;
      i++;
    } else {
      throw new Error(`unknown flag for init: ${a} (see mnemyx --help)`);
    }
  }
  return flags;
}

function registrationBlocks(): { title: string; body: string }[] {
  const serverCmd = `${BUN_BIN} run ${SERVER_PATH}`;
  const claudeDesktop = JSON.stringify(
    { mcpServers: { mnemyx: { command: BUN_BIN, args: ["run", SERVER_PATH] } } },
    null,
    2
  );
  return [
    {
      title: "Claude Code (terminal)",
      body: `  claude mcp add mnemyx -- ${serverCmd}`,
    },
    {
      title: "Claude Desktop (claude_desktop_config.json)",
      body: claudeDesktop
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n"),
    },
    {
      title: "Cursor (Settings → MCP → Add server, or .cursor/mcp.json)",
      body: `  command: ${BUN_BIN}\n  args: ["run", "${SERVER_PATH}"]`,
    },
  ];
}

async function cmdInit(rawArgs: string[]): Promise<number> {
  const flags = parseInitFlags(rawArgs);
  console.log(`mnemyx init — local-first shell-history search (v${VERSION})\n`);

  // 1. Environment: hard-fail only what cannot work; warn on the rest.
  const [bunMajor = 0, bunMinor = 0] = Bun.version
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  if (bunMajor < 1 || (bunMajor === 1 && bunMinor < 4)) {
    throw new Error(
      `mnemyx needs Bun >= 1.4 (found ${Bun.version}) — upgrade: curl -fsSL https://bun.sh/install | bash`
    );
  }
  console.log(`[1/4] Runtime: Bun ${Bun.version} ✓`);
  runPreflightWarnings();
    console.log(`      DB:      ${getDefaultDbPath()}`);
    console.log(`      Config:  ${getConfigPath()}\n`);

    // 2. Import.
    console.log(`[2/4] Indexing shell history (idempotent — safe to re-run)…`);
    const result = runImport();
    console.log(
      `      parsed ${result.parsed} commands, ${result.added} new, ${result.ageFilteredOut} skipped by age filter`
    );
    if (result.exitCodesEnabled && result.exitOutcomes > 0) {
      console.log(
        `      exit codes: ${result.exitUpdated} rows annotated from ${result.exitOutcomes} logged commands`
      );
    }
    const cfg = loadConfig();
    if (cfg.embeddings) {
      console.log(`      embedding new commands (one-time model download ~23MB on first run)…`);
      try {
        const { embedded } = await backfillMissingEmbeddings();
        console.log(`      vectors: +${embedded} new`);
      } catch (err) {
        console.log(
          `      embeddings unavailable this run (${err instanceof Error ? err.message : String(err)}) — keyword search works regardless`
        );
      }
    } else {
      console.log(`      embeddings disabled via config — keyword search only`);
    }
    console.log(`      indexing git history (local repos only, idempotent)…`);
    try {
      const { indexAllRepos } = await import("./gitIndexer.ts");
      const git = indexAllRepos();
      if (git.repos === 0) {
        console.log(`      commits: no repos under repoRoots — edit ~/.mnemyx/config.json to add some`);
      } else {
        console.log(
          `      commits: +${git.commitsAdded} new (${git.commitsSeen} seen across ${git.repos} repos${git.errors > 0 ? `, ${git.errors} skipped` : ""})`
        );
        for (const f of git.failures) {
          console.log(`        skipped ${f.repo}: ${f.reason}`);
        }
      }
    } catch (err) {
      console.log(
        `      git indexing skipped (${err instanceof Error ? err.message : String(err)}) — shell search works regardless`
      );
    }
    console.log();

    // 3. Shell hook (explicit consent, never silent).
    console.log(`[3/4] Exit-code hook (optional — distinguishes "tried" from "worked").`);
    if (flags.noHook) {
      console.log(`      skipped (--no-hook). Add it later from the README.\n`);
    } else {
      // Unrecognized $SHELL (fish, dash, …) resolves to null: never guess
      // which rc file to edit — ask, or skip (non-interactive safe default).
      let shell = detectShell(flags.shell);
      if (shell === null && !flags.yes) {
        const choice = await askText(
          `      Unrecognized shell (${process.env.SHELL || "unknown"}); mnemyx hooks support zsh/bash only. Which rc file? [zsh/bash/skip] `
        );
        const norm = choice.trim().toLowerCase();
        if (norm.startsWith("z")) shell = "zsh";
        else if (norm.startsWith("b")) shell = "bash";
      }
      if (shell === null) {
        console.log(`      skipped (unrecognized shell; hooks support zsh/bash — see README).\n`);
      } else {
        const rc = rcPath(shell);
        if (hookInstalled(rc) && !hookOutdated(rc)) {
          console.log(`      already installed in ${rc} — nothing to do.\n`);
        } else if (hookInstalled(rc) && hookOutdated(rc)) {
          // v1 block: still logs exits, but without cwd/repo context.
          // Upgrade replaces the block in place (consent-gated like install).
          console.log(`      A v1 hook is installed in ${rc} (logs exits, no directory context).`);
          console.log(`      Upgrading replaces that block with the v2 snippet (adds cwd + git repo per command).`);
          const ok = flags.yes || (await ask(`      Upgrade the ${shell} hook?`));
          if (ok) {
            upgradeHook(rc, shell);
            console.log(`      upgraded. Reload with: source ${rc}\n`);
          } else {
            console.log(`      kept v1. Upgrade later by re-running mnemyx init.\n`);
          }
        } else {
          console.log(`      This appends a ~20-line snippet to ${rc}.`);
          console.log(`      It logs {"ts","exit","cmd","cwd","repo"} lines to ~/.mnemyx/exit-codes.log — local only.`);
          const ok = flags.yes || (await ask(`      Install the ${shell} hook?`));
          if (ok) {
            installHook(rc, shell);
            console.log(`      installed. Reload with: source ${rc}\n`);
          } else {
            console.log(`      skipped. Add it later from the README.\n`);
          }
        }
      }
    }

    // 4. Client registration.
    console.log(`[4/4] Register with your AI client:\n`);
    for (const b of registrationBlocks()) {
      console.log(`  ${b.title}\n${b.body}\n`);
    }
    const claudeBin = Bun.which("claude");
    if (claudeBin) {
      const ok =
        flags.yes || (await ask(`Run "claude mcp add mnemyx" now?`));
      if (ok) {
        try {
          const proc = Bun.spawnSync([
            "claude",
            "mcp",
            "add",
            "mnemyx",
            "--",
            BUN_BIN,
            "run",
            SERVER_PATH,
          ]);
          const out = `${proc.stdout}`.trim();
          const errOut = `${proc.stderr}`.trim();
          if (proc.exitCode === 0) {
            console.log(`      registered with Claude Code. Verify with: claude mcp list`);
            if (out) console.log(`      ${out}`);
          } else {
            console.log(`      'claude mcp add' failed (exit ${proc.exitCode}). Run the command above manually.`);
            if (errOut) console.log(`      ${errOut}`);
          }
        } catch (err) {
          console.log(
            `      could not run claude (${err instanceof Error ? err.message : String(err)}). Run the command above manually.`
          );
        }
      }
    } else {
      console.log(`  (No 'claude' binary found — copy the block above for your client.)`);
    }

    console.log(`\nDone. Verify: ask your assistant to call get_recent_commands, or run: mnemyx status`);
    return 0;
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
  if (cmd === "bench") {
    const { runBench, formatBench } = await import("./bench.ts");
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
