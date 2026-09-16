import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  searchCommands,
  getRecentCommands,
  formatRows,
  countEmbeddings,
} from "./db.ts";
import { runImport } from "./import.ts";
import { getExitLogPath } from "./exitLog.ts";
import { loadConfig } from "./config.ts";
import {
  semanticSearch,
  backfillMissingEmbeddings,
  EMBEDDING_MODEL_ID,
} from "./embeddings.ts";
import packageJson from "../package.json" with { type: "json" };

// NOTE: all logging goes to stderr (console.error). stdout is owned by the
// MCP stdio transport (JSON-RPC frames) — writing there corrupts the protocol.

const server = new McpServer({
  name: "mnemyx",
  version: packageJson.version,
});

server.tool(
  "search_history",
  "Search your past shell commands. Understands natural phrasing via local semantic search (e.g. 'docker wont start' finds a past systemctl restart docker fix), with keyword fallback. Proven-successful commands (exit 0, from the opt-in shell hook) rank first and failures last. Common noise commands (ls, cd, clear, …) are filtered out. Each hit is annotated [exit N] when its outcome is known.",
  {
    query: z.string().describe("Keyword or natural-language query"),
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
    mode: z
      .enum(["auto", "semantic", "keyword"])
      .optional()
      .describe(
        "auto (default): semantic search when available, else keyword. semantic: force meaning-based search (falls back to keyword with a note if unavailable). keyword: force FTS5 substring-style search."
      ),
  },
  async ({ query, limit, only_successful, mode }) => {
    const opts = {
      limit: limit ?? 20,
      onlySuccessful: only_successful ?? false,
    };
    const useSemantic =
      (mode ?? "auto") !== "keyword" && loadConfig().embeddings;
    if (useSemantic) {
      try {
        const rows = await semanticSearch(query, opts);
        return {
          content: [{ type: "text" as const, text: formatRows(rows) }],
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.error(`[mnemyx] semantic search unavailable (${reason}), keyword fallback`);
        if ((mode ?? "auto") === "semantic") {
          const rows = searchCommands(query, opts);
          return {
            content: [
              {
                type: "text" as const,
                text: `(semantic search unavailable: ${reason}; showing keyword results)\n\n${formatRows(rows)}`,
              },
            ],
          };
        }
        // auto mode: silent fallback, keyword results below.
      }
    }
    const rows = searchCommands(query, opts);
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
  // Shared import pipeline (same code the `mnemyx init` CLI runs).
  const result = runImport();
  console.error(
    `[mnemyx] import complete: ${result.added} new, ${result.parsed - result.added} already indexed`
  );
  if (result.ageFilteredOut > 0) {
    console.error(
      `[mnemyx] age filter: skipped ${result.ageFilteredOut} entries older than the configured max history age`
    );
  }
  if (!result.exitCodesEnabled) {
    console.error(`[mnemyx] exit codes: disabled via config`);
  } else if (result.exitOutcomes > 0) {
    console.error(
      `[mnemyx] exit codes: ${result.exitOutcomes} distinct commands logged, ${result.exitUpdated} history rows annotated`
    );
  } else {
    console.error(
      `[mnemyx] exit codes: no log at ${getExitLogPath()} (hook not installed — see README, optional)`
    );
  }
  // 4. Phase 4: vector backfill runs in the BACKGROUND — the server must
  // serve (keyword path) immediately, never wait on model download/embed.
  // Until vectors exist, semantic queries transparently use keyword search.
  if (loadConfig().embeddings) {
    const stored = countEmbeddings(EMBEDDING_MODEL_ID);
    if (stored > 0) {
      console.error(`[mnemyx] embeddings: ${stored} vectors stored (${EMBEDDING_MODEL_ID})`);
    }
    backfillMissingEmbeddings()
      .then(({ embedded }) => {
        if (embedded > 0) {
          console.error(
            `[mnemyx] embeddings: backfill complete (+${embedded} new vectors)`
          );
        } else {
          console.error(`[mnemyx] embeddings: index up to date`);
        }
      })
      .catch((err) => {
        // Model download failed / offline / inference broken: keyword search
        // keeps working. This session just won't do semantic search.
        console.error(
          `[mnemyx] embeddings disabled for this session: ${err instanceof Error ? err.message : String(err)}`
        );
      });
  } else {
    console.error(`[mnemyx] embeddings disabled via config (keyword search only)`);
  }
  // 5. Serve over stdio for MCP clients (Claude Code / Desktop / Cursor).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mnemyx] MCP server running on stdio");
}

main().catch((err) => {
  console.error(`[mnemyx] fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
