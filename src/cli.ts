#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Phase 5: `mnemyx` setup CLI. `mnemyx init` walks a new user through import,
// shell-hook install (explicit consent only — never silent), and MCP client
// registration. `mnemyx status` reports health without changing anything.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";
import { runImport } from "./import.ts";
import { getHistoryFilePaths } from "./historyParser.ts";
import { getExitLogPath } from "./exitLog.ts";
import { loadConfig, getConfigPath } from "./config.ts";
import {
  backfillMissingEmbeddings,
  EMBEDDING_MODEL_ID,
  getModelCacheDir,
} from "./embeddings.ts";
import { getDefaultDbPath, initDb, closeDb, countEmbeddings } from "./db.ts";
import packageJson from "../package.json" with { type: "json" };

const VERSION: string = packageJson.version;
const SERVER_PATH = fileURLToPath(new URL("./index.ts", import.meta.url));
const BUN_BIN = Bun.which("bun") ?? "bun";

// --- Hook snippets (keep in sync with README) -------------------------------
const HOOK_BEGIN = "# --- Mnemyx (optional)";
const HOOK_END = "# --- end Mnemyx";
const HOOK_HEADER = `${HOOK_BEGIN}: log each command's exit code locally for shell-history search.
# Appends JSON lines to ~/.mnemyx/exit-codes.log. Nothing leaves your machine.
# Remove this block to disable.`;
const HOOK_PYTHON =
  `MNEMYX_CODE="$code" MNEMYX_CMD="$cmd" python3 -c ` +
  `'import json,os,time; print(json.dumps({"ts":int(time.time()),"exit":int(os.environ["MNEMYX_CODE"]),"cmd":os.environ["MNEMYX_CMD"]}))' ` +
  `>> "$HOME/.mnemyx/exit-codes.log" 2>/dev/null`;

function zshSnippet(): string {
  return `${HOOK_HEADER}
_mnemyx_precmd() {
  local code=$?
  local cmd
  cmd=$(fc -ln -1 2>/dev/null | sed -e 's/^[[:space:]]*//')
  if [ -n "$cmd" ]; then
    ${HOOK_PYTHON}
  fi
  return "$code"
}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _mnemyx_precmd
${HOOK_END}`;
}

function bashSnippet(): string {
  return `${HOOK_HEADER}
_mnemyx_prompt() {
  local code=$?
  local cmd
  cmd=$(history 1 2>/dev/null | sed -e 's/^[[:space:]]*[0-9]*[[:space:]]*//')
  if [ -n "$cmd" ]; then
    ${HOOK_PYTHON}
  fi
  return "$code"
}
if [[ "\${PROMPT_COMMAND:-}" != *"_mnemyx_prompt"* ]]; then
  PROMPT_COMMAND="_mnemyx_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
${HOOK_END}`;
}

// --- Small helpers -----------------------------------------------------------
function home(): string {
  return process.env.HOME || homedir();
}

function usage(): string {
  return `mnemyx v${VERSION} — searchable memory of your shell history (local-first)

Usage:
  mnemyx init [--yes] [--no-hook] [--shell zsh|bash]   First-time setup wizard
  mnemyx status                                        Health report (changes nothing)
  mnemyx --help | -h                                   This text
  mnemyx --version | -v                                Print version`;
}

async function ask(promptText: string): Promise<boolean> {
  process.stdout.write(`${promptText} [y/N] `);
  const line = await readStdinLine();
  const answer = (line ?? "").trim().toLowerCase();
  return answer === "y" || answer === "yes"; // EOF / anything else = No
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

function detectShell(override?: string): "zsh" | "bash" {
  if (override === "zsh" || override === "bash") return override;
  const base = basename(process.env.SHELL || "");
  return base === "bash" ? "bash" : "zsh"; // zsh default (macOS + common Linux)
}

function rcPath(shell: "zsh" | "bash"): string {
  return join(home(), shell === "zsh" ? ".zshrc" : ".bashrc");
}

function hookInstalled(rc: string): boolean {
  return existsSync(rc) && readFileSync(rc, "utf8").includes(HOOK_BEGIN);
}

// --- status (read-only) -------------------------------------------------------
interface StatusInfo {
  dbPath: string;
  dbExists: boolean;
  commands: number;
  ftsDocs: number;
  vectors: number;
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
  const dbExists = existsSync(dbPath);
  if (dbExists) {
    initDb(dbPath);
    try {
      const db = new Database(dbPath, { readonly: true });
      commands = (db.query(`SELECT COUNT(*) AS n FROM commands;`).get() as { n: number }).n;
      try {
        ftsDocs = (db.query(`SELECT COUNT(*) AS n FROM commands_fts_docsize;`).get() as { n: number }).n;
      } catch {
        ftsDocs = -1; // pre-Phase-2 DB without FTS
      }
      db.close();
      vectors = countEmbeddings(EMBEDDING_MODEL_ID);
    } finally {
      closeDb();
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

    // 1. Environment.
    const bunVersion = Bun.version;
    console.log(`[1/4] Runtime: Bun ${bunVersion} ✓ (need >= 1.4)`);
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
    console.log();

    // 3. Shell hook (explicit consent, never silent).
    console.log(`[3/4] Exit-code hook (optional — distinguishes "tried" from "worked").`);
    if (flags.noHook) {
      console.log(`      skipped (--no-hook). Add it later from the README.\n`);
    } else {
      const shell = detectShell(flags.shell);
      const rc = rcPath(shell);
      if (hookInstalled(rc)) {
        console.log(`      already installed in ${rc} — nothing to do.\n`);
      } else {
        console.log(`      This appends a ~15-line snippet to ${rc}.`);
        console.log(`      It logs {"ts","exit","cmd"} lines to ~/.mnemyx/exit-codes.log — local only.`);
        const ok = flags.yes || (await ask(`      Install the ${shell} hook?`));
        if (ok) {
          mkdirSync(join(home(), ".mnemyx"), { recursive: true });
          const snippet = shell === "zsh" ? zshSnippet() : bashSnippet();
          const prev = existsSync(rc) ? readFileSync(rc, "utf8") : "";
          const sep = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
          appendFileSync(rc, `${sep}\n${snippet}\n`);
          console.log(`      installed. Reload with: source ${rc}\n`);
        } else {
          console.log(`      skipped. Add it later from the README.\n`);
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
  console.error(`unknown command: ${JSON.stringify(cmd)}\n\n${usage()}`);
  return 2;
}

const code = await main(Bun.argv.slice(2)).catch((err) => {
  console.error(`[mnemyx] fatal: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
});
process.exit(code);
