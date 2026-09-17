# Mnemyx plugins — local history sources beyond shell + git

Plugins feed extra local history (database shells, cloud CLIs, container
runtimes, …) into the same index your shell history uses. A plugin is one
JS file in `~/.mnemyx/plugins/` exporting a `{ name, parse() }` object.
Nothing leaves your machine; nothing is uploaded, synced, or phoned home.

## Install (example: psql)

```bash
mkdir -p ~/.mnemyx/plugins
# paste the example below into ~/.mnemyx/plugins/psql.mjs
chmod 600 ~/.mnemyx/plugins/psql.mjs
bun run src/cli.ts init   # idempotent — picks up plugin rows
```

`mnemyx status` shows a plugins line (`N file(s) (…)`); `init` reports
which plugins loaded. Rows appear in every history tool tagged
`plugin:<name>:<origin>` — search them like anything else.

## The format

```js
// ~/.mnemyx/plugins/kubectl.mjs
export default {
  // Unique, lowercase: provenance tag + config key for `disabledPlugins`.
  // Letters/digits/_/-, max 64 chars.
  name: "kubectl",

  // Sync or async. Return HistoryEntry rows:
  //   { command: string, timestamp: number (unix sec),
  //     sourceFile: string (real origin, for provenance),
  //     shell: "zsh" | "bash" (whichever is closer),
  //     timestampApproximate?: boolean }
  // Blank commands and bad timestamps are dropped (with a count logged).
  async parse() {
    // ... read your history file, return rows ...
    return [];
  },
};
```

The full worked example ships in the source tree: `src/plugins.ts`
exports `PSQL_EXAMPLE` (copy-paste ready) and `parsePsqlHistory` shows
the plain-line parsing pattern most REPL histories share.

Rules of the road:

- **One directory, capped**: `*.js`/`*.mjs`/`*.cjs` only (sorted load),
  max 20 files, max 10,000 rows per plugin per run.
- **Idempotent**: re-runs insert only genuinely new rows (`INSERT OR
  IGNORE` on command+timestamp+source, same as shell history).
- **Same pipeline**: plugin rows get the age filter, exit-code stamping,
  embeddings, sessions, and error search for free.
- **Failure is local**: a throwing `parse()`, wrong shape, duplicate
  name, or bad path skips that file with a stderr warning — built-in
  imports and the server never break.
- **Disable without deleting**: `"plugins": false` ignores the whole
  dir; `"disabledPlugins": ["kubectl"]` skips one by name.

## Trust model (read this before installing a plugin)

A plugin is **arbitrary local code you placed in your own directory** —
same trust as the shell-hook snippet. Consequences, stated plainly:

- Only install plugins you wrote or reviewed line by line.
- Plugin files must not be writable by group/other (`chmod 600`
  recommended); writable files are skipped with a warning, because on a
  multi-user machine another user could otherwise rewrite your plugin
  between loads and run code as you.
- Plugins get no network access and need none; a plugin that tries to
  `fetch()` is a red flag — don't install it.
- Provenance is always visible: every plugin row carries
  `sourceFile: "plugin:<name>:<origin>"` in tool output.

## Writing a good plugin

1. Return the finest-grained rows you can (one statement per row beats
   one session blob — ranking, sessions, and dedupe all work per row).
2. Timestamps beat fallbacks: use real ones when the format has them;
   otherwise file mtime with `timestampApproximate: true`.
3. Keep `command` raw (secrets mask at display); keep `sourceFile`
   truthful (it's how users judge the hit).
4. Cap your own output sensibly; the loader caps at 10k rows anyway.
