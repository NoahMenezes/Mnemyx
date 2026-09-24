# Contributing to Mnemyx

Thanks for wanting to contribute! Mnemyx is a local-first MCP server — shell history search, outcome tracking, git correlation, error fingerprinting — and contributions of bug reports, docs, tests, and code are all welcome.

Please read this file plus our [Code of Conduct](CODE_OF_CONDUCT.md) before your first PR. Security issues follow a separate process — see [SECURITY.md](SECURITY.md), do not open a public issue for them.

## Quickstart for contributors

Prerequisites: [Bun](https://bun.sh) >= 1.4, `git`, `python3` (only for the optional exit-code hook).

```bash
git clone https://github.com/NoahMenezes/Mnemyx.git && cd Mnemyx
bun install              # deps (Bun only — never npm/yarn/pnpm install)
bun run typecheck        # must be clean before any PR (bunx tsc --noEmit)
bun run lint             # Biome lint — must be clean before any PR
bun test                 # 186+ hermetic tests — must be green
bun run src/cli.ts status   # health check against your real data
bun run src/cli.ts doctor   # deployability check (bun, entry, live MCP handshake)
```

Useful during development:

```bash
bun run src/cli.ts init      # idempotent setup + reindex (safe to re-run)
bun run src/cli.ts bench     # synthetic perf baseline on a throwaway DB
bun run src/cli.ts dashboard # local web UI at http://127.0.0.1:4877
```

## Ways to contribute

- **Report bugs** — use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml). Include `mnemyx status` output, OS/shell, install method (source / global / binary), and what `mnemyx doctor` says.
- **Request features** — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml). Stay inside scope (below); out-of-scope ideas need a strong case.
- **Improve docs** — README fixes, troubleshooting entries from real field reports, and platform notes (especially Linux arm64 / Apple Silicon — see Platform support) are high-value, low-risk first PRs.
- **Fix bugs / add features** — comment on the issue first if one exists so work doesn't duplicate; for anything larger than a typo, open an issue to agree on approach before coding.

## Scope: what fits this project

- **Runtime:** Bun. Storage: `bun:sqlite`. MCP over stdio only. Don't introduce Express, `better-sqlite3`, `ws`, dotenv, webpack/vite/esbuild, or npm/yarn/pnpm workflows.
- **Platforms:** macOS + Linux, bash + zsh. Out of scope unless explicitly revisited: Windows native / PowerShell / fish, cloud sync, telemetry, query-time network calls for embeddings.
- **Privacy is architectural:** there is no networking code in this project. Never add any (no telemetry, no cloud calls, no accounts, no API keys). CI won't catch philosophy — reviewers will.
- **Degrade, don't die:** every phase stays shippable alone. New behavior must degrade to old behavior when its input is absent (no hook log → unknown exits; no model → keyword search; no history file → skip, never crash). The server must never `process.exit(1)` before `server.connect()` — clients surface that as `MCP error -32000`.
- **`stdout` belongs to the MCP transport** in `src/index.ts` — log to stderr only.

## Project layout

See the `Project layout` section at the end of the [README](README.md) for the authoritative map (`src/tools/*`, `src/cli/*`, `src/db/*`, etc.). One concern per file; new tools/commands follow the existing file-per-concern pattern rather than growing a god module.

## Coding standards

- **TypeScript strict** (`tsconfig.json`): no new `any` without justification, handle `noUncheckedIndexedAccess` (index access may be `undefined`), no fallthrough in switches.
- **Biome lint** (`biome.json`): `bun run lint` must pass. Test files have the `noNonNullAssertion` rule relaxed; source files don't.
- **Style:** match surrounding code (2-space indent, double quotes, semicolons, `.ts` import extensions). No formatter is enforced — keep diffs minimal and don't reformat unrelated lines.
- **Secrets:** history text is stored raw but **masked on display** via the single choke point (`formatRows` in `src/db/format.ts`); stderr is redacted **before storage**. New output paths must reuse the same pipeline — never render unmasked user data to MCP clients, the dashboard JSON API, or export output. Add a regression test with a planted credential (see `src/redact.test.ts` for the pattern).
- **Config:** new options go in `src/config.ts` with a default, are documented in the README Configuration table, and appear in `mnemyx status` output. Config is read fresh on every call — no restart required.
- **Comments:** explain *why*, not *what*. Keep the ASCII-architecture diagram in the README accurate if you change data flow.

## Tests

- Framework: `bun test`. Co-located `*.test.ts` next to the module they cover.
- **Hermetic:** temp DBs via `initDb(path)`, temp `HOME` for import tests, fixture strings, stubbed embedding model. Never touch the developer's real `~/.mnemyx`, real history files, or real git repos. Never commit `*.db*` files (gitignored).
- New behavior needs a test; bug fixes need a regression test that fails before the fix.
- Full suite must be green: `bun test`. If you touch packaging, also run `bun pm pack --dry-run` and the handshake check from CI (`bun run build`, then pipe an `initialize` frame into `dist/index.js` and grep for `serverInfo`).

## Commit messages & PRs

- **Commits:** short imperative subject (≤72 chars, e.g. `fix: ...`, `feat: ...`, `docs: ...`, `test: ...`, `chore: ...`), blank line, then body explaining why. Reference issues (`Fixes #123`) where applicable.
- **Branches:** fork the repo, branch from `main` (`feat/<slug>`, `fix/<slug>`, `docs/<slug>`), one logical change per PR.
- **Before opening a PR**, run the full gate and paste nothing — CI runs it anyway:
  1. `bun install --frozen-lockfile`
  2. `bun run typecheck`
  3. `bun run lint`
  4. `bun test`
- **PR description:** use the template (what / why / how tested / risk + rollback). Include `mnemyx status`/`doctor` output for user-facing changes, and note docs updates (README table? CHANGELOG entry? `PLUGINS.md`?).
- **CHANGELOG:** add user-facing changes under `## Unreleased`. Keep entries to one or two lines in the existing voice.
- **Version bumps:** maintainers only, via tags (`git tag vX.Y.Z && git push --tags`) — don't bump `package.json`/`server.json` versions in feature PRs. Note: `server.json` version must always match `package.json` (CI checks).
- Small PRs merge faster than big ones. Docs-only PRs are welcome without an issue.

## Review process

- A maintainer reviews every PR. Expect requests for tests, docs, or narrower scope — that's normal.
- CI must be green (typecheck + lint + tests + pack dry-run + handshake + server.json sanity). A red CI blocks merge regardless of approvals.
- After approval, maintainers squash-merge with a clean message. Your branch will be deleted; your commit message subject becomes the squash title, so write it well.

## Release process (maintainers)

Tag `v*` triggers `.github/workflows/release.yml`: cross-compiled standalone binaries → GitHub Release with `SHA256SUMS.txt` → npm publish (keyless OIDC). Details and the private-repo attestation caveat live in the README's `Releases & provenance` section — keep that section accurate if the workflow changes.

## Questions?

Open a [discussion or issue](https://github.com/NoahMenezes/Mnemyx/issues) — or ask your AI assistant via the project's own MCP tools. Good first issues: docs gaps, new `redactPatterns` coverage with tests, and platform field reports (`mnemyx status` + `uname -m`).
