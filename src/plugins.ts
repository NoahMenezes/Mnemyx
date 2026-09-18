// ---------------------------------------------------------------------------
// Phase 13: plugin sources. Third-party local history (psql, kubectl,
// docker, …) enters through JS files in ~/.mnemyx/plugins/ exporting:
//
//   export default {
//     name: "my-source",            // unique, used for provenance + disabling
//     parse: () => HistoryEntry[],  // or async () => HistoryEntry[]
//   }
//
// Contract (read before writing a plugin):
// - Return HistoryEntry rows (command, timestamp, sourceFile, shell).
//   Use shell "zsh"|"bash" whichever is closer; sourceFile should name
//   the real origin (e.g. "~/.psql_history") for provenance.
// - Commands are NFC-normalized, age-filtered, bulk-inserted idempotently,
//   and exit-stamped by the SAME pipeline as built-ins (runImport).
// - A throwing parse(), wrong shape, or insecure file NEVER breaks the
//   import: the plugin is skipped with a stderr warning naming the file.
//
// Trust model (honest, read before installing a plugin): a plugin is
// arbitrary local code YOU placed in your own directory — same trust as
// the shell-hook snippet. Files must not be writable by group/other
// (0600 recommended; warn-and-skip otherwise). Nothing grants or needs
// network access.
// Provenance is always visible: plugin rows carry
// sourceFile "plugin:<name>:<origin>".
// ---------------------------------------------------------------------------

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { requireHome } from "./config.ts";
import type { HistoryEntry, SupportedShell } from "./db.ts";

export function getPluginsDir(home?: string): string {
  const h = home ?? (() => {
    try {
      return requireHome();
    } catch {
      return "";
    }
  })();
  if (h === "") return "";
  return join(h, ".mnemyx", "plugins");
}

/** The validated shape of one plugin's default export. */
export interface SourcePlugin {
  name: string;
  parse: () => HistoryEntry[] | Promise<HistoryEntry[]>;
}

export interface LoadedPlugins {
  /** Valid rows from all accepted plugins (provenance-namespaced). */
  entries: HistoryEntry[];
  /** Names accepted this run. */
  loaded: string[];
  /** File-level skips with reasons (capped for display). */
  skipped: { file: string; reason: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function cleanEntry(e: unknown, pluginName: string): HistoryEntry | null {
  if (!isRecord(e)) return null;
  const command = typeof e.command === "string" ? e.command.normalize("NFC") : "";
  if (command.trim() === "") return null;
  const timestamp =
    typeof e.timestamp === "number" && Number.isFinite(e.timestamp)
      ? Math.floor(e.timestamp)
      : null;
  if (timestamp === null || timestamp < 0) return null;
  const shell: SupportedShell = e.shell === "bash" ? "bash" : "zsh";
  const origin = typeof e.sourceFile === "string" && e.sourceFile.trim() !== ""
    ? e.sourceFile.trim()
    : "plugin-input";
  return {
    command,
    timestamp,
    sourceFile: `plugin:${pluginName}:${origin}`,
    shell,
    timestampApproximate: false,
  };
}

// Writability gate: a group/world-writable plugin file is a
// privilege-escalation vector on multi-user machines (another user could
// rewrite your plugin between loads, running code as you). Readable-but-
// not-writable (0644) is fine and loads normally. Best-effort: stat
// failures skip.
function ownerOnly(path: string): boolean {
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o022) === 0;
  } catch {
    return false;
  }
}

