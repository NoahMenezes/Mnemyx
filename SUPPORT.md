# Getting help

Self-serve first — most questions are answered already:

1. `mnemyx status` and `mnemyx doctor` — status shows index health, doctor proves
   your client can actually spawn the server (fixes most `-32000` reports).
2. [README Troubleshooting](README.md#troubleshooting) — connection closed,
   keyword-fallback, hook, and platform issues.
3. [README Configuration](README.md#configuration) — every config key and default.
4. [PLUGINS.md](PLUGINS.md) — extra history sources.

Still stuck? Where to ask:

| Channel | Use for |
|---|---|
| [Discussions](https://github.com/NoahMenezes/Mnemyx/discussions) | "How do I…?", setup help, ideas not yet shaped into a proposal |
| [Bug report](https://github.com/NoahMenezes/Mnemyx/issues/new?template=bug_report.yml) | Something broken, with `status`/`doctor` output |
| [Feature request](https://github.com/NoahMenezes/Mnemyx/issues/new?template=feature_request.yml) | A scoped proposal (see scope rules in [CONTRIBUTING.md](CONTRIBUTING.md)) |
| [Private security advisory](https://github.com/NoahMenezes/Mnemyx/security/advisories/new) | Credential leaks, redaction bypasses — **never post these publicly** (see [SECURITY.md](SECURITY.md)) |

No-client testing is always available via the MCP Inspector (see the README
quickstart) — useful for proving whether a problem is Mnemyx or your client.
Response times are best-effort; this is a nights-and-weekends project.
