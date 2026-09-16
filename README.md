# Mnemyx

Mnemyx is a local-first [MCP](https://modelcontextprotocol.io) server that gives AI coding assistants a searchable memory of your real shell history.

**The problem:** you solve the same cryptic errors repeatedly across projects and months, but the fix is buried unsearchable in `~/.zsh_history` or `~/.bash_history`. AI assistants (Claude Code, Claude Desktop, Cursor, …) have zero access to it and re-derive solutions from scratch every session. Mnemyx indexes your shell history locally — with full-text search, outcome tracking, and semantic matching — and exposes it as MCP tools, so any compatible client can ask *"have I solved this before?"* and get back what you actually ran, whether it worked, and what it means.

## 5-minute quickstart

Prerequisites: [Bun](https://bun.sh) ≥ 1.4 (the only runtime dependency) and `python3` (only needed for the optional exit-code hook).

```bash
# Option A: try it without installing (needs Bun)
bunx mnemyx init

# Option B: from source
git clone <repo-url> && cd mnemyx
bun install
bun run src/cli.ts init
```

`mnemyx init` walks you through four steps: environment check → history import (idempotent, safe to re-run) → **optional** shell-hook install (asks first, never silent) → client registration commands. Then verify:

1. `mnemyx status` — commands indexed, FTS docs, vectors, hook state.
2. In your client: ask it to call `get_recent_commands` — you should see your real recent commands.
3. Ask *"have I ever fixed a docker permissions error?"* — `search_history` should find it, including *why* it matches.

No client handy? Test with the MCP Inspector (no setup needed):

```bash
bunx @modelcontextprotocol/inspector bun run src/index.ts
```

## Connect your AI client

The server runs over stdio — the client spawns it locally. Replace the paths with your checkout (or installed package) location.

**Claude Code** (terminal — `mnemyx init` can run this for you with consent):

```bash
claude mcp add mnemyx -- bun run /absolute/path/to/mnemyx/src/index.ts
```

Then `/mcp` to confirm it's connected.

**Claude Desktop** — add to `claude_desktop_config.json` (`~/.config/Claude/claude_desktop_config.json` on Linux, `~/Library/Application Support/Claude/` on macOS). Use the **absolute** bun path — GUI-launched apps inherit a minimal PATH that usually lacks `~/.bun/bin`:

```json
{
  "mcpServers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/src/index.ts"]
    }
  }
}
```

Restart Claude Desktop afterwards.

**Cursor** — Settings → MCP → Add server (same command/args shape as above, absolute `bun` path recommended), or add to `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/src/index.ts"]
    }
  }
}
```

### Free clients (no Claude subscription needed)

Mnemyx is a plain local stdio server — any MCP client works. Verified shapes:

**OpenCode** (terminal TUI, open-source) — `opencode.json`:

```json
{
  "mcp": {
    "mnemyx": {
      "type": "local",
      "command": ["/home/you/.bun/bin/bun", "run", "/absolute/path/to/mnemyx/src/index.ts"],
      "enabled": true
    }
  }
}
```

**Goose CLI** (open-source, Apache-2.0) — `~/.config/goose/config.yaml` (or `goose configure` → Add Extension → Command-line Extension):

```yaml
extensions:
  - type: stdio
    name: mnemyx
    cmd: /home/you/.bun/bin/bun
    args: ["run", "/absolute/path/to/mnemyx/src/index.ts"]
    timeout: 30000
```

**Cline** (VS Code extension, free) — `cline mcp` wizard, or `~/.cline/mcp.json`:

```json
{
  "mcpServers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/src/index.ts"],
      "disabled": false
    }
  }
}
```

**Zed** (free IDE) — Settings → AI → MCP Servers → Add Local Server, which writes to your settings file:

```json
{
  "context_servers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/src/index.ts"]
    }
  }
}
```

No-client testing is always free via the MCP Inspector (see quickstart).

## Platform support

| Platform | History, FTS, tools | Semantic search |
|---|---|---|
| Linux x64, glibc ≥ 2.28 | Full | Full (local ONNX) |
| Linux x64, older glibc / musl (Alpine) / minimal containers | Full | Keyword fallback (no native ONNX prebuild fits) |
| Linux arm64 | Full (binaries bundled) | Expected full — needs a field report, fallback covers |
| macOS Apple Silicon | Full | Expected full — needs a field report, fallback covers |
| macOS Intel | Full | Keyword only — upstream ships no `darwin/x64` ONNX binary and the Node build rejects WASM devices, so there is nothing to load. The server detects this and serves keyword results |

> On Linux arm64 / Apple Silicon: binaries are bundled so full support is expected, but we haven't run it there yet — if you do, please file an issue with your `mnemyx status` output and `uname -m`.

Notes:
- macOS ships bash 3.2 and zsh 5.x — the hook snippets use only constructs legal in both (verified). `python3` is required for the hook: on a fresh Mac the first `python3` run pops a Command Line Tools install dialog (accept it once, or `brew install python3`); `mnemyx init` probes this and warns.
- The hook adds ~40 ms of prompt latency (measured: one `python3` spawn per command). Remove the snippet to disable; nothing else changes.
- For a stable client registration prefer a global install (`bun install -g mnemyx`) over `bunx` cache paths, which can shift between versions. `mnemyx init` always prints paths resolved from its own location.
- DB/log/model files are created owner-only (`0600`, dirs `0700`). Filenames with accented characters match regardless of macOS NFD vs NFC normalization.

## Tools

| Tool | Arguments | What it does |
|---|---|---|
| `search_history` | `query: string`, `limit?: number` (default 20, max 100), `only_successful?: boolean` (default false), `mode?: "auto" \| "semantic" \| "keyword"` (default `"auto"`) | Natural-language semantic search over your history (local embeddings) with FTS5 keyword fallback. Proven exit-0 commands rank first; hits annotated `[exit N]` when the outcome is known |
| `get_recent_commands` | `limit?: number` (default 10, max 100) | N most recent commands, chronological (noise filtered, outcomes annotated) |

Usage examples (as you'd prompt your assistant):

- *"Use mnemyx search_history for 'docker wont start'"* → your past `sudo systemctl enable --now docker` fix, even though the words barely overlap.
- *"Use mnemyx search_history for 'usermod', only successful ones"* → just the commands proven to exit 0.
- *"Use mnemyx search_history for 'commi' in keyword mode"* → prefix-matched `git commit` rows (exact-token search, no semantics).
- *"Use mnemyx get_recent_commands to see what I was doing"* → recent context, noise (`ls`, `cd`) filtered out.

## How it works

**Supported shells (macOS/Linux, zsh + bash).** `~/.zsh_history` (extended `: timestamp:duration;command` format, including multiline commands) and `~/.bash_history` (plain lines, file-mtime fallback timestamps marked approximate) are auto-detected, parsed, merged, and tagged with `source_file` + `shell`. Missing files are skipped gracefully.

**Search in layers.** `auto` mode tries vectors first, then FTS5 BM25 keyword ranking (multi-word queries AND-narrow, prefix matching), then substring match for symbol-only queries — the tool always returns *something* rather than erroring. `only_successful: true` restricts to proven exit-0 rows (unknown outcomes are excluded: unknown ≠ worked).

**Outcome signal (optional hook).** A ~15-line `precmd`/`PROMPT_COMMAND` snippet logs `{"ts","exit","cmd"}` lines to `~/.mnemyx/exit-codes.log`. Each history row keeps its most recent observed exit code; ranking tiers successes → unknowns → failures. Install via `mnemyx init` (asks first) or copy from the snippet below. To fully uninstall, remove the block from your rc file (a `{"exitCodes": false}` config only stops *reading* the log).

```sh
# zsh (~/.zshrc) — full snippet; bash version in `mnemyx init` / source
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

Verify with `true; false; tail -n 2 ~/.mnemyx/exit-codes.log` (one `"exit": 0`, one `"exit": 1`).

## Secrets redaction

Shell history contains pasted credentials, and tool output goes straight to an AI client — so Mnemyx masks secrets on output. Built-in rules cover AWS keys, GitHub/Slack tokens, Bearer auth, basic-auth URLs, PEM private-key blocks, Discord webhooks, and `password=`/`export *_SECRET=`-style assignments (values only — `export AWS_SECRET=` stays readable). Masked hits carry a `[redacted]` tag:

```text
1. [2026-09-10T14:22:31.000Z] [zsh] [redacted] export AWS_SECRET_ACCESS_KEY=[redacted]
   source: /home/you/.zsh_history
```

Design notes: the DB keeps true text (so you can still *find* "the deploy using that key"), masking happens in `formatRows()` — the single choke point all tools share. Ordinary commands pass through byte-identical (guarded by tests). Extend with your own JS regexes via `redactPatterns` in config; invalid patterns warn and skip, never break output.

**Semantic search (local ONNX).** `Xenova/all-MiniLM-L6-v2` int8-quantized (384 dims) embeds commands to SQLite BLOBs; cosine similarity ranks them. The server serves immediately on the keyword path while missing rows embed in the background. Vectors are tagged with the exact model id, so switching models later prunes and re-embeds automatically. One constant (`EMBEDDING_DTYPE: "q8"` → `"fp32"`) scales quality up.

## Configuration

`~/.mnemyx/config.json` is optional — missing file means built-ins. Read fresh on every call, so edits apply without restarts:

```json
{
  "denylist": ["vim", "nano", "htop"],
  "embeddings": true,
  "exitCodes": true,
  "maxHistoryAgeDays": 365,
  "redactPatterns": ["mycompany-internal-\\d+"],
  "repoRoots": ["~/dev", "~/projects"]
}
```

| Key | Default | Meaning |
|---|---|---|
| `denylist` | 16 built-ins (`ls`, `cd`, `clear`, …) | Extra noise commands, *added to* the built-ins (first-word match, case-insensitive) |
| `embeddings` | `true` | `false` = pure keyword search, model never loads |
| `exitCodes` | `true` | `false` = ignore the exit-code log entirely (doesn't uninstall the shell snippet) |
| `maxHistoryAgeDays` | `null` (unlimited) | Only index commands newer than N days; never deletes existing rows |
| `redactPatterns` | `[]` | Extra secret regexes for output masking; invalid ones warn and skip |
| `repoRoots` | `~/dev, ~/projects, ~/code, ~/Desktop` | Roots scanned for git repos (Phase 6). *Replaces* defaults; `~`/relative expand under `$HOME`; missing dirs skipped |

`mnemyx status` prints the effective configuration plus DB/hook/model health without changing anything.

## Troubleshooting

- **Client says the server fails to start / `bun: command not found`.** The client spawns `bun` with a minimal PATH. Re-register using the absolute bun path (`which bun`) — `mnemyx init` prints it. Verify with `mnemyx status` from a terminal first.
- **Semantic search silently returns keyword results.** Expected on Intel Macs, muslLinux, old glibc, or offline first runs. Check server stderr for `embedding model unavailable: <reason>` — it names the cause. `mode: "semantic"` surfaces the same note inside the tool response.
- **Hook installed but no `[exit N]` markers.** Reload the shell (`source ~/.zshrc`), run `true; false`, check `tail ~/.mnemyx/exit-codes.log`. If the file stays empty, `python3` is the usual culprit (see Platform support). Restart the server after — outcomes apply at import.
- **Prompt feels slower after hook install.** ~40 ms per command is the measured cost of the `python3` log call. Remove the snippet block from your rc file to revert instantly.
- **`database is locked` errors.** Two writers colliding beyond the 5 s grace window (large parallel imports). Re-run; imports are idempotent. Persistent cases: check for a stale `-wal`/`-shm` pair or another process holding the DB.
- **Bash `PROMPT_COMMAND` is an array (bash 5.1+).** The snippet's string prepend doesn't apply — prepend `_mnemyx_prompt` to the array manually instead (documented in the snippet comment).
- **Accented characters don't match.** Import and query both normalize to NFC; if you indexed before this fix, re-imports are idempotent and converge on re-runs.

## Privacy: what's stored where, what never happens

- **Nothing leaves your machine. No telemetry, no cloud calls, no accounts, no API keys — ever.** The strongest guarantee is architectural: there is no networking code in this project.
- Shell history stays yours: it's read from your home directory into a local SQLite DB and only ever served back to the MCP client running on the same machine. Pasted credentials are masked (`[redacted]`) before any tool output is produced — see Secrets redaction.
- On-disk footprint (measured): `node_modules` ~550 MB (almost entirely the ONNX runtime's multi-platform binaries — install-time only), model weights ~23 MB in `~/.cache/mnemyx/models` (override with `HF_HOME`; deliberately outside `node_modules` so reinstalls never re-download), SQLite DB ~3 MB for ~2000 commands in `~/.local/share/mnemyx/mnemyx.db` (Linux; `~/Library/Application Support/mnemyx/` on macOS), config + exit log in `~/.mnemyx/`.
- The model downloads once (~23 MB) on first semantic use, then works offline indefinitely. The exit-code log is append-only JSON lines; truncate it anytime (outcomes just return to unknown until commands re-run).

## Contributing

```bash
bun install          # deps (Bun only — never npm/yarn)
bunx tsc --noEmit    # must be clean before any PR
bun test             # 58 tests, hermetic (temp DBs/configs, stubbed model) — must be green
bun run src/cli.ts status   # health check against your real data
```

- Runtime is Bun; storage is `bun:sqlite` (no `better-sqlite3`, no native compilation); MCP over stdio only.
- Scope: macOS/Linux, bash/zsh. Out of scope unless explicitly revisited: Windows/PowerShell/fish/WSL, cloud sync, telemetry, embeddings that need a network call at query time.
- Every phase must stay shippable alone: new behavior degrades to old behavior when its input is absent (no hook log → Phase 2 results; no model → keyword search; no history file → skip, never crash).
- stdout belongs to the MCP transport in `src/index.ts` — log to stderr only.
- Test against real history in an isolated way: point `HOME` at a temp dir for import tests, use temp DB paths via `initDb(path)`, never commit `*.db*` files.

## Project layout

```text
src/
  index.ts          # MCP stdio server: import pipeline + search_history / get_recent_commands
  cli.ts            # `mnemyx` binary: init wizard (consent-gated), status, help
  import.ts         # the one shared import pipeline (server and CLI both use it)
  db.ts             # bun:sqlite schema + migrations, FTS5 index, vector store, ranked search
  historyParser.ts  # zsh extended + bash plain parsers, dedupe, auto-detect merge
  exitLog.ts        # exit-code log path + tolerant JSONL parser
  embeddings.ts     # local ONNX embedder, background backfill, cosine search
  config.ts         # ~/.mnemyx/config.json loader (all keys)
  repoScanner.ts    # Phase 6: discover git repos under repoRoots (depth-capped, never throws)
  redact.ts         # secrets redaction for tool output (store raw, display masked)
  hook.ts           # shell-hook snippets + consent-gated installer
  *.test.ts         # hermetic suite: bun test (temp DBs, fixture strings, stub model)
```

License: MIT — see [LICENSE](LICENSE).
