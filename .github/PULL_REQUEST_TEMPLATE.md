<!-- One logical change per PR. Small PRs merge faster than big ones. -->

## What

<!-- 1–2 sentences: what does this change? Link the issue: Fixes #123 -->

## Why

<!-- Why is this needed? What breaks or what's impossible without it? -->

## How tested

<!-- Check all that apply; CI re-runs the gate anyway. -->

- [ ] `bun run typecheck` clean
- [ ] `bun run lint` clean
- [ ] `bun test` green
- [ ] New/updated tests (name them):
- [ ] Manual: `mnemyx status` / `mnemyx doctor` output (paste for user-facing changes):

```text

```

## Docs

<!-- Check all that apply. -->

- [ ] README updated (which section?)
- [ ] CHANGELOG entry under `## Unreleased`
- [ ] No docs needed (internal refactor / test-only / typo)

## Risk & degradation

<!-- What could go wrong? How does this degrade when its input is absent
(no hook log / no model / no history file / no repos)? Rollback = revert? -->

## Checklist

- [ ] Read [CONTRIBUTING.md](CONTRIBUTING.md) and follow scope + privacy rules
- [ ] No networking code added; no secrets in code or fixtures (fake creds only)
- [ ] No version bump (`package.json` / `server.json` stay untouched)
- [ ] Minimal diff — no unrelated reformatting
