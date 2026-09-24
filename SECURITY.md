# Security Policy

## Why this matters here

Mnemyx reads your shell history — which routinely contains pasted credentials —
and serves it to AI clients on the same machine. The project handles this by
design: no networking code, secrets masked on display, stderr redacted before
storage. A security bug here could leak credentials to a client, so we treat
redaction-bypass and data-exposure reports as security issues, not ordinary bugs.

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

We support the latest minor release. Older versions: upgrade with
`bun install -g mnemyx@latest` (or your package manager's equivalent), then
re-run `mnemyx init` and `mnemyx doctor`.

## Reporting a vulnerability

**Do not open a public GitHub issue for security reports.**

- Open a [private security advisory](https://github.com/NoahMenezes/Mnemyx/security/advisories/new)
  (preferred — keeps details encrypted until a fix ships), or
- Email the maintainer listed as `author` in `package.json` with `[SECURITY]` in the subject.

Include:

1. What you expected vs. what happened (e.g. "token `X` appeared unmasked in `search_history` output").
2. Minimal reproduction steps — **use fake credentials** (e.g. `AKIAIOSFODNN7EXAMPLE`), never real ones.
3. `mnemyx status` output, OS/shell, and install method (source / global / binary).
4. Whether the leak reaches MCP tool output, the dashboard JSON API, CLI stdout, or stored DB bytes.

We will acknowledge receipt within 72 hours, keep you updated on the fix, and
credit you in the release notes unless you ask to stay anonymous.

## What counts

In scope (examples):

- A credential pattern from `src/redact.ts` failing to mask in any output path
  (MCP tools, dashboard API, `export`, diffs, error snippets).
- Real secrets reaching stored bytes (DB file, WAL, logs) — stderr must be
  redacted **before** storage.
- Path traversal or command injection via tool arguments (`repo_path`,
  `file_path`, `commit_hash`, dashboard query params).
- Dashboard binding beyond loopback or a mutating route (it must stay
  loopback-only, GET-only).
- Dependency vulnerability that is actually reachable at runtime
  (not dev-only noise).

Out of scope:

- Your own shell history containing secrets (that's expected input —
  masking happens on output; rotate any credential you pasted into a terminal).
- Reports that require a compromised local machine (Mnemyx assumes the OS user
  boundary holds; the DB/config files are owner-only `0600`/`0700` for that reason).
- Automated scanner output without a confirmed reproduction.

## If you think you leaked something

1. **Rotate the credential first** — masking is output-side; the raw text you
   pasted is still in your shell history file.
2. Re-run `mnemyx init` to re-import (stderr rows are redacted before storage;
   command text masks on display via `redactPatterns` in `~/.mnemyx/config.json`
   for your own custom patterns).
3. Then tell us if masking failed anywhere — that's the actionable bug.
