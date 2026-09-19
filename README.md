# Mnemyx

[![npm version](https://img.shields.io/npm/v/mnemyx.svg)](https://www.npmjs.com/package/mnemyx)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun_%E2%89%A5_1.4-black.svg)](https://bun.sh)

Mnemyx is a local-first [MCP](https://modelcontextprotocol.io) server that gives AI coding assistants a searchable memory of your real shell history.

**The problem:** you solve the same cryptic errors repeatedly across projects and months, but the fix is buried unsearchable in `~/.zsh_history` or `~/.bash_history`. AI assistants (Claude Code, Claude Desktop, Cursor, …) have zero access to it and re-derive solutions from scratch every session. Mnemyx indexes your shell history locally — with full-text search, outcome tracking, and semantic matching — and exposes it as MCP tools, so any compatible client can ask *"have I solved this before?"* and get back what you actually ran, whether it worked, and what it means.

**Contents:** [Quickstart](#5-minute-quickstart) · [Connect your client](#connect-your-ai-client) · [Using Mnemyx](#using-mnemyx) · [Tools](#tools) · [Dashboard](#dashboard-local-only-web-ui) · [How it works](#how-it-works) · [Secrets redaction](#secrets-redaction) · [Error search](#error-search-phase-8) · [Git integration](#git-integration-phase-6) · [Architecture](#architecture) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting) · [Privacy](#privacy-whats-stored-where-what-never-happens) · [Contributing](#contributing) · [Releases](#releases--provenance-maintainers)

## 5-minute quickstart

### 1. Install — pick one

```bash
bun install -g mnemyx        # recommended (needs Bun >= 1.4 — https://bun.sh)
npm install -g mnemyx        # needs Node/npm + Bun ≥ 1.4 on PATH
pnpm add -g mnemyx           # pnpm
yarn global add mnemyx       # Yarn (classic)
```

Just trying it? No install needed (needs Bun):

```bash
bunx mnemyx init
```

> Throwaway trial only: `bunx` cache paths shift between versions, so a client registered against one breaks on the next update (`-32000`). Re-register after a real install below.

From source:

```bash
git clone https://github.com/NoahMenezes/Mnemyx.git && cd Mnemyx
bun install
bun run src/cli.ts init
```

> Size honesty: the package itself is tiny (~92 KB). A full install pulls ~550 MB of ONNX runtime binaries (install-time only, multi-platform) and the first semantic run downloads a ~23 MB model to `~/.cache/mnemyx/models` (then works offline forever). Want a slim (~27 MB, keyword-only) install? Append `--omit=optional` (`npm`/`bun`/`pnpm` all accept it). Semantic queries then fall back to keyword search; set `"embeddings": false` in config to silence the note.

No Bun? Grab a standalone binary from the
[Releases page](https://github.com/NoahMenezes/Mnemyx/releases)
(`mnemyx-<os>-<arch>` = CLI, `mnemyx-server-<os>-<arch>` = MCP server —
point your client at the server binary directly, no `bun run` prefix).
Binaries serve keyword search plus all history/git/session tools; semantic
embeddings need the npm install above (the ONNX native binding can't be
compiled in — the binary says so on stderr and keeps serving).

`python3` is only needed for the optional exit-code hook.

### 2. Set up

```bash
mnemyx init
```

Walks you through four steps: environment check → history import + git indexing (both idempotent, safe to re-run) → **optional** shell-hook install or v1→v2 upgrade (asks first, never silent) → client registration commands. Then verify:

1. `mnemyx status` — commands indexed, FTS docs, vectors, commits, repos, hook state.
2. `mnemyx doctor` — deployment self-check: bun path, server entry, DB writability, config, plus a real MCP handshake (catches what clients report as `-32000`).
3. In your client: ask it to call `get_recent_commands` — you should see your real recent commands.
4. Ask *"have I ever fixed a docker permissions error?"* — `search_history` should find it, including *why* it matches.

If the client shows `MCP error -32000: Connection closed`: run `mnemyx doctor` first — it names the broken piece (stale path, bare `bun`, missing file). Then restart the client.

No client handy? Test with the MCP Inspector (no setup needed — run from the checkout, or swap in your global `dist/index.js` path):

```bash
bun run src/cli.ts init   # from the checkout once, so there's something indexed
bunx @modelcontextprotocol/inspector /home/you/.bun/bin/bun run /absolute/path/to/mnemyx/src/index.ts
# global install: ... /absolute/path/to/mnemyx/dist/index.js (same shape, absolute bun path)
```

### 3. Update

```bash
bun install -g mnemyx@latest      # or: npm update -g mnemyx / pnpm add -g mnemyx@latest / yarn global add mnemyx
mnemyx init                       # re-run: indexes new commits, upgrades the hook if needed (safe anytime)
mnemyx doctor                     # confirm the registered server path still resolves after the update
```

### 4. Uninstall — remove everything

```bash
bun remove -g mnemyx              # or: npm uninstall -g mnemyx / pnpm remove -g mnemyx / yarn global remove mnemyx
```

That removes the program. Your shell hook and local data stay until you delete them:

```bash
# 1. hook: delete the block marked "--- Mnemyx" from ~/.zshrc and/or ~/.bashrc, then restart your shell
# 2. data (Linux):
rm -rf ~/.mnemyx ~/.local/share/mnemyx ~/.cache/mnemyx/models
#    data (macOS):
rm -rf ~/.mnemyx ~/Library/Application\ Support/mnemyx ~/.cache/mnemyx/models
```

What each path holds: `~/.mnemyx/` = config + exit-code log; the `share` / `Application Support` dir = SQLite index (rebuilt by `mnemyx init`); `models` = downloaded embedding weights (re-downloaded on demand).

## Connect your AI client

The server runs over stdio — the client spawns it locally. **Pick the row that matches how you installed** (they are not interchangeable). `mnemyx init` prints the exact commands for your setup — copy its output when in doubt. `mnemyx doctor` verifies the path afterwards.

| How you installed | Server path to register | Command shape |
|---|---|---|
| Source checkout (`git clone`) | `<checkout>/src/index.ts` | `<abs-bun> run <checkout>/src/index.ts` |
| Global install (`bun install -g mnemyx` / `npm install -g mnemyx`) | `<pkg>/dist/index.js` (e.g. `$(npm root -g)/mnemyx/dist/index.js`, never `src/index.ts` — the tarball ships only `dist/`) | `<abs-bun> run <pkg>/dist/index.js` |
| Standalone binary (Releases / `install.sh` / AUR / Homebrew) | `mnemyx-server-<os>-<arch>` (or `mnemyx-server` on PATH) | `/absolute/path/to/mnemyx-server` **directly, no `bun run` prefix** |

Rules that prevent `MCP error -32000: Connection closed`:
- Always use **absolute paths** for both the bun binary and the server file (clients spawn with a minimal PATH/cwd — relative paths and bare `bun` break, especially in GUI apps).
- Prefer a global install over `bunx` cache paths, which shift between versions and rot your registered path.
- Raise the client timeout to **≥30000ms** on first run (model download + initial import can exceed 5s defaults).
- **Restart the client / reload MCP servers** after editing config, then verify (`claude mcp list`, `/mcp`, `opencode mcp list`, or Inspector below).

**Claude Code** (terminal — `mnemyx init` can run this for you with consent):

```bash
# source checkout:
claude mcp add mnemyx -- /home/you/.bun/bin/bun run /absolute/path/to/mnemyx/src/index.ts
# global install:
claude mcp add mnemyx -- /home/you/.bun/bin/bun run /absolute/path/to/mnemyx/dist/index.js
# binary: claude mcp add mnemyx -- /absolute/path/to/mnemyx-server
```

Then `/mcp` to confirm it's connected. Restart the terminal session if it doesn't appear.

**Claude Desktop** — add to `claude_desktop_config.json` (`~/.config/Claude/claude_desktop_config.json` on Linux, `~/Library/Application Support/Claude/` on macOS). Use the **absolute** bun path — GUI-launched apps inherit a minimal PATH that usually lacks `~/.bun/bin`:

```json
{
  "mcpServers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/dist/index.js"]
    }
  }
}
```

> Source checkout? Replace `dist/index.js` with `<checkout>/src/index.ts`. Binary? Use `"command": "/absolute/path/to/mnemyx-server"` with no `args`.

Restart Claude Desktop afterwards.

**Cursor** — Settings → MCP → Add server (same command/args shape as above, absolute `bun` path recommended), or add to `.cursor/mcp.json` in your workspace:

```json
{
  "mcpServers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/dist/index.js"]
    }
  }
}
```

Restart Cursor / reload MCP servers afterwards. Source/binary variants as above.

### Free clients (no Claude subscription needed)

Mnemyx is a plain local stdio server — any MCP client works. Verified shapes:

**OpenCode** (terminal TUI, open-source) — `opencode.json`:

```json
{
  "mcp": {
    "mnemyx": {
      "type": "local",
      "command": ["/home/you/.bun/bin/bun", "run", "/absolute/path/to/mnemyx/dist/index.js"],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

> Source checkout? Use `<checkout>/src/index.ts`. Binary? Use `"command": ["/absolute/path/to/mnemyx-server"]`. After editing, restart opencode and check `opencode mcp list`.

**Goose CLI** (open-source, Apache-2.0) — `~/.config/goose/config.yaml` (or `goose configure` → Add Extension → Command-line Extension):

```yaml
extensions:
  - type: stdio
    name: mnemyx
    cmd: /home/you/.bun/bin/bun
    args: ["run", "/absolute/path/to/mnemyx/dist/index.js"]
    timeout: 30000
```

Restart Goose afterwards. Source/binary variants as above.

**Cline** (VS Code extension, free) — `cline mcp` wizard, or `~/.cline/mcp.json`:

```json
{
  "mcpServers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/dist/index.js"],
      "disabled": false
    }
  }
}
```

Reload the window afterwards.

**Zed** (free IDE) — Settings → AI → MCP Servers → Add Local Server, which writes to your settings file:

```json
{
  "context_servers": {
    "mnemyx": {
      "command": "/home/you/.bun/bin/bun",
      "args": ["run", "/absolute/path/to/mnemyx/dist/index.js"]
    }
  }
}
```

Restart Zed afterwards.

No-client testing is always free via the MCP Inspector (see quickstart).

## Using Mnemyx

Two doors, same memory: the **CLI** for your terminal, the **MCP tools** for your AI assistant. Both read the same local index.

### CLI reference — every command

```bash
mnemyx init [--yes] [--no-hook] [--shell zsh|bash]
# First-time setup AND everyday refresh. Idempotent — re-run anytime to
# import new history + index new commits. --yes skips confirmations,
# --no-hook skips the shell-hook step, --shell forces zsh or bash.

mnemyx status
# Read-only health report. Changes nothing. Run this first whenever
# anything looks off — commands, FTS docs, vectors, commits, repos,
# hook state, and effective config (see example below).

mnemyx doctor
# Deployment self-check. Answers "will my client connect?": bun path,
# server entry, dashboard bundle, DB writability, config, history files,
# plus a real MCP handshake. Exit 0 = launchable, 1 = fix the ✗ lines,
# then re-run mnemyx init && mnemyx doctor and restart your client.
```

```text
mnemyx status (v0.1.2)

Database:  /home/you/.local/share/mnemyx/mnemyx.db
  commands:   2279
  FTS index:  2279 docs
  vectors:    1507 (Xenova/all-MiniLM-L6-v2:q8)
  commits:    1361 (git history, Phase 6)
  repos:      10 discovered under repoRoots
Config:    /home/you/.mnemyx/config.json (using built-ins)
  denylist: 16 entries, embeddings: true, exit codes: true, max age: unlimited
Hook:      installed in /home/you/.zshrc
Exit log:  368 lines (/home/you/.mnemyx/exit-codes.log)
History files:
  found    /home/you/.zsh_history (zsh)
  found    /home/you/.bash_history (bash)
Model cache: /home/you/.cache/mnemyx/models
Plugins:   none (/home/you/.mnemyx/plugins)
```

```bash
mnemyx run -- <command...>
# Run anything with your terminal byte-identical AND log its exit code +
# stderr tail locally. The exit code passes through untouched.
mnemyx run -- python3 train.py --lr 0.01
mnemyx run -- npm test
# Failures become searchable via search_by_error; successes annotate history
# rows with proven exit-0. This is how error output enters the index —
# nothing is captured automatically (see Error search below).

mnemyx export (--session <id> | --commit <hash>) [--with-diff] [--out FILE] [--force]
# Shareable redacted markdown to stdout — or to an owner-only file with --out.
mnemyx export --session s1726069200-myproj
mnemyx export --commit b77d1e0 --with-diff --out notes.md
# Secrets stay [redacted]; --out never overwrites without --force.
# Get ids from list_sessions / search_commits (or their MCP twins below).

mnemyx dashboard [--port 4877] [--no-open]
# Local-only web UI (loopback, read-only): search, sessions, commits,
# error search, status. --no-open for SSH/headless. Ctrl+C stops it.

mnemyx bench [--rows N] [--queries N] [--skip-semantic]
# Synthetic perf baseline on a throwaway DB. Changes nothing — safe to run
# anytime you wonder "is it slow, or is it me".

mnemyx --help | --version
```

### Recipes — the flows you'll actually use

**1. "It broke — have I seen this before?" (debugging)**

```bash
mnemyx run -- python3 train.py --lr 0.01   # reproduces the failure + captures it
```

Then ask your assistant: *"Use mnemyx search_by_error for '<paste the traceback>'"* → past commands whose stderr matches, exact matches first, each with the proving snippet. Thin results? `search_history` automatically backfills from past error output too.

**2. "What was I doing?" (standup, context restore)**

Ask: *"Use mnemyx get_recent_commands"* for the last N commands, or *"Use mnemyx list_sessions for this repo"* for work bursts (when, how long, ok/fail/?, commits, top commands). Drill in with *"Use mnemyx get_session for \<id\>"*, share with *"Use mnemyx export_notes for that session"* — paste-ready markdown for the PR or wiki.

**3. "Why does this line exist?" (code archaeology)**

Ask in order: *"Use mnemyx get_repo_status for this repo"* (what's dirty right now) → *"Use mnemyx explain_line for \<file\> line \<N\> in this repo"* (blame → commit → what you ran before it) → *"Use mnemyx get_commit_diff for \<hash\>"* (the change, review-style) → *"Use mnemyx get_file_history for \<file\>"* (every commit that ever touched it).

**4. "I just committed — make it searchable"**

After every commit, ask *"Use mnemyx reindex_repos"* (or run `mnemyx init`). Then `search_commits` and `get_commit_story` know about it.

**5. "Is it healthy?"**

Run `mnemyx status` for the index plus `mnemyx doctor` for deployability. Zero commands? Re-run `mnemyx init`. Zero commits? Add roots to `repoRoots` in `~/.mnemyx/config.json`. No vectors? Check stderr for `embedding model unavailable: <reason>`. Client `-32000` while status looks fine? That's `doctor` territory (stale path, bare `bun`, timeout) — status can't see it.

Exact argument lists for every assistant-facing tool live in [Tools](#tools) below; the click-around twin of all of this is [Dashboard](#dashboard-local-only-web-ui).

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
| `search_history` | `query: string`, `limit?: number` (default 20, max 100), `only_successful?: boolean` (default false), `mode?: "auto" \| "semantic" \| "keyword"` (default `"auto"`), `repo_path?: string`, `only_repo?: boolean` (default false) | Natural-language semantic search over your history (local embeddings) with FTS5 keyword fallback. Proven exit-0 commands rank first; hits carry ✅/❌/— outcome badges. When text matches are thin, past *error output* backfills (labeled section, failures only). Pass `repo_path` (workspace root / git toplevel) to sort this project's commands first; `only_repo` restricts strictly |
| `search_by_error` | `error_text: string`, `limit?: number` (default 20, max 100), `repo_path?: string`, `only_repo?: boolean` (default false) | Paste a traceback/error — normalized (paths, pids, line numbers stripped) and matched against real past stderr, exact matches first, then same-repo, then recency. Each hit shows the command plus the proving error snippet |
| `get_recent_commands` | `limit?: number` (default 10, max 100), `repo_path?: string`, `only_repo?: boolean` (default false) | N most recent commands (noise filtered, outcomes annotated). With `repo_path`, this project's commands sort first, chronology kept within each group |
| `get_project_profile` | `repo_path: string` | Lightweight usage profile for one project: command count + share of total, succeeded/unknown/failed split, activity window, top command names |
| `search_commits` | `query: string`, `limit?: number` (default 20, max 100) | Keyword search over indexed git commit messages + file lists, across all repos. Hits carry short hash, date, files, and `repo:` path |
| `get_commit_context` | `commit_hash: string` (full or ≥7-char prefix) | One commit: message, date, files, repo, plus on-demand `git show --stat` |
| `get_commit_story` | `commit_hash: string`, `window_minutes?: number` (default 30, max 180), `with_diff?: boolean` (default false) | Commit context PLUS the shell commands from the window before it — timeline of what you did, then what you committed. Same-repo commands (v2 hook) sort first; the rest are time-only. `with_diff: true` appends the diff preview |
| `explain_line` | `repo_path: string`, `file_path: string` (relative), `line_number: number` | Flagship: `git blame` finds who touched the line, then returns that commit's story. Answers "why does this line exist" |
| `get_repo_log` | `repo_path: string`, `limit?: number` (default 15, max 30) | ASCII commit graph (`git log --graph`): hash, date, message per line, branches drawn |
| `get_commit_diff` | `commit_hash: string`, `repo_path?: string`, `file?: string` (repo-relative), `max_lines?: number` (default 120, max 500) | Unified diff like a review view: per-file `+added −removed`, `@@` hunks, `+`/`-` lines. Secrets masked, binaries collapsed, truncated past caps. Works even for unindexed commits |
| `get_repo_status` | `repo_path: string` | What's dirty now: branch + ahead/behind, staged / unstaged / untracked |
| `get_file_history` | `repo_path: string`, `file_path: string` (relative), `limit?: number` (default 10, max 50) | Every commit touching one file (follows renames), newest first, each with `+added −removed` for that file |
| `reindex_repos` | — | Re-scan `repoRoots` + index new commits (idempotent). Run after committing |
| `list_sessions` | `limit?: number` (default 10, max 30), `repo_path?: string`, `only_repo?: boolean`, `gap_minutes?: number` (default 30, max 180), `since_days?: number` (max 90) | Bursts of related commands + the commits they led to, one table row per session, newest first. Splits on quiet gaps or repo switches |
| `get_session` | `session_id: string`, `gap_minutes?: number` | Full detail for one session: timing, outcomes, commands in story order, commits |
| `export_notes` | `kind: "session" \| "commit_story"`, `id: string`, `with_diff?: boolean` (default false) | Opt-in shareable export as redacted markdown (source header + session/story body) for PRs or wikis. Nothing leaves the machine except what you paste |

All list-style outputs render as markdown tables (pipes escaped, long cells capped), graphs and diffs as fenced blocks — every terminal agent renders them natively.

Usage examples (as you'd prompt your assistant):

- *"Use mnemyx search_history for 'docker wont start'"* → your past `sudo systemctl enable --now docker` fix, even though the words barely overlap.
- *"Use mnemyx search_history for 'usermod', only successful ones"* → just the commands proven to exit 0.
- *"Use mnemyx search_history for 'commi' in keyword mode"* → prefix-matched `git commit` rows (exact-token search, no semantics).
- *"Use mnemyx get_recent_commands to see what I was doing"* → recent context, noise (`ls`, `cd`) filtered out.
- *"Use mnemyx search_commits for 'phase 5'"* → your `aad7b9a phase 5 done` commit with files + repo.
- *"Use mnemyx explain_line for README.md line 1 in this repo"* → blamed commit + diff stat + what you ran before it.
- *"Use mnemyx get_commit_diff for b77d1e0"* → the change itself, review-style.
- *"Use mnemyx get_repo_status for this repo"* → what's dirty right now.
- *"Use mnemyx list_sessions for this repo"* → recent work bursts as a table (when, how long, outcomes, commits, top commands).
- *"Use mnemyx get_session for s1726069200-myproj"* → that burst in full: commands in story order + the commits they led to.
- *"Use mnemyx export_notes for that session"* → the same content as redacted markdown, ready to paste into a PR or wiki.

**Sharing work.** `mnemyx export --session <id> [--out notes.md] [--force]` and `mnemyx export --commit <hash> [--with-diff]` print the same redacted markdown to stdout (pipe it to `pbcopy`, or `--out` a file — owner-only, never overwritten without `--force`). A `source: mnemyx export` header records the date and redaction count; secrets stay `[redacted]` because export reuses the already-masked display text — there is no raw path through it.

## Dashboard (local-only web UI)

Prefer browsing to prompting? `mnemyx dashboard` serves a read-only web UI on `http://127.0.0.1:4877` and opens your browser:

```bash
mnemyx dashboard [--port 4877] [--no-open]
```

Tabs for search (keyword/auto, repo scope, exit-0 filter), sessions (click a row for commands + commits), commits, error search, and a status page — real HTML tables, dark terminal theme, secrets masked end to end (the JSON API reuses the same redact-then-display pipeline as the MCP tools, and the page escapes everything it renders). Safety rules: binds loopback only (never `0.0.0.0`), GET-only (no mutations — reindex/export stay in CLI/MCP), `--no-open` for SSH/headless, Ctrl+C stops and nothing persists.

**Reading tables.** History, commits, sessions, diffs, and status all render as bordered tables inside `text` fences — quote them verbatim instead of reformatting:

```text
┌───┬─────────────┬───────┬──────┬───────────────────────────────────┐
│ # │ Date        │ Shell │ Exit │ Command                           │
├───┼─────────────┼───────┼──────┼───────────────────────────────────┤
│ 1 │ 09-16 14:22 │ zsh   │ ✅ 0 │ sudo systemctl enable --now …     │
│ 2 │ 09-16 14:20 │ bash  │ ❌ 1 │ python3 train.py --lr 0.01        │
└───┴─────────────┴───────┴──────┴───────────────────────────────────┘
```

```text
┌──────────────────┬───────────────────┬─────┬──────┬──────┬───────────┬─────────┬───────────┐
│ Session          │ When              │ Dur │ Repo │ Cmds │ ok/fail/? │ Commits │ Top       │
├──────────────────┼───────────────────┼─────┼──────┼──────┼───────────┼─────────┼───────────┤
│ s1726069200-mn…  │ 09-16 14:02→14:41 │ 39m │ mn…  │   18 │ 14/2/2    │ a1b2c3d │ git, docker │
└──────────────────┴───────────────────┴─────┴──────┴──────┴───────────┴─────────┴───────────┘
```

Multiline commands collapse newlines to `↵` so rows never break; `|` inside commands needs no escaping against drawn borders; secrets mask to `[redacted]` inside cells.

**Reading diffs.** `get_commit_diff` renders close to a side-by-side review, in plain text your agent can quote:

```text
diff b77d1e0 (5 files, +447 −4)
┌──────────────────┬─────┬────┐
│ File             │ +   │ −  │
├──────────────────┼─────┼────┤
│ README.md        │ +4  │ −1 │
│ src/config.ts    │ +89 │ −3 │
└──────────────────┴─────┴────┘
```diff
--- a/README.md b/README.md | +4 −1
--- a/README.md
+++ b/README.md
@@ -209,7 +209,8 @@ Design notes: ...
   "embeddings": true,
-  "redactPatterns": ["mycompany-internal-\\d+"]
+  "redactPatterns": ["mycompany-internal-\\d+"],
+  "repoRoots": ["~/dev", "~/projects"]
 }
…
… [truncated, 40 more lines across 2 more files]
```

Per-file `+added −removed` headers, `@@ -old +new @@` hunks, context lines, `-`/`+` lines — the same information as the GitHub/VS Code views. Caps: 120 lines + 5 files by default (`max_lines` up to 500, `file` to narrow one file); binaries collapse to one line; secrets mask to `[redacted]` (the planted `password=hunter2` test proves it). `get_commit_story` appends the same preview as section 4 with `with_diff: true` (default false — diffs eat context).

## How it works

**Supported shells (macOS/Linux, zsh + bash).** `~/.zsh_history` (extended `: timestamp:duration;command` format, including multiline commands) and `~/.bash_history` (plain lines, file-mtime fallback timestamps marked approximate) are auto-detected, parsed, merged, and tagged with `source_file` + `shell`. Missing files are skipped gracefully.

**Search in layers.** `auto` mode tries vectors first, then FTS5 BM25 keyword ranking (multi-word queries AND-narrow, prefix matching), then substring match for symbol-only queries — the tool always returns *something* rather than erroring. `only_successful: true` restricts to proven exit-0 rows (unknown outcomes are excluded: unknown ≠ worked).

**Outcome signal (optional hook).** A ~20-line `precmd`/`PROMPT_COMMAND` snippet logs `{"ts","exit","cmd","cwd","repo"}` lines to `~/.mnemyx/exit-codes.log` (`repo` is the enclosing `git rev-parse --show-toplevel`, empty outside a repo). Each history row keeps its most recent observed exit code; ranking tiers successes → unknowns → failures, and commit stories prefer same-repo commands. Install via `mnemyx init` (asks first) or copy from the snippet below. v1 hooks (no `cwd`) keep working but stay time-only — re-run `mnemyx init` to upgrade in place. To fully uninstall, remove the block from your rc file (a `{"exitCodes": false}` config only stops *reading* the log).

```sh
# zsh (~/.zshrc) — full snippet; bash version in `mnemyx init` / source
# --- Mnemyx (optional): log each command's exit code locally for shell-history search.
# Appends JSON lines to ~/.mnemyx/exit-codes.log. Nothing leaves your machine.
# Remove this block to disable.
# mnemyx-hook-version: 2
_mnemyx_precmd() {
  local code=$?
  local cmd
  cmd=$(fc -ln -1 2>/dev/null | sed -e 's/^[[:space:]]*//')
  local cwd repo
  cwd=$(pwd 2>/dev/null)
  repo=$(git rev-parse --show-toplevel 2>/dev/null)
  if [ -n "$cmd" ]; then
    MNEMYX_CODE="$code" MNEMYX_CMD="$cmd" MNEMYX_CWD="$cwd" MNEMYX_REPO="$repo" python3 -c \
      'import json,os,time; print(json.dumps({"ts":int(time.time()),"exit":int(os.environ["MNEMYX_CODE"]),"cmd":os.environ["MNEMYX_CMD"],"cwd":os.environ.get("MNEMYX_CWD") or "","repo":os.environ.get("MNEMYX_REPO") or ""}))' \
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

## Error search (Phase 8)

`search_by_error` matches on the *real error message* you're facing right now against real past stderr — stronger signal than command text when the traceback is all you have.

**Honest limitation: capture is explicit, not automatic.** The interactive hook (`precmd`/`PROMPT_COMMAND`) runs *after* your command finishes, when stderr is already gone — there is no post-hoc API to recover it, and an always-on output tee would perturb fullscreen apps, colors, and pipes. So errors enter through `mnemyx run`, which executes with your terminal byte-identical and logs exit + stderr tail:

```bash
mnemyx run -- python3 train.py --lr 0.01   # exit code passes through; failures become searchable
mnemyx init                                 # stamps exit + stderr into history rows
```

Then in your client: *"Use mnemyx search_by_error for '<paste traceback>'"* → past commands whose stderr normalizes the same, exact matches first, each with the proving snippet. `search_history` also backfills from error matches (labeled `Also matched past error output`) when text hits are thin.

**Matching.** Both stored rows and your query go through `normalizeError` (`src/errorFingerprint.ts`, small commented regex list): Python keeps the exception line, Node the `Error:` head, Rust/Go the panic message; paths → `<PATH>`, addresses/UUIDs/timestamps/pids/`file:line` → placeholders. Unknown formats degrade to verbatim tail (reruns still match). Stored: redacted snippet (confirm by eye) + fingerprint (match on).

**Privacy.** Command text follows store-raw/display-masked. Stderr is the deliberate exception: **redacted before storage** — `redactSecrets` runs inside the import transaction, so a key in error output never reaches the `.db` file (not even WAL). Proven by test: fake `AKIA…` + `password=` in, `grep` of raw DB bytes finds nothing. Success output is never stored (failures only), capped at 2000 chars.

## Git integration (Phase 6)

Mnemyx correlates shell history with local git history, so the AI answers "what actually changed" not just "what did I run".

**How it works.** On startup (background, like embeddings) and on every `mnemyx init`, the server discovers repos under `repoRoots` (`~/.mnemyx/config.json`, defaults `~/dev ~/projects ~/code ~/Desktop`, depth 3, symlink-safe) and runs **one** `git log` per repo (capped at 2000 commits) into a `commits` table — hash, message, author time, file list. Full diffs are never stored; `git show --stat` runs on demand. No git library, no network, failures skip with a warning.

**Correlation is repo-aware when the v2 hook is active, time-only otherwise.** zsh/bash history records no cwd, so without hook context `get_commit_story` matches commands by timestamp window (default 30 min before the commit) and says so. With the v2 hook, same-repo commands sort first and the story notes it — read remaining entries as "around then", not "in this repo".

**Guide:**

1. `mnemyx init` → `commits: +N new (M seen across R repos)`. Zero repos? Add roots to config.
2. In your client: `search_commits for 'phase 5'` → commits with `repo:` paths.
3. `get_commit_story` on a hash → message + diff stat + commands timeline.
4. `explain_line` on `repo_path` + relative `file_path` + `line_number` → blamed commit + story. Path traversal (`../`) is rejected; stale index says "run `reindex_repos`" instead of "not found".
5. After committing, run `reindex_repos` (tool) or `mnemyx init` to make it searchable.

## Architecture

```text
  sources                              indexers                          SQLite (bun:sqlite, WAL)
  ───────                              ────────                          ─────────────────────
  ~/.zsh_history ──┐
                   ├─→ historyParser ──→ commands (text, ts, shell, source)
  ~/.bash_history ─┘                          │
                                              │  exitLog (v1/v2/v3 lines)
  interactive hook (precmd) ── exit+cwd+repo ─┤
  mnemyx run -- <cmd> ────── exit+stderr ─────┤
                                              ↓
                                     commands.exit_code / .cwd / .repo
                                     commands.stderr_snippet (redacted) / .stderr_fp
  git repos ──→ repoScanner ──→ gitIndexer ──→ commits (hash, msg, files, ts)
                (depth 3)       (1 git log spawn per repo)

  commands ──→ commands_fts (triggers)      ║  query paths
  commands ──→ command_embeddings (ONNX) ─→ ║  ═══════════
                                             ║  keyword FTS5 ········→ search_history ─┐
                                             ║  semantic top-K stream ·→ (auto/semantic│
                                             ║  error fp LIKE ·······→  +backfill) ───┤
                                             ║  error fp exact-first → search_by_error ┤
                                             ║  recency ·············→ get_recent_cmds ┤
  commits ───→ LIKE search ··················→ search_commits ─────────────────────────┤
  git CLI on demand (stat/diff/blame/ ──────→ get_commit_context / _story / _diff ────┤
    graph/status/log --follow)             explain_line / repo_log / ─────────────────┤
                                           repo_status / file_history                  │
  discover+index ··························→ reindex_repos ───────────────────────────┤
                                                                                        ↓
                                                              MCP stdio server (index.ts)
                                              CLI: init / status / doctor / bench / run / export / dashboard (cli.ts)
```

Labels: `──→` stored (SQLite), `····→` computed on demand (git CLI / in-memory).
Secrets: commands masked at display (`formatRows`); git output masked per call
(`redactGitOutput`); stderr redacted *before* storage (import transaction).
Every stage degrades: no hook → unknown exits, no model → keyword, no repos →
history tools unaffected, no stderr → error tools report empty, never crash.

## Configuration

`~/.mnemyx/config.json` is optional — missing file means built-ins. Read fresh on every call, so edits apply without restarts:

```json
{
  "denylist": ["vim", "nano", "htop"],
  "embeddings": true,
  "exitCodes": true,
  "maxHistoryAgeDays": 365,
  "redactPatterns": ["mycompany-internal-\\d+"],
  "repoRoots": ["~/dev", "~/projects"],
  "ranking": { "frequencyWeight": 1.0, "recencyWeight": 1.0, "recencyHalfLifeDays": 30 },
  "plugins": true,
  "disabledPlugins": []
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
| `ranking` | `{frequencyWeight: 1, recencyWeight: 1, recencyHalfLifeDays: 30}` | Learning-to-rank blend (Phase 13): habitual + recent commands rank above stale one-offs within equal outcome tiers. `0` weights = legacy order; malformed fields fall back one by one |
| `plugins` | `true` | `false` = ignore `~/.mnemyx/plugins/` entirely |
| `disabledPlugins` | `[]` | Plugin names to skip (see `PLUGINS.md`) |

`mnemyx status` prints the effective configuration plus DB/hook/model health without changing anything. `mnemyx doctor` goes one step further and proves the client can actually spawn the server (bun path, entry file, live handshake).

## Troubleshooting

- **Client shows `MCP error -32000: Connection closed`.** Run `mnemyx doctor` — it names the broken piece. Usual suspects in order: (1) stale server path (moved checkout? `bunx` cache rotated? global install uses `dist/index.js`, never `src/index.ts`); (2) bare `bun` on PATH-less GUI clients (use the absolute path from `which bun`); (3) first-run timeout (raise client timeout to ≥30000ms, pre-warm with `mnemyx init`); (4) forgot to restart the client after editing config. Fix, restart the client, re-run `mnemyx doctor`.
- **Client says the server fails to start / `bun: command not found`.** The client spawns `bun` with a minimal PATH. Re-register using the absolute bun path (`which bun`) — `mnemyx init` prints it. Verify with `mnemyx doctor` from a terminal first.
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
bun test             # 186 tests, hermetic (temp DBs/configs/repos, stubbed model) — must be green
bun run src/cli.ts status   # health check against your real data
bun run src/cli.ts doctor   # deployability check (bun, entry, live MCP handshake)
```

- Runtime is Bun; storage is `bun:sqlite` (no `better-sqlite3`, no native compilation); MCP over stdio only.
- Scope: macOS/Linux, bash/zsh. Out of scope unless explicitly revisited: Windows/PowerShell/fish/WSL, cloud sync, telemetry, embeddings that need a network call at query time.
- Every phase must stay shippable alone: new behavior degrades to old behavior when its input is absent (no hook log → Phase 2 results; no model → keyword search; no history file → skip, never crash).
- stdout belongs to the MCP transport in `src/index.ts` — log to stderr only.
- Test against real history in an isolated way: point `HOME` at a temp dir for import tests, use temp DB paths via `initDb(path)`, never commit `*.db*` files.

## Releases & provenance (maintainers)

Tag `v*` triggers `.github/workflows/release.yml`: cross-compiled standalone binaries (`mnemyx-<os>-<arch>`, `mnemyx-server-<os>-<arch>` for linux-x64/arm64, darwin-x64/arm64) → GitHub Release with `SHA256SUMS.txt` → npm publish (keyless OIDC, needs one-time `npm login` + Trusted Publisher enabled, otherwise the `publish` job fails with auth error while binaries still release fine).

Release with:

```bash
git tag v0.1.3 && git push --tags
```

### Build provenance on private repos — the `attest` failure, fixed

The workflow's `Attest build provenance` step used to fail the whole release on private repos with:

```text
Run actions/attest@ce27ba3b4a9a139d9a20a4a07d69fabb52f1e5bc
Error: Failed to persist attestation: Feature not available for user-owned private repositories.
```

Root cause: GitHub Artifact Attestations are only available on **public** repos (all plans) or private/internal repos with GitHub Enterprise Cloud + GHAS. On a user-owned private repo (Free/Pro/Team) the API refuses to store the attestation — binaries and the Release itself are fine, only this step goes red. Workflow permissions (`id-token: write`, `attestations: write`) were already correct; no permission change fixes it.

Fix applied in `release.yml` (three parts, all intentional):

```yaml
- name: Attest build provenance
  if: github.event.repository.visibility == 'public'
  continue-on-error: true
  uses: actions/attest-build-provenance@v3
```

1. `if: ... == 'public'` — skip while private; lights up automatically when the repo is flipped public, no re-edit needed.
2. `continue-on-error: true` — belt-and-suspenders: even on public, a transient Sigstore outage warns instead of failing the release (and unblocking the `publish` job, which `needs: [binaries]`).
3. `v2` → `v3` — clears the `Node 20 is being deprecated` runner warning (`v2` chain runs on `node20`; `v3` runs on `node24`). Inputs (`subject-path`) are unchanged. `id-token: write` + `attestations: write` are kept declared — harmless while private, required when public.

Behavior matrix:

| Repo visibility | Attest step | Release | npm publish |
|---|---|---|---|
| Private (current) | Skipped (green) | Binaries + Release upload normally, `SHA256SUMS.txt` still generated + verified in CI | Works once Trusted Publisher is configured |
| Public | Runs, attaches Sigstore provenance to `dist-bin/mnemyx-*` + `SHA256SUMS.txt` | Same, plus provenance | Same, plus npm `--provenance` |

If you want provenance on a private repo today, the only paths are GitHub Enterprise Cloud or making the repo public — there is no workflow flag that enables it on Free/Pro/Team private repos.

## Project layout

```text
src/
  index.ts          # MCP server entry: wires src/tools/* and serves stdio
  tools/            # MCP tool definitions, one concern per file:
    history.ts      #   search_history, search_by_error, recents, profile
    git.ts          #   commits, stories, blame, diff, status, file history
    activity.ts     #   sessions, export_notes
  cli.ts            # CLI entry: usage + dispatch (bin target, keep path stable)
  cli/              # CLI commands, one per file:
    shared.ts       #   version, bun/server-path resolution, home helper
    input.ts        #   stdin prompts (ask/askText)
    status.ts       #   read-only health report
    doctor.ts       #   deployment self-check (bun, entry, MCP handshake)
    init.ts         #   setup wizard (consent-gated hook install)
    run.ts          #   transparent run wrapper (exit + stderr capture)
    exportCmd.ts    #   shareable redacted markdown export
    dashboardCmd.ts #   local-only web UI launcher
  dashboard/        # Phase 10 local web UI (read-only, loopback-only):
    server.ts       #   Bun.serve wiring (127.0.0.1, GET-only routes)
    api.ts          #   masked JSON handlers (same queries as MCP tools)
    page.html       #   single-file UI (tabs, tables, no dependencies)
  import.ts         # the one shared import pipeline (server and CLI both use it)
  db.ts             # barrel: re-exports src/db/* (public API unchanged)
  db/               # SQLite layer, one concern per file:
    types.ts        #   row interfaces + canonical SELECT column lists
    connection.ts   #   handle lifecycle, busy-retry, limits
    paths.ts        #   per-user DB path resolution
    schema.ts       #   tables, migrations, FTS5 index, vector/commit stores
    scope.ts        #   query primitives (LIKE/FTS/rank/repo scope, Phase 13 blend)
    commands.ts     #   history writes, keyword search, recents, exit stamping
    vectors.ts      #   Phase 4 embedding BLOB store
    commits.ts      #   Phase 6 commit store + queries
    errors.ts       #   Phase 8 error-fingerprint search + rendering
    profile.ts      #   Phase 7 per-project usage profile
    format.ts       #   LLM-facing rendering (redact + sanitize choke point)
  historyParser.ts  # zsh extended + bash plain parsers, dedupe, auto-detect merge
  exitLog.ts        # exit-code log path + tolerant JSONL parser
  embeddings.ts     # local ONNX embedder, background backfill, cosine search
  config.ts         # ~/.mnemyx/config.json loader (all keys, incl. repoRoots)
  errorFingerprint.ts # Phase 8: stderr normalization rules + match fingerprints
  repoScanner.ts    # Phase 6: discover git repos under repoRoots (depth-capped, never throws)
  gitIndexer.ts     # Phase 6: one-spawn-per-repo git log index + on-demand diff stat + blame
                    # + graph / unified diff / status / file-history passthroughs (all masked)
  correlate.ts      # Phase 6: time-window stories (same-repo first) + line explanations
  sessions.ts       # Phase 9: on-demand burst clustering (list/get) + table rendering
  plugins.ts        # Phase 13: ~/.mnemyx/plugins loader + psql reference (see PLUGINS.md)
  redact.ts         # secrets redaction for tool output (store raw, display masked)
  hook.ts           # shell-hook snippets (v2: exit+cwd+repo) + consent-gated installer/upgrader
  bench.ts          # synthetic perf baseline for `mnemyx bench` (temp DB, changes nothing)
  export.ts         # shareable redacted-markdown builders (sessions + commit stories)
  fsutil.ts         # small filesystem helpers (owner-only checks, fd-level reads)
  *.test.ts         # hermetic suite: bun test (temp DBs, fixture strings, stub model)
```

License: MIT — see [LICENSE](LICENSE).
