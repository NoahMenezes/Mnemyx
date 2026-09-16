import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Exit-code shell hook: snippets installed into ~/.zshrc / ~/.bashrc by
// `mnemyx init` (explicit consent only). Single source of truth — cli.ts
// installs these exact strings (README carries copies for manual install).
// ---------------------------------------------------------------------------

export type HookShell = "zsh" | "bash";

export const HOOK_BEGIN = "# --- Mnemyx (optional)";
export const HOOK_END = "# --- end Mnemyx";

const HOOK_HEADER = `${HOOK_BEGIN}: log each command's exit code locally for shell-history search.
# Appends JSON lines to ~/.mnemyx/exit-codes.log. Nothing leaves your machine.
# Remove this block to disable.`;

const HOOK_PYTHON =
  `MNEMYX_CODE="$code" MNEMYX_CMD="$cmd" python3 -c ` +
  `'import json,os,time; print(json.dumps({"ts":int(time.time()),"exit":int(os.environ["MNEMYX_CODE"]),"cmd":os.environ["MNEMYX_CMD"]}))' ` +
  `>> "$HOME/.mnemyx/exit-codes.log" 2>/dev/null`;

export function zshSnippet(): string {
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

export function bashSnippet(): string {
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

export function detectShell(override?: string): HookShell {
  if (override === "zsh" || override === "bash") return override;
  const base = basename(process.env.SHELL || "");
  return base === "bash" ? "bash" : "zsh"; // zsh default (macOS + common Linux)
}

export function rcPath(shell: HookShell, home = process.env.HOME || homedir()): string {
  return join(home, shell === "zsh" ? ".zshrc" : ".bashrc");
}

export function hookInstalled(rc: string): boolean {
  return existsSync(rc) && readFileSync(rc, "utf8").includes(HOOK_BEGIN);
}

// Append the snippet (with backup-free idempotence: pre-check with
// hookInstalled first). Creates parent dirs for the log. Returns whether
// anything was written. Never touches the file when already installed.
export function installHook(
  rc: string,
  shell: HookShell,
  home = process.env.HOME || homedir()
): { written: boolean } {
  if (hookInstalled(rc)) return { written: false };
  mkdirSync(join(home, ".mnemyx"), { recursive: true });
  mkdirSync(dirname(rc), { recursive: true });
  const snippet = shell === "zsh" ? zshSnippet() : bashSnippet();
  const prev = existsSync(rc) ? readFileSync(rc, "utf8") : "";
  const sep = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
  appendFileSync(rc, `${sep}\n${snippet}\n`);
  return { written: true };
}
