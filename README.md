# Mnemyx

Mnemyx is a local-first [MCP](https://modelcontextprotocol.io) server that gives AI coding assistants (Claude Code, Claude Desktop, Cursor, …) a searchable memory of your real shell history.

**Problem:** you solve the same cryptic errors repeatedly across projects and months, but the fix is buried unsearchable in `~/.zsh_history` or `~/.bash_history`. AI assistants have zero access to it and re-derive solutions from scratch every session. Mnemyx indexes your shell history locally and exposes it as MCP tools, so any MCP-compatible client can ask *"have I solved this before?"*

**Principles:**
- **100% local-first, privacy by default** — nothing leaves your machine. No telemetry, no cloud calls, ever.
- **Runtime is Bun** — install/run/test everything with `bun`.
- **Storage is `bun:sqlite`** (Bun's built-in SQLite). No `better-sqlite3`, no native compilation.
- **Transport is stdio** — this runs locally, invoked by MCP clients, not over HTTP.

> Note: the repo directory is still named `terminal-history-mcp` (legacy from `bun init`); the project itself is Mnemyx.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4
- An MCP client: Claude Code, Claude Desktop, Cursor, or the MCP Inspector for testing

## Install

```bash
bun install
```

Typecheck:

```bash
bunx tsc --noEmit
```

## Tools

| Tool | Arguments | Description |
|---|---|---|
| `search_history` | `query: string`, `limit?: number` (default 20, max 100) | Full-text ranked keyword search, most relevant first; noise commands filtered |
| `get_recent_commands` | `limit?: number` (default 10, max 100) | N most recent commands, for general context (noise filtered) |

Example — "have I fixed this docker error before?":

```json
{ "query": "docker permission denied", "limit": 10 }
```

Response (newest first, with timestamps, shell, and source file):

```text
1. [2026-09-10T14:22:31.000Z] [zsh] sudo usermod -aG docker $USER
   source: /home/you/.zsh_history
```

## Supported shells (Phase 1: macOS/Linux, zsh + bash only)

Both detected automatically — whichever files exist on disk are indexed and merged. A missing file is skipped gracefully.

| Shell | File | Format |
|---|---|---|
| zsh (macOS default, common on Linux) | `~/.zsh_history` | Extended `: <timestamp>:<duration>;<command>`; plain lines fall back to mtime |
| bash | `~/.bash_history` | One command per line; file mtime as approximate timestamp |

Each result is tagged with `source_file` **and** `shell` so you can see provenance. Bash timestamps are marked `(approx. time)` since that format stores no timestamps.

## Search quality (Phase 2)

- **Full-text search**: `search_history` uses SQLite FTS5 with BM25 ranking instead of substring matching. Multi-word queries narrow results (`git commit` requires both words), and each word prefix-matches (`commi` finds `commit`). Queries containing no searchable words (e.g. only symbols like `&&`) fall back to substring matching so the tool never breaks.
- **Noise filtering**: commands whose first word is in the denylist (`ls`, `cd`, `clear`, `pwd`, `exit`, …) are excluded from both tools. Extend the list in `~/.mnemyx/config.json` (optional — missing file just means built-ins):
  ```json
  { "denylist": ["vim", "nano", "htop"] }
  ```
  Your entries are *added to* the built-ins, never replace them. Edits take effect immediately, no restart needed.
- **Consecutive de-duplication**: identical back-to-back commands within one history file are collapsed to one row at import time (`ls` × 5 keeps a single entry).

## Register with Claude Code

```bash
claude mcp add mnemyx -- bun run /absolute/path/to/terminal-history-mcp/src/index.ts
```

(Use the absolute path to your checkout — MCP clients launch the server with an unpredictable cwd.)

Then verify:

1. `/mcp` in Claude Code — `mnemyx` should show as connected.
2. Ask it to call `get_recent_commands` — you should see your real recent commands.
3. Ask it something like *"have I ever cloned zsh-autosuggestions?"* — `search_history` should find it.

Alternative (no client needed) — MCP Inspector:

```bash
bunx @modelcontextprotocol/inspector bun run src/index.ts
```

## Configuration

No env vars for Phase 1. The SQLite DB lives outside the repo so it works regardless of launch cwd:

- Linux: `~/.local/share/mnemyx/mnemyx.db` (respects `XDG_DATA_HOME`)
- macOS: `~/Library/Application Support/mnemyx/mnemyx.db`

Re-imports are idempotent (`INSERT OR IGNORE` on `(command, timestamp, source_file)`), so restarting the server never creates duplicates.

## Project layout

```text
src/
  config.ts           # denylist defaults + ~/.mnemyx/config.json loader
  db.ts               # bun:sqlite schema, FTS5 index, ranked search, formatting
  historyParser.ts  # zsh + bash parsers + auto-detect merge
  index.ts          # MCP stdio server: startup import + 2 tools
```

## Non-goals (later phases)

- Phase 3: exit-code capture via shell hooks (`exit_code` column)
- Phase 4: local embeddings for semantic search (FTS5 remains as fallback)
- Phase 5: full config file, `mnemyx init` CLI, npm publish
- Any networking, cloud sync, or telemetry
