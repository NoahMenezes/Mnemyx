// ---------------------------------------------------------------------------
// Shared CLI constants: version, server path, bun binary, home helper.
// Imported by every src/cli/* command module.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { dirname, join } from "node:path";
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
export const BUN_BIN = Bun.which("bun") ?? "bun";

export function home(): string {
  return process.env.HOME || homedir();
}
