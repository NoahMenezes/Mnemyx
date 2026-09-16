import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  initDb,
  bulkInsert,
  applyExitCodes,
  searchCommands,
  getRecentCommands,
  formatRows,
} from "./db.ts";
import { parseAllAvailableHistory } from "./historyParser.ts";
import { parseExitLog, getExitLogPath } from "./exitLog.ts";

// NOTE: all logging goes to stderr (console.error). stdout is owned by the
// MCP stdio transport (JSON-RPC frames) — writing there corrupts the protocol.

const server = new McpServer({
  name: "mnemyx",
  version: "0.1.0",
});

server.tool(
  "search_history",
  "Search your past shell commands by keyword. Full-text ranked search over command text; proven-successful commands (exit 0, from the opt-in shell hook) rank first and failures last. Common noise commands (ls, cd, clear, …) are filtered out. Each hit is annotated [exit N] when its outcome is known.",
  {
    query: z.string().describe("Keyword to search for in past commands"),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max results to return (default 20, max 100)"),
    only_successful: z
      .boolean()
      .optional()
      .describe(
        "When true, return only commands proven to exit 0. Commands with unknown outcomes (all pre-hook history) are excluded. Default false."
      ),
  },
  async ({ query, limit, only_successful }) => {
    const rows = searchCommands(query, {
      limit: limit ?? 20,
      onlySuccessful: only_successful ?? false,
    });
    return { content: [{ type: "text" as const, text: formatRows(rows) }] };
  }
);

server.tool(
  "get_recent_commands",
  "Return the N most recent shell commands. Useful for general context without a specific search query.",
  {
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("How many recent commands to return (default 10, max 100)"),
  },
  async ({ limit }) => {
    const rows = getRecentCommands(limit ?? 10);
    return { content: [{ type: "text" as const, text: formatRows(rows) }] };
  }
);

async function main(): Promise<void> {
  // 1. Open/create the local SQLite DB (runs migrations idempotently).
  initDb();
  // 2. Parse whichever history files exist and import them (idempotent).
  const entries = parseAllAvailableHistory();
  const added = bulkInsert(entries);
  console.error(
    `[mnemyx] import complete: ${added} new, ${entries.length - added} already indexed`
  );
  // 3. Phase 3: stamp hook-observed exit codes onto matching rows.
  // Missing log file = hook not installed = silent no-op (pure Phase 2).
  const outcomes = parseExitLog();
  if (outcomes.size > 0) {
    const updated = applyExitCodes(outcomes);
    console.error(
      `[mnemyx] exit codes: ${outcomes.size} distinct commands logged, ${updated} history rows annotated`
    );
  } else {
    console.error(
      `[mnemyx] exit codes: no log at ${getExitLogPath()} (hook not installed — see README, optional)`
    );
  }
  // 4. Serve over stdio for MCP clients (Claude Code / Desktop / Cursor).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mnemyx] MCP server running on stdio");
}

main().catch((err) => {
  console.error(`[mnemyx] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
