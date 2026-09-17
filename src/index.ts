import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { countEmbeddings, closeDb, countCommits } from "./db.ts";
import { runImport } from "./import.ts";
import { getExitLogPath } from "./exitLog.ts";
import { loadConfig } from "./config.ts";
import { indexAllRepos } from "./gitIndexer.ts";
import {
  backfillMissingEmbeddings,
  EMBEDDING_MODEL_ID,
} from "./embeddings.ts";
import { registerHistoryTools } from "./tools/history.ts";
import { registerGitTools } from "./tools/git.ts";
import { registerActivityTools } from "./tools/activity.ts";
import packageJson from "../package.json" with { type: "json" };

// NOTE: all logging goes to stderr (console.error). stdout is owned by the
// MCP stdio transport (JSON-RPC frames) — writing there corrupts the protocol.

const server = new McpServer({
  name: "mnemyx",
  version: packageJson.version,
});

// Tool definitions live in src/tools/* (one concern per file); this entry
// point only wires them up. Adding a tool = new register call, nothing else.
registerHistoryTools(server);
registerGitTools(server);
registerActivityTools(server);

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
  // Phase 6: git indexing runs in the BACKGROUND like embeddings — the
  // server must serve immediately, never wait on `git log` across repos.
  // Until it finishes, git tools just report "not indexed / reindex".
  // Never throws: indexAllRepos counts failures instead of raising.
  try {
    const stored = countCommits();
    if (stored > 0) {
      console.error(`[mnemyx] commits: ${stored} indexed`);
    }
  } catch {
    // Fresh DB edge: table exists post-migration, but stay quiet on error.
  }
  setTimeout(() => {
    try {
      const r = indexAllRepos();
      if (r.repos === 0) {
        console.error(`[mnemyx] commits: no repos under repoRoots`);
      } else if (r.commitsAdded > 0) {
        console.error(
          `[mnemyx] commits: backfill complete (+${r.commitsAdded} new across ${r.repos} repos)`
        );
      } else {
        console.error(`[mnemyx] commits: index up to date (${r.commitsSeen} seen)`);
      }
    } catch (err) {
      console.error(
        `[mnemyx] git indexing skipped: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }, 0);
  // 5. Serve over stdio for MCP clients (Claude Code / Desktop / Cursor).
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mnemyx] MCP server running on stdio");
}

// Entry guard: importing this module must never launch the server
// (tests and future tooling import it for its pieces).
if (import.meta.main) {
  // Graceful shutdown: checkpoint WAL + close the DB instead of dying
  // mid-transaction when the client kills us (client restarts, timeouts).
  const shutdown = (signal: string): void => {
    try {
      console.error(`[mnemyx] ${signal} received, closing DB`);
      closeDb();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  main().catch((err) => {
    console.error(`[mnemyx] fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
