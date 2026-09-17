// ---------------------------------------------------------------------------
// Shared CLI constants: version, server path, bun binary, home helper.
// Imported by every src/cli/* command module.
// ---------------------------------------------------------------------------

import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import packageJson from "../../package.json" with { type: "json" };

export const VERSION: string = packageJson.version;
export const SERVER_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));
export const BUN_BIN = Bun.which("bun") ?? "bun";

export function home(): string {
  return process.env.HOME || homedir();
}