// Load + validate every plugin. Never throws for a bad plugin —
// failures are collected as skips. `dir` override exists for tests.
export async function loadPluginEntries(
  dir?: string,
  disabled: string[] = []
): Promise<LoadedPlugins> {
  const out: LoadedPlugins = { entries: [], loaded: [], skipped: [] };
  const pluginsDir = dir ?? getPluginsDir();
  if (pluginsDir === "" || !existsSync(pluginsDir)) return out;
  let files: string[] = [];
  try {
    files = readdirSync(pluginsDir)
      .filter((f) => f.endsWith(".js") || f.endsWith(".mjs") || f.endsWith(".cjs"))
      .sort();
  } catch (err) {
    console.error(
      `[mnemyx] skipping plugins dir ${pluginsDir}: ${err instanceof Error ? err.message : String(err)}`
    );
    return out;
  }
  // Deterministic cap: a mistaken `cp *.js` shouldn't queue hundreds.
  const MAX_PLUGINS = 20;
  const picked = files.slice(0, MAX_PLUGINS);
  if (files.length > picked.length) {
    console.error(
      `[mnemyx] ignoring ${files.length - picked.length} plugin files beyond the ${MAX_PLUGINS} cap in ${pluginsDir}`
    );
  }
  const denied = new Set(disabled);
  for (const file of picked) {
    const path = join(pluginsDir, file);
    const skip = (reason: string): void => {
      if (out.skipped.length < 5) out.skipped.push({ file, reason });
      console.error(`[mnemyx] skipping plugin ${file}: ${reason}`);
    };
    if (!ownerOnly(path)) {
      skip("writable by group/other (chmod 600 to allow)");
      continue;
    }
    let mod: unknown;
    try {
      mod = await import(pathToFileURL(path).href);
    } catch (err) {
      skip(`cannot load (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    const def: unknown = isRecord(mod) ? mod.default : undefined;
    if (!isRecord(def) || typeof def.name !== "string" || def.name.trim() === "") {
      skip('default export must be { name: "…", parse() }');
      continue;
    }
    const name = def.name.trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name)) {
      skip(`bad name ${JSON.stringify(name)} (letters/digits/_/-, max 64)`);
      continue;
    }
    if (denied.has(name)) continue; // disabled by config: silent, not an error
    if (out.loaded.includes(name)) {
      skip(`duplicate name ${JSON.stringify(name)} (first file wins)`);
      continue;
    }
    if (typeof def.parse !== "function") {
      skip("missing parse() function");
      continue;
    }
    let raw: unknown;
    try {
      raw = await (def.parse as () => unknown)();
    } catch (err) {
      skip(`parse() threw (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    if (!Array.isArray(raw)) {
      skip("parse() must return an array of entries");
      continue;
    }
    let kept = 0;
    for (const e of raw.slice(0, 10000)) {
      const clean = cleanEntry(e, name);
      if (clean) {
        out.entries.push(clean);
        kept++;
      }
    }
    out.loaded.push(name);
    if (kept < raw.length) {
      console.error(`[mnemyx] plugin ${name}: dropped ${raw.length - kept} malformed entries`);
    }
  }
  return out;
}

// Reference plugin source: psql history is plain lines like bash
// (one statement per line, no timestamps → file-mtime fallback).
// Exported for tests and as the copy-paste template in PLUGINS.md.
export function parsePsqlHistory(
  content: string,
  sourceFile: string,
  fallbackTimestamp: number
): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of content.split("\n")) {
    const command = line.trim().normalize("NFC");
    if (!command) continue;
    entries.push({
      command,
      timestamp: fallbackTimestamp,
      sourceFile,
      shell: "bash",
      timestampApproximate: true,
    });
  }
  return entries;
}

// The bundled example plugin body (written to the plugins dir by hand —
// mnemyx never writes it automatically). Reads $HOME/.psql_history.
export const PSQL_EXAMPLE = `// mnemyx example source plugin: psql history.
// Install: save as ~/.mnemyx/plugins/psql.mjs, chmod 600, re-run mnemyx init.
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export default {
  name: "psql",
  parse() {
    const home = process.env.HOME || homedir();
    const file = join(home, ".psql_history");
    if (!existsSync(file)) return [];
    const mtime = Math.floor(statSync(file).mtimeMs / 1000);
    const out = [];
    for (const line of readFileSync(file, "utf8").split("\\n")) {
      const command = line.trim();
      if (!command) continue;
      out.push({
        command,
        timestamp: mtime,
        sourceFile: file,
        shell: "bash",
        timestampApproximate: true,
      });
    }
    return out;
  },
};
`;

