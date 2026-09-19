# Changelog

All notable changes to Mnemyx. Versions follow semantic versioning.
The full history lives in git; this file is the narrative layer.

## 0.1.2 — MCP stability + deployment readiness

- **Never `-32000` on startup** — the server degrades instead of dying:
  import, config, and embedding-count failures log a repair hint and keep
  serving the existing index (`mnemyx status` / `mnemyx init` fix the cause).
- **New `mnemyx doctor` command** — deployment self-check: bun path,
  server entry, dashboard bundle, DB writability, config, history files,
  plus a real MCP handshake. Exit 0 = launchable.
- **Packaging that launches** — `dist/index.js` is executable with a bun
  shebang, plus a dedicated `mnemyx-server` bin so registry/`bunx` flows
  speak MCP instead of printing CLI usage.
- **Docs that match installs** — per-install client table (source /
  global / binary), absolute-path + timeout + restart rules, `doctor`
  wired into quickstart, recipes, config, and troubleshooting.
- **CI guards the npm artifact** — handshake test on `bun run
  dist/index.js`, exec-bit + `page.html` assertions.

## Unreleased

- **Slim installs (packaging)** — `@huggingface/transformers` moved to
  `optionalDependencies`: omit optionals at install time for a ~27 MB
  keyword-only install (measured) instead of ~550 MB. Slim installs
  degrade to keyword search with an actionable hint; `"embeddings":
  false` silences it. No code-path changes — the lazy dynamic import
  already degraded gracefully.
- **Learning-to-rank (Phase 13)** — habitual + recent commands rank
  above stale one-offs within equal outcome tiers, on both keyword and
  semantic paths. Tunable via `ranking` in config; zero weights restore
  the legacy order exactly.
- **Plugin sources (Phase 13)** — `~/.mnemyx/plugins/*.mjs` files feed
  extra local history (psql reference included) through the same
  pipeline. Bad plugins skip with a warning, never break imports.
  See `PLUGINS.md`.
- **Export (Phase 11)**, **sessions (Phase 9)**, **project scoping
  (Phase 7)** — see README Tools.
- **Bordered tables everywhere** — all list outputs render as bordered
  Unicode tables in `text` fences, quoted verbatim by agents.

## 0.1.0 — First public release

Local-first MCP server: searchable memory of your real shell history.
Nothing leaves your machine — no telemetry, no cloud, no accounts.

- **History search** — zsh extended + bash parsers (multiline, NFD-safe),
  FTS5 keyword ranking with prefix matching, local ONNX semantic search
  (`Xenova/all-MiniLM-L6-v2`, int8) with keyword fallback.
- **Outcome tracking** — opt-in shell hook logs exit codes; proven exit-0
  commands rank first. v2 hook adds working directory + git repo context.
- **Secrets redaction** — provider tokens, key=value assignments, PEM
  blocks masked on display; stderr redacted *before* storage.
- **Git integration** — repo discovery, commit index, ASCII graph,
  review-style unified diffs, blame-to-story (`explain_line`),
  dirty-tree status, per-file history with `+added −removed`.
- **Error search** — `mnemyx run -- <cmd>` captures stderr tails;
  `search_by_error` matches normalized fingerprints (paths, pids,
  line numbers stripped), exact matches first.
- **CLI** — `init` wizard (consent-gated hook install), read-only
  `status`, synthetic `bench`, transparent `run` wrapper.
- **Clients** — any MCP stdio client: Claude Code/Desktop, Cursor,
  OpenCode, Goose, Cline, Zed, MCP Inspector.
