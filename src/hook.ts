import { existsSync, readFileSync, appendFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { requireHome } from "./config.ts";

// ---------------------------------------------------------------------------
// Exit-code shell hook: snippets installed into ~/.zshrc / ~/.bashrc by
// `mnemyx init` (explicit consent only). Single source of truth — cli.ts
// installs these exact strings (README carries copies for manual install).
// ---------------------------------------------------------------------------

export type HookShell = "zsh" | "bash";

export const HOOK_BEGIN = "# --- Mnemyx (optional)";
export const HOOK_END = "# --- end Mnemyx";
// Version tag embedded in every v2+ snippet. v1 blocks (no tag) still
// work — they just log without cwd/repo until upgraded.
export const HOOK_VERSION = 2;
export const HOOK_VERSION_TAG = `# mnemyx-hook-version: ${HOOK_VERSION}`;

const HOOK_HEADER = `${HOOK_BEGIN}: log each command's exit code locally for shell-history search.
# Appends JSON lines to ~/.mnemyx/exit-codes.log. Nothing leaves your machine.
# Remove this block to disable.
${HOOK_VERSION_TAG}`;

const HOOK_PYTHON =
  `MNEMYX_CODE="$code" MNEMYX_CMD="$cmd" MNEMYX_CWD="$cwd" MNEMYX_REPO="$repo" python3 -c ` +
  `'import json,os,time; print(json.dumps({"ts":int(time.time()),"exit":int(os.environ["MNEMYX_CODE"]),"cmd":os.environ["MNEMYX_CMD"],"cwd":os.environ.get("MNEMYX_CWD") or "","repo":os.environ.get("MNEMYX_REPO") or ""}))' ` +
  `>> "$HOME/.mnemyx/exit-codes.log" 2>/dev/null`;

// v2 context capture: working directory + enclosing git repo root (empty
// outside a repo). `git rev-parse` fails fast (~ms) outside repos; the
// 2>/dev/null keeps prompts clean. macOS bash 3.2 / zsh 5.x safe.
const HOOK_CONTEXT = `  local cwd repo
  cwd=$(pwd 2>/dev/null)
  repo=$(git rev-parse --show-toplevel 2>/dev/null)`;

export function zshSnippet(): string {
  return `${HOOK_HEADER}
_mnemyx_precmd() {
  local code=$?
  local cmd
  cmd=$(fc -ln -1 2>/dev/null | sed -e 's/^[[:space:]]*//')
${HOOK_CONTEXT}
  if [ -n "$cmd" ]; then
    ${HOOK_PYTHON}
  fi
  return "$code"
}
autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _mnemyx_precmd
${HOOK_END}`;
}

export function bashSnippet(): string {
  return `${HOOK_HEADER}
_mnemyx_prompt() {
  local code=$?
  local cmd
  cmd=$(history 1 2>/dev/null | sed -e 's/^[[:space:]]*[0-9]*[[:space:]]*//')
${HOOK_CONTEXT}
  if [ -n "$cmd" ]; then
    ${HOOK_PYTHON}
  fi
  return "$code"
}
if [[ "\${PROMPT_COMMAND:-}" != *"_mnemyx_prompt"* ]]; then
  # NB: PROMPT_COMMAND as an *array* (bash 5.1+) is not handled — if
  # 'declare -p PROMPT_COMMAND' shows "declare -a", prepend _mnemyx_prompt
  # to the array manually instead of using this block.
  PROMPT_COMMAND="_mnemyx_prompt\${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
fi
${HOOK_END}`;
}

export function detectShell(override?: string): HookShell | null {
  if (override === "zsh" || override === "bash") return override;
  const base = basename(process.env.SHELL || "");
  if (base === "bash") return "bash";
  if (base === "zsh" || base === "") return "zsh"; // zsh default (macOS + common Linux)
  return null; // unrecognized (fish, dash, …) — caller must ask, never guess
}

export function rcPath(shell: HookShell, home = requireHome()): string {
  return join(home, shell === "zsh" ? ".zshrc" : ".bashrc");
}

export function hookInstalled(rc: string): boolean {
  return existsSync(rc) && readFileSync(rc, "utf8").includes(HOOK_BEGIN);
}

// True when a block is installed but predates HOOK_VERSION (v1: no cwd).
// Missing file / no block → false (nothing to upgrade, install instead).
export function hookOutdated(rc: string): boolean {
  if (!hookInstalled(rc)) return false;
  try {
    return !readFileSync(rc, "utf8").includes(HOOK_VERSION_TAG);
  } catch {
    return false;
  }
}

// Replace an installed v1 block with the current snippet in place.
// Returns upgraded:false when there is no block to replace (use
// installHook) or the block is already current (nothing to do).
export function upgradeHook(
  rc: string,
  shell: HookShell
): { upgraded: boolean } {
  if (!existsSync(rc)) return { upgraded: false };
  const prev = readFileSync(rc, "utf8");
  const begin = prev.indexOf(HOOK_BEGIN);
  const end = prev.indexOf(HOOK_END, begin >= 0 ? begin : 0);
  if (begin < 0 || end < 0) return { upgraded: false };
  if (prev.includes(HOOK_VERSION_TAG)) return { upgraded: false };
  const snippet = shell === "zsh" ? zshSnippet() : bashSnippet();
  const next =
    prev.slice(0, begin) + snippet + prev.slice(end + HOOK_END.length);
  writeFileSync(rc, next.endsWith("\n") ? next : next + "\n");
  return { upgraded: true };
}

// Append the snippet (with backup-free idempotence: pre-check with
// hookInstalled first). Creates parent dirs for the log. Returns whether
// anything was written. Never touches the file when already installed.
export function installHook(
  rc: string,
  shell: HookShell,
  home = requireHome()
): { written: boolean } {
  if (hookInstalled(rc)) return { written: false };
  mkdirSync(join(home, ".mnemyx"), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(rc), { recursive: true });
  // Pre-create the log owner-only: the shell appends via umask-dependent
  // redirect, so claiming 0600 here is the only reliable moment.
  try {
    writeFileSync(join(home, ".mnemyx", "exit-codes.log"), "", {
      flag: "a",
      mode: 0o600,
    });
    chmodSync(join(home, ".mnemyx", "exit-codes.log"), 0o600);
  } catch {
    // Non-fatal; logging still works, just with default perms.
  }
  const snippet = shell === "zsh" ? zshSnippet() : bashSnippet();
  const prev = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const sep = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
  appendFileSync(rc, `${sep}\n${snippet}\n`);
  return { written: true };
}
