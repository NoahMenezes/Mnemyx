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

- [x] Create missing labels — done 2026-09-24 (`dependencies`, `security`; defaults already covered the rest).
  ```bash
  gh label create dependencies --repo NoahMenezes/Mnemyx \
    --description "Pull requests that update a dependency file" --color "0366d6"
  gh label create security --repo NoahMenezes/Mnemyx \
    --description "Security reports and redaction issues (never post real secrets)" --color "ee0701"
  ```
- [ ] Dependabot PRs run the full CI gate (typecheck + lint + 186 tests) — safe to merge on green.
- [ ] Enable private vulnerability reporting (Settings → Security) — SECURITY.md points reporters there.
- [ ] Branch protection for `main`: require `check` job + PR before merging.
- [ ] Enable Discussions (Settings → General) so "how do I…?" stays out of issues.
