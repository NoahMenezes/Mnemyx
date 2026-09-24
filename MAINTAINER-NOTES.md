# Maintainer notes

Reminders about repo-health files and what still needs attention. Not user docs.

## Community files (added, uncommitted)

- `.github/FUNDING.yml` — Sponsor button wired to `github: NoahMenezes`.
  TODO: edit if Ko-fi / Open Collective / custom URL apply (commented lines show format).
- `SUPPORT.md` — self-help ladder (`status` → `doctor` → README sections) plus
  routing table for Discussions / bug / feature / security advisory.
- `.github/dependabot.yml` — weekly Monday bumps for Bun deps + GitHub Actions,
  capped at 5 open PRs each, labeled `dependencies`.

## Follow-ups

- [ ] Create a `dependencies` label in GitHub (Issues → Labels), or Dependabot PRs show up unlabeled.
- [ ] Dependabot PRs run the full CI gate (typecheck + lint + 186 tests) — safe to merge on green.
- [ ] Enable private vulnerability reporting (Settings → Security) — SECURITY.md points reporters there.
- [ ] Branch protection for `main`: require `check` job + PR before merging.
- [ ] Enable Discussions (Settings → General) so "how do I…?" stays out of issues.
