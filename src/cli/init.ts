// ---------------------------------------------------------------------------
// `mnemyx init`: first-time setup wizard. Environment check → history
// import + git indexing (both idempotent) → consent-gated shell-hook
// install/upgrade → client registration commands.
// ---------------------------------------------------------------------------

import { writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runImport } from "../import.ts";
import { loadConfig, getConfigPath } from "../config.ts";
import {
  detectShell,
  rcPath,
  hookInstalled,
  hookOutdated,
  upgradeHook,
  installHook,
} from "../hook.ts";
import { backfillMissingEmbeddings } from "../embeddings.ts";
import { getDefaultDbPath } from "../db.ts";
import { VERSION, SERVER_PATH, BUN_BIN } from "./shared.ts";
import { ask, askText } from "./input.ts";

export interface InitFlags {
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

export function parseInitFlags(args: string[]): InitFlags {
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

export async function cmdInit(rawArgs: string[]): Promise<number> {
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
    const result = await runImport();
    console.log(
      `      parsed ${result.parsed} commands, ${result.added} new, ${result.ageFilteredOut} skipped by age filter`
    );
    if (result.pluginsLoaded.length > 0 || result.pluginsSkipped > 0) {
      console.log(
        `      plugins: ${result.pluginsLoaded.length > 0 ? result.pluginsLoaded.join(", ") : "none loaded"}${result.pluginsSkipped > 0 ? `, ${result.pluginsSkipped} skipped (see warnings above)` : ""}`
      );
    }
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
      const { indexAllRepos } = await import("../gitIndexer.ts");
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
