// ---------------------------------------------------------------------------
// `mnemyx dashboard`: local-only web UI (Phase 10). Serves the read-only
// dashboard on 127.0.0.1 and opens the system browser. Binding is
// loopback-only by design (see dashboard/server.ts) — never exposed.
// ---------------------------------------------------------------------------

import { serveDashboard, DEFAULT_DASHBOARD_PORT } from "../dashboard/server.ts";

function openBrowser(url: string): void {
  const candidates: string[][] =
    process.env.BROWSER !== undefined && process.env.BROWSER !== ""
      ? [process.env.BROWSER.split(" ").filter((s) => s !== "")]
      : [];
  if (process.platform === "darwin") candidates.push(["open", url]);
  else candidates.push(["xdg-open", url]);
  for (const [bin, ...args] of candidates) {
    if (bin === undefined) continue;
    try {
      const proc = Bun.spawn([bin, ...args, ...(args.includes(url) ? [] : [url])], {
        stdout: "ignore",
        stderr: "ignore",
      });
      proc.unref?.();
      return;
    } catch {
      // Try the next opener.
    }
  }
  console.log(`      (could not open a browser automatically — visit the URL above)`);
}

export async function cmdDashboard(rawArgs: string[]): Promise<number> {
  let port = DEFAULT_DASHBOARD_PORT;
  let noOpen = false;
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === "--port") {
      const v = Number.parseInt(rawArgs[++i] as string, 10);
      if (!Number.isFinite(v) || v < 1 || v > 65535) {
        console.error(`--port expects 1-65535 (see mnemyx --help)`);
        return 2;
      }
      port = v;
    } else if (a === "--no-open") {
      noOpen = true;
    } else {
      console.error(`unknown flag for dashboard: ${a} (see mnemyx --help)`);
      return 2;
    }
  }
  try {
    const server = await serveDashboard({ port });
    const url = `http://${server.hostname}:${server.port}`;
    if (!noOpen) openBrowser(url);
    // Block until Ctrl+C (the server owns no other handles to wait on).
    await new Promise(() => {});
    return 0;
  } catch (err) {
    console.error(
      `could not start dashboard on port ${port} (in use? retry --port N): ${err instanceof Error ? err.message : String(err)}`
    );
    return 1;
  }
}
