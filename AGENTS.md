# AGENTS.md — instructions for AI coding agents

This repo is **Mnemyx**: Bun + TypeScript, `bun:sqlite`, MCP over stdio. Target: macOS/Linux, bash/zsh.

## Before writing code

1. Read [CONTRIBUTING.md](CONTRIBUTING.md) — scope, privacy, and degrade-don't-die rules apply to you too.
2. Read the `Project layout` section at the end of [README.md](README.md) for the module map.
3. Check `git status` and `git log --oneline -5` for current state.

## Commands (Bun only — never npm/yarn/node/jest/vitest)

- Install: `bun install`
- Gate (all must pass): `bun run typecheck && bun run lint && bun test`
- Health: `bun run src/cli.ts status` and `bun run src/cli.ts doctor`
- Never commit `*.db*`, `dist/`, `dist-bin/`, `node_modules/` (gitignored).

## Hard rules

- `stdout` in `src/index.ts` belongs to the MCP transport — log to stderr only.
- Never add networking code (no telemetry, cloud, accounts, keys). This is architectural.
- Display paths must mask secrets via the shared pipeline (`formatRows` / `redactGitOutput`); stderr is redacted before storage. New output paths need a planted-credential regression test.
- Tests are hermetic: temp DBs via `initDb(path)`, temp `HOME`, stubbed model. Never touch real user data.
- Degrade, don't die: missing hook/model/history/repos must fall back, never crash or `process.exit(1)` before `server.connect()`.
- One concern per file; match surrounding style (2-space, double quotes, semicolons, `.ts` import extensions). Minimal diffs.
- User-facing change? Update README docs + `CHANGELOG.md` (`## Unreleased`). Never bump versions in feature work (`server.json` must match `package.json`).

## Output

Quote tool/table output verbatim (bordered tables in `text` fences, diffs in `diff` fences) — don't reformat into bullets.
