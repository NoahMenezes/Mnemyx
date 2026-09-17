# Mnemyx

Mnemyx is a local-first [MCP](https://modelcontextprotocol.io) server that gives AI coding assistants a searchable memory of your real shell history.

**The problem:** you solve the same cryptic errors repeatedly across projects and months, but the fix is buried unsearchable in `~/.zsh_history` or `~/.bash_history`. AI assistants (Claude Code, Claude Desktop, Cursor, …) have zero access to it and re-derive solutions from scratch every session. Mnemyx indexes your shell history locally — with full-text search, outcome tracking, and semantic matching — and exposes it as MCP tools, so any compatible client can ask *"have I solved this before?"* and get back what you actually ran, whether it worked, and what it means.

## 5-minute quickstart

Prerequisites: [Bun](https://bun.sh) ≥ 1.4 (the only runtime dependency) and `python3` (only needed for the optional exit-code hook).

> Cold-install honesty: the npm package itself is tiny, but first install pulls ~550 MB of ONNX runtime binaries (multi-platform, install-time only) and the first semantic run downloads a ~23 MB model to `~/.cache/mnemyx/models` (then works offline forever). Keyword search needs none of that.

```bash
# Option A: try it without installing (needs Bun)
bunx mnemyx init

# Option B: from source
git clone https://github.com/NoahMenezes/Mnemyx.git && cd Mnemyx
bun install
bun run src/cli.ts init
```

`mnemyx init` walks you through four steps: environment check → history import + git indexing (both idempotent, safe to re-run) → **optional** shell-hook install or v1→v2 upgrade (asks first, never silent) → client registration commands. Then verify:

1. `mnemyx status` — commands indexed, FTS docs, vectors, commits, repos, hook state.
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
                                              CLI: init / status / bench / run (cli.ts)
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
bun test             # 151 tests, hermetic (temp DBs/configs/repos, stubbed model) — must be green
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
  index.ts          # MCP server entry: wires src/tools/* and serves stdio
  tools/            # MCP tool definitions, one concern per file:
    history.ts      #   search_history, search_by_error, recents, profile
    git.ts          #   commits, stories, blame, diff, status, file history
    activity.ts     #   sessions, export_notes
  cli.ts            # CLI entry: usage + dispatch (bin target, keep path stable)
  cli/              # CLI commands, one per file:
    shared.ts       #   version, paths, home helper
    input.ts        #   stdin prompts (ask/askText)
    status.ts       #   read-only health report
    init.ts         #   setup wizard (consent-gated hook install)
    run.ts          #   transparent run wrapper (exit + stderr capture)
    exportCmd.ts    #   shareable redacted markdown export
  cli.ts            # `mnemyx` binary: init wizard (consent-gated), status, help
  import.ts         # the one shared import pipeline (server and CLI both use it)
  db.ts             # barrel: re-exports src/db/* (public API unchanged)
  db/               # SQLite layer, one concern per file:
    types.ts        #   row interfaces + canonical SELECT column lists
    connection.ts   #   handle lifecycle, busy-retry, limits
    paths.ts        #   per-user DB path resolution
    schema.ts       #   tables, migrations, FTS5 index, vector/commit stores
    scope.ts        #   query primitives (LIKE/FTS/rank/repo scope)
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
  redact.ts         # secrets redaction for tool output (store raw, display masked)
  hook.ts           # shell-hook snippets (v2: exit+cwd+repo) + consent-gated installer/upgrader
  *.test.ts         # hermetic suite: bun test (temp DBs, fixture strings, stub model)
```

License: MIT — see [LICENSE](LICENSE).
