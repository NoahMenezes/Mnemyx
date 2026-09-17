// ---------------------------------------------------------------------------
// Per-user DB path resolution. Absolute on purpose: MCP clients launch
// this server with an unpredictable cwd, so a repo-relative path would
// create stray DBs or fail to find the real one.
// ---------------------------------------------------------------------------

import { join } from "node:path";
import { requireHome } from "../config.ts";

// Pure helper (platform/home/xdg injected) so every branch — including
// macOS paths — is unit-testable on any machine.
export function dbPathFor(
  platform: string,
  home: string,
  xdgDataHome: string | undefined
): string {
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "mnemyx", "mnemyx.db");
  }
  // Linux (and fallback): XDG data home. macOS/Linux only.
  const dataHome = xdgDataHome || join(home, ".local", "share");
  return join(dataHome, "mnemyx", "mnemyx.db");
}

export function getDefaultDbPath(): string {
  return dbPathFor(process.platform, requireHome(), process.env.XDG_DATA_HOME);
}
