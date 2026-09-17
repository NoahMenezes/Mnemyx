// ---------------------------------------------------------------------------
// `mnemyx export`: shareable redacted markdown for a session or commit
// story (Phase 11). Stdout by default (pipe-friendly); --out writes
// owner-only and refuses to clobber without --force. Builders take
// formatted text only, so raw secrets can never reach the output.
// ---------------------------------------------------------------------------

import { existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { initDb } from "../db.ts";

export async function cmdExport(rawArgs: string[]): Promise<number> {
  let session: string | undefined;
  let commit: string | undefined;
  let withDiff = false;
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--session") session = rawArgs[++i];
    else if (a === "--commit") commit = rawArgs[++i];
    else if (a === "--with-diff") withDiff = true;
    else if (a === "--out") out = rawArgs[++i];
    else if (a === "--force") force = true;
    else {
      console.error(`unknown flag for export: ${a} (see mnemyx --help)`);
      return 2;
    }
  }
  if (session === undefined && commit === undefined) {
    console.error(`export needs --session <id> or --commit <hash> (see mnemyx --help)`);
    return 2;
  }
  if (session !== undefined && commit !== undefined) {
    console.error(`export takes exactly one of --session or --commit (see mnemyx --help)`);
    return 2;
  }
  if (withDiff && session !== undefined) {
    console.error(`--with-diff only applies to --commit (sessions carry their own commits)`);
    return 2;
  }
  if ((session !== undefined && session.trim() === "") || (commit !== undefined && commit.trim() === "")) {
    console.error(`export needs a non-empty id (see mnemyx --help)`);
    return 2;
  }
  initDb();
  const { buildSessionExport, buildStoryExport } = await import("../export.ts");
  let built: { markdown: string; redactedCount: number };
  if (session !== undefined) {
    const { getSession, formatSession } = await import("../sessions.ts");
    const s = getSession(session);
    if (!s) {
      console.error(
        `unknown session ${JSON.stringify(session)} — ids shift as new commands land; list fresh ids with the list_sessions tool and retry`
      );
      return 1;
    }
    built = buildSessionExport(s.id, formatSession(s));
  } else {
    const { resolveCommit, getCommandsNearCommit, formatCommitStory } = await import("../correlate.ts");
    const { getDiffStat, getCommitDiff } = await import("../gitIndexer.ts");
    const c = resolveCommit(commit as string);
    if (!c) {
      console.error(
        `unknown commit ${JSON.stringify(commit)} — run reindex_repos (tool) or mnemyx init and retry`
      );
      return 1;
    }
    const story = formatCommitStory(
      c,
      getCommandsNearCommit(c),
      getDiffStat(c.repoPath, c.hash),
      withDiff ? getCommitDiff(c.repoPath, c.hash) : null
    );
    built = buildStoryExport(c.hash.slice(0, 7), c.hash, story);
  }
  if (out === undefined) {
    process.stdout.write(built.markdown.endsWith("\n") ? built.markdown : built.markdown + "\n");
    return 0;
  }
  if (existsSync(out) && !force) {
    console.error(`refusing to overwrite existing ${out} (pass --force to replace it)`);
    return 1;
  }
  try {
    mkdirSync(join(out, ".."), { recursive: true });
    writeFileSync(out, built.markdown.endsWith("\n") ? built.markdown : built.markdown + "\n");
    try {
      chmodSync(out, 0o600);
    } catch {
      // Non-fatal; content is already masked, perms are defense in depth.
    }
  } catch (err) {
    console.error(
      `could not write ${out}: ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
  console.log(`wrote ${out} (${built.markdown.length} bytes, ${built.redactedCount} redactions)`);
  return 0;
}
