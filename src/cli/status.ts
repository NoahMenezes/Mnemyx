// ---------------------------------------------------------------------------
// `mnemyx status`: read-only health report (changes nothing).
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getHistoryFilePaths } from "../historyParser.ts";
import { getExitLogPath } from "../exitLog.ts";
import { loadConfig, getConfigPath } from "../config.ts";
import { hookInstalled } from "../hook.ts";
import { EMBEDDING_MODEL_ID, getModelCacheDir } from "../embeddings.ts";
import { getDefaultDbPath } from "../db.ts";
import { discoverReposFromConfig } from "../repoScanner.ts";
import { VERSION, home } from "./shared.ts";

export interface StatusInfo {
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

export function collectStatus(): StatusInfo {
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

export function printStatus(s: StatusInfo): void {
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
