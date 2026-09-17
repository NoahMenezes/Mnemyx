// ---------------------------------------------------------------------------
// `mnemyx run -- <cmd...>`: transparent wrapper that logs exit code +
// stderr tail locally (Phase 8's explicit error feed). The terminal
// behaves byte-identically; exit codes pass through for scripts.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getExitLogPath } from "../exitLog.ts";

// Phase 8 explicit error feed: `mnemyx run -- <cmd...>` executes the command
// with stdout/stderr inherited (the terminal behaves byte-identically),
// tees stderr in-process, and appends a v3 hook-log line carrying the
// exit code + stderr tail. This is the low-risk alternative to an
// always-on stderr tee in the interactive hook (which would perturb
// fullscreen apps, colors, and pipe behavior): capture happens only for
// commands the user deliberately wraps. Exit code passes through, so
// `mnemyx run` is transparent in scripts (`&&`/`||` keep working).
export async function cmdRun(rawArgs: string[]): Promise<number> {
  const sep = rawArgs.indexOf("--");
  const child = sep < 0 ? [] : rawArgs.slice(sep + 1);
  if (child.length === 0) {
    console.error(`usage: mnemyx run -- <cmd...> (see mnemyx --help)`);
    return 2;
  }
  const t0 = Math.floor(Date.now() / 1000);
  let proc;
  try {
    proc = Bun.spawn(child as [string, ...string[]], {
      stdout: "inherit",
      stderr: "pipe",
    });
  } catch (err) {
    console.error(
      `mnemyx run: cannot start ${JSON.stringify(child[0])}: ${err instanceof Error ? err.message : String(err)}`
    );
    return 127;
  }
  // Stream stderr to the terminal as it arrives (no buffering pause),
  // while keeping the tail for the log line.
  const chunks: Buffer[] = [];
  try {
    const errStream = proc.stderr;
    if (errStream !== null && typeof errStream !== "number") {
      const reader = errStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        chunks.push(buf);
        process.stderr.write(buf);
      }
    }
  } catch {
    // Passthrough failed mid-stream; the exit code below still applies.
  }
  const exit = await proc.exited;
  const code = typeof exit === "number" && Number.isFinite(exit) ? exit : 1;
  // Best-effort context (same definitions as the hook): cwd + repo root.
  let repo = "";
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (r.exitCode === 0) repo = `${r.stdout}`.trim();
  } catch {
    repo = "";
  }
  const tailBytes = Buffer.concat(chunks);
  const tail = tailBytes
    .subarray(Math.max(0, tailBytes.length - 8192))
    .toString("utf8");
  // Log the WRAPPER invocation as typed (`mnemyx run -- ...`), not the
  // inner command: shell history records the wrapper line, and exit/err
  // stamping matches on exact command text. (Quoting nuances may differ
  // from $HISTFILE byte-for-byte; matching stays best-effort, as ever.)
  const line = JSON.stringify({
    ts: t0,
    exit: code,
    cmd: `mnemyx run -- ${child.join(" ")}`,
    cwd: process.cwd(),
    repo,
    err: tail,
  });
  try {
    const logPath = getExitLogPath();
    mkdirSync(join(logPath, ".."), { recursive: true, mode: 0o700 });
    appendFileSync(logPath, line + "\n");
  } catch (err) {
    console.error(
      `[mnemyx] could not append exit log: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  return code > 255 ? 1 : code;
}
