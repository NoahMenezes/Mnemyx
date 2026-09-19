// ---------------------------------------------------------------------------
// Shared CLI constants: version, server path, bun binary, home helper.
// Imported by every src/cli/* command module.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;

// Path of this module on disk. In a source checkout it is
// `<pkg>/src/cli/shared.ts`; in the published package it is inlined into
// `<pkg>/dist/cli.js` by `bun run build`. The server entry sits next to the
// CLI in both layouts (`src/index.ts` vs `dist/index.js`), so resolve by own
// extension instead of hardcoding one layout (the old `../index.ts` broke
// every global install by pointing outside `dist/`).
const SELF = fileURLToPath(import.meta.url);
/** True when running from the built `dist/` output (global/bunx install). */
export const INSTALLED = !SELF.endsWith(".ts");
export const SERVER_PATH =
  INSTALLED
    ? join(dirname(SELF), "index.js")
    : fileURLToPath(new URL("../index.ts", import.meta.url));
// Resolve bun robustly: Bun.which misses when PATH is minimal (GUI clients).
// Fall back to the default install location before giving up with bare "bun".
function resolveBun(): { bin: string; ok: boolean } {
  const found = Bun.which("bun");
  if (found) return { bin: found, ok: true };
  try {
    const homeDir = process.env.HOME || homedir();
    const candidate = join(homeDir, ".bun", "bin", "bun");
    if (candidate && existsSync(candidate)) return { bin: candidate, ok: true };
  } catch {
    // ignore — fall through to bare "bun" with ok=false
  }
  return { bin: "bun", ok: false };
}
const resolvedBun = resolveBun();
export const BUN_BIN = resolvedBun.bin;
/** False when no bun binary could be located — callers must warn inline. */
export const BUN_BIN_OK = resolvedBun.ok;
/** True when SERVER_PATH looks like a bunx/ephemeral cache path. */
export const SERVER_PATH_IS_CACHE =
  SERVER_PATH.includes(`${"/"}cache${"/"}`) ||
  SERVER_PATH.includes("bunx") ||
  SERVER_PATH.includes(`${"/"}tmp${"/"}`);

export function home(): string {
  return process.env.HOME || homedir();
}
