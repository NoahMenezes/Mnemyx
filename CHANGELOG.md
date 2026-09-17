# Changelog

All notable changes to Mnemyx. Versions follow semantic versioning.
The full history lives in git; this file is the narrative layer.

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
