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
| `search_history` | `query: string`, `limit?: number` (default 20, max 100), `only_successful?: boolean` (default false), `mode?: "auto" \| "semantic" \| "keyword"` (default `"auto"`) | Natural-language semantic search (local embeddings) with keyword fallback; successes rank first, annotated `[exit N]` |
| `get_recent_commands` | `limit?: number` (default 10, max 100) | N most recent commands, for general context (noise filtered, outcomes annotated) |

Example — "have I fixed this docker error before?":

```json
{ "query": "docker wont start", "limit": 10 }
```

Semantic search matches *meaning*, not just words — that query surfaces a past `sudo systemctl enable --now docker` fix even though they share almost no tokens. When only keywords match, or semantic is unavailable, the same FTS5 keyword ranking from Phase 2 applies.

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

## Semantic search (Phase 4) — local embeddings, keyword fallback

`search_history` defaults to `mode: "auto"`: meaning-based search when available, FTS5 keyword search otherwise. Pass `mode: "semantic"` to force it (falls back with a visible note if unavailable) or `mode: "keyword"` for the pure Phase 2/3 behavior. Denylist, `only_successful`, outcome tiers, and `[exit N]` annotations behave identically on both paths — only relevance scoring differs.

- **Model**: `Xenova/all-MiniLM-L6-v2`, int8-quantized, 384 dims, ONNX CPU inference via `@huggingface/transformers`. Chosen because it's fully offline after a one-time download (cloud APIs rejected per local-first; an Ollama-style daemon rejected as an extra dependency; native-heavy toolchains rejected per the no-compilation principle).
- **Storage (one-time)**: ~23 MB model weights in `~/.cache/mnemyx/models` (override with `HF_HOME`; deliberately outside `node_modules` so reinstalls never trigger a re-download), ~350 MB of npm packages (almost entirely the ONNX runtime's multi-platform binaries), ~3 MB of vectors for ~2000 commands inside the existing SQLite DB, ~100–200 MB RAM while embedding.
- **Flow**: on startup the server serves immediately (keyword path) while missing commands embed in the background (~8 s per ~400 commands on a 12-core CPU; noise-denylisted commands are skipped). New history rows embed the same way on subsequent launches.
- **Scale-up path**: one constant in `src/embeddings.ts` (`EMBEDDING_DTYPE: "q8"` → `"fp32"`, ~87 MB download, or a larger model id). Stored vectors are tagged with the exact model id, so old vectors are pruned and re-embedded automatically — no migration.
- **Disable**: `{ "embeddings": false }` in `~/.mnemyx/config.json` → pure keyword search, model never loads. If the model can't load (offline first run, broken install), the tool degrades to keyword results instead of erroring — it never breaks entirely.

## Outcome signal (Phase 3) — optional shell hook

Search hits can now tell "I tried this" from "this actually worked". Each command may carry its exit code: `[exit 0]` worked, `[exit 1]` failed, no marker means unknown (all history from before you install the hook — unknown is *not* failure). Ranking puts proven successes first, unknowns next, failures last; pass `only_successful: true` to see *only* proven exit-0 commands.

This requires a tiny shell hook that logs each command's exit code to `~/.mnemyx/exit-codes.log` (local JSON lines, one per command). **It is strictly opt-in — Mnemyx never touches your shell config.** Without the log file everything behaves exactly as Phase 2.

**Setup (2 minutes):**

1. Prerequisites: `python3` on your PATH (preinstalled on macOS and most Linux distros), then:
   ```bash
   mkdir -p ~/.mnemyx
   ```
2. Append **one** of these blocks to your rc file:

   zsh (`~/.zshrc`):
   ```sh
   # --- Mnemyx (optional): log each command's exit code locally for shell-history search.
   # Appends JSON lines to ~/.mnemyx/exit-codes.log. Nothing leaves your machine.
   # Remove this block to disable.
   _mnemyx_precmd() {
     local code=$?
     local cmd
     cmd=$(fc -ln -1 2>/dev/null | sed -e 's/^[[:space:]]*//')
     if [ -n "$cmd" ]; then
       MNEMYX_CODE="$code" MNEMYX_CMD="$cmd" python3 -c \
         'import json,os,time; print(json.dumps({"ts":int(time.time()),"exit":int(os.environ["MNEMYX_CODE"]),"cmd":os.environ["MNEMYX_CMD"]}))' \
         >> "$HOME/.mnemyx/exit-codes.log" 2>/dev/null
     fi
     return "$code"
   }
   autoload -Uz add-zsh-hook 2>/dev/null && add-zsh-hook precmd _mnemyx_precmd
   ```

   bash (`~/.bashrc`):
   ```sh
   # --- Mnemyx (optional): log each command's exit code locally for shell-history search.
   # Appends JSON lines to ~/.mnemyx/exit-codes.log. Nothing leaves your machine.
   # Remove this block (and the PROMPT_COMMAND entry) to disable.
   _mnemyx_prompt() {
     local code=$?
     local cmd
     cmd=$(history 1 2>/dev/null | sed -e 's/^[[:space:]]*[0-9]*[[:space:]]*//')
     if [ -n "$cmd" ]; then
       MNEMYX_CODE="$code" MNEMYX_CMD="$cmd" python3 -c \
         'import json,os,time; print(json.dumps({"ts":int(time.time()),"exit":int(os.environ["MNEMYX_CODE"]),"cmd":os.environ["MNEMYX_CMD"]}))' \
         >> "$HOME/.mnemyx/exit-codes.log" 2>/dev/null
     fi
     return "$code"
   }
   if [[ "${PROMPT_COMMAND:-}" != *"_mnemyx_prompt"* ]]; then
     PROMPT_COMMAND="_mnemyx_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
   fi
   ```

3. Reload (`source ~/.zshrc`, or open a new terminal), then verify:
   ```bash
   true; false; tail -n 2 ~/.mnemyx/exit-codes.log
   ```
   You should see two JSON lines, one with `"exit": 0`, one with `"exit": 1`.
4. Restart the MCP server (it re-imports on every launch). Its stderr will report e.g. `exit codes: 12 distinct commands logged, 30 history rows annotated`.
5. Search: hits for logged commands now show `[exit 0]` / `[exit 1]`; try `only_successful: true` to filter to proven fixes.

Semantics to know: matching is by exact command text, and a command keeps its **most recent** observed exit code. Re-imports are idempotent. The log is append-only (no rotation yet — a few KB per thousand commands; safe to truncate anytime, worst case outcomes return to unknown until commands re-run).

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

No env vars, no API keys — everything is local. `~/.mnemyx/config.json` is optional (missing file = built-in defaults):

```json
{ "denylist": ["vim", "nano", "htop"], "embeddings": true }
```

- `denylist`: extra noise commands, *added to* the built-ins. Takes effect immediately.
- `embeddings`: `false` disables semantic search entirely (pure keyword, model never loads).

The SQLite DB lives outside the repo so it works regardless of launch cwd:

- Linux: `~/.local/share/mnemyx/mnemyx.db` (respects `XDG_DATA_HOME`)
- macOS: `~/Library/Application Support/mnemyx/mnemyx.db`

Re-imports are idempotent (`INSERT OR IGNORE` on `(command, timestamp, source_file)`), so restarting the server never creates duplicates.

## Project layout

```text
src/
  config.ts           # denylist + embeddings flag, ~/.mnemyx/config.json loader
  db.ts               # bun:sqlite schema, FTS5 index, vector store, ranked search, exit codes
  embeddings.ts       # local ONNX embedder, backfill, cosine search
  exitLog.ts          # ~/.mnemyx/exit-codes.log path + tolerant JSONL parser
  historyParser.ts  # zsh + bash parsers + auto-detect merge
  index.ts          # MCP stdio server: startup import + 2 tools
```

## Non-goals (later phases)

- Phase 5: full config file, `mnemyx init` CLI, npm publish
- Any networking, cloud sync, or telemetry
