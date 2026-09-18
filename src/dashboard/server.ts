// ---------------------------------------------------------------------------
// Dashboard HTTP server (Phase 10). Local-only mnemyx dashboard: timeline,
// search, sessions, commits, status — read-only browsing over your shell
// history. Binds 127.0.0.1 unconditionally: shell history must never be
// one flag away from LAN exposure.
// ---------------------------------------------------------------------------

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initDb } from "../db.ts";
import { collectStatus } from "../cli/status.ts";
import {
  handleSearch,
  handleRecent,
  handleError,
  handleSessions,
  handleSession,
  handleCommits,
  handleProfile,
} from "./api.ts";
import packageJson from "../../package.json" with { type: "json" };

export const DEFAULT_DASHBOARD_PORT = 4877;
// Single-file UI. Resolves next to this module in a source checkout
// (`src/dashboard/page.html`) and next to the bundle in an install
// (`dist/page.html`) — `bun run build` copies it there; keep that step.
const PAGE = join(dirname(fileURLToPath(import.meta.url)), "page.html");

function notFound(): Response {
  return Response.json({ error: "not found" }, { status: 404 });
}

function methodNotAllowed(): Response {
  return Response.json({ error: "GET only — the dashboard is read-only" }, { status: 405 });
}

// Route wrapper: API is GET-only by design (read-only dashboard).
function get(
  handler: (params: URLSearchParams) => Response | Promise<Response>
): (req: Request) => Response | Promise<Response> {
  return (req) => {
    if (req.method !== "GET") return methodNotAllowed();
    return handler(new URL(req.url).searchParams);
  };
}

export interface ServeOptions {
  port?: number;
  /** Test hook: serve without printing/opening anything. */
  quiet?: boolean;
}

export function serveDashboard(opts: ServeOptions = {}) {
  const port = opts.port ?? DEFAULT_DASHBOARD_PORT;
  initDb();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    routes: {
      "/": (req) => {
        if (req.method !== "GET") return methodNotAllowed();
        return new Response(Bun.file(PAGE), { headers: { "content-type": "text/html; charset=utf-8" } });
      },
      "/api/status": (req) => {
        if (req.method !== "GET") return methodNotAllowed();
        const s = collectStatus();
        return Response.json({ ...s, version: packageJson.version });
      },
      "/api/search": get((p) => handleSearch(p)),
      "/api/recent": get((p) => handleRecent(p)),
      "/api/error": get((p) => handleError(p)),
      "/api/sessions": get((p) => handleSessions(p)),
      "/api/session": get((p) => handleSession(p)),
      "/api/commits": get((p) => handleCommits(p)),
      "/api/profile": get((p) => handleProfile(p)),
    },
    fetch(req) {
      if (new URL(req.url).pathname.startsWith("/api/")) {
        if (req.method !== "GET") return methodNotAllowed();
        return notFound();
      }
      if (req.method !== "GET") return methodNotAllowed();
      return notFound();
    },
    error(err) {
      console.error(`[mnemyx] dashboard error: ${err instanceof Error ? err.message : String(err)}`);
      return Response.json({ error: "internal error" }, { status: 500 });
    },
  });
  if (!opts.quiet) {
    console.log(`dashboard at http://${server.hostname}:${server.port} (local-only, Ctrl+C to stop)`);
  }
  return server;
}
