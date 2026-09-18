import { test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHistoryTools } from "./tools/history.ts";
import { registerGitTools } from "./tools/git.ts";
import { registerActivityTools } from "./tools/activity.ts";

// Guards the wiring in src/index.ts: a dropped register* call (or a renamed
// tool) breaks clients at runtime, so assert the full set here instead.
// White-box on McpServer._registeredTools — revisit this test if a major
// @modelcontextprotocol/sdk bump renames that field.
const EXPECTED_TOOLS = [
  // tools/history.ts
  "search_history",
  "search_by_error",
  "get_recent_commands",
  "get_project_profile",
  // tools/git.ts
  "search_commits",
  "get_commit_context",
  "get_commit_story",
  "explain_line",
  "reindex_repos",
  "get_repo_log",
  "get_commit_diff",
  "get_repo_status",
  "get_file_history",
  // tools/activity.ts
  "list_sessions",
  "get_session",
  "export_notes",
].sort();

function registeredNames(): string[] {
  const server = new McpServer({ name: "mnemyx-test", version: "0.0.0" });
  registerHistoryTools(server);
  registerGitTools(server);
  registerActivityTools(server);
  const tools = (
    server as unknown as { _registeredTools?: Record<string, unknown> }
  )._registeredTools;
  return Object.keys(tools ?? {}).sort();
}

test("all 16 MCP tools are registered, no more no less", () => {
  expect(registeredNames()).toEqual(EXPECTED_TOOLS);
});
