// ---------------------------------------------------------------------------
// Secrets redaction. Shell history routinely contains pasted credentials
// (`export AWS_SECRET=…`, `curl -H "Authorization: Bearer …"`), and MCP tool
// output goes straight to an AI client — so secrets must never reach it.
//
// Design: STORE raw, REDACT ON OUTPUT. The DB keeps the true command text
// (preserves searchability: you can still find "the deploy using that key"),
// and formatRows() masks values just before display. One choke point covers
// every present and future tool. Calibration rule: a pattern must not match
// ordinary commands (there are tests asserting `git commit` etc. pass
// through byte-identical).
// ---------------------------------------------------------------------------

export const REDACTED = "[redacted]";

interface Rule {
  name: string;
  /** Applied with the global flag. */
  pattern: RegExp;
  /** String.replace replacement ($1 groups work); defaults to wholesale mask. */
  replacement?: string;
}

function rule(name: string, source: string, flags = "g", replacement?: string): Rule {
  return { name, pattern: new RegExp(source, flags), replacement };
}

// Default rules — high-precision shapes only (provider prefixes, key=value
// with sensitive names, auth headers, PEM blocks). Deliberately no bare
// "long random string" rule: that false-positives on hashes and commit SHAs.
const DEFAULT_RULES: Rule[] = [
  rule("aws-access-key", "\\bAKIA[0-9A-Z]{16}\\b"),
  rule("github-token", "\\bgh[pousr]_[A-Za-z0-9_]{36,}\\b"),
  rule("github-pat", "\\bgithub_pat_[A-Za-z0-9_]{22,}\\b"),
  rule("slack-token", "\\bxox[bpras]-[A-Za-z0-9-]{10,}\\b"),
  rule("bearer-auth", "\\bBearer\\s+[A-Za-z0-9\\-._~+/]+=*", "gi"),
  // Keeps user@host, masks only the password segment.
  rule(
    "basic-auth-url",
    "(https?://[^/\\s:]+:)([^@\\s]+)(@)",
    "gi",
    `$1${REDACTED}$3`
  ),
  rule(
    "pem-block",
    "-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
    "g"
  ),
  rule(
    "discord-webhook",
    "discord\\.com/api/webhooks/\\S+",
    "gi"
  ),
];

// Sensitive assignment: `password=…`, `--token …`, `secret: …`.
// Only the VALUE is masked (keeps `password=` readable); the key must be a
// standalone word, which is what makes this precise enough to ship.
const ASSIGN_KEY =
  "\\b(?:password|passwd|pwd|secret|token|api[_-]?key|auth[_-]?token|access[_-]?token|client[_-]?secret)\\b";

// `export AWS_SECRET=…`: the sensitive word must be a full `_`-separated
// segment of the variable name, so `export MONKEY=business` is left alone
// while `export AWS_SECRET=x` and `export Token=x` are masked.
const SENSITIVE_SEGMENTS = new Set(["KEY", "SECRET", "TOKEN", "PASSWORD"]);

function maskExport(text: string): { text: string; hit: boolean } {
  const re =
    /\bexport\s+([A-Za-z_]+)((?:\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s"']+))/gi;
  let hit = false;
  const out = text.replace(
    re,
    (m: string, name: string, rest: string): string => {
      const sensitive = name
        .toUpperCase()
        .split("_")
        .some((seg) => SENSITIVE_SEGMENTS.has(seg));
      if (!sensitive) return m;
      hit = true;
      const eq = rest.match(/^\s*=\s*/)?.[0] ?? "=";
      return `export ${name}${eq}${REDACTED}`;
    }
  );
  return { text: out, hit };
}

function maskValue(text: string, keyPattern: string): { text: string; hit: boolean } {
  // Matches `KEY=val`, `KEY: val`, `KEY val`, `--key=val`, with the value as
  // a quoted string (may contain spaces) or a bare token. The whole value
  // is replaced so `password="a b c"` can't leak partially.
  const re = new RegExp(
    `(${keyPattern}(?:\\s*=\\s*|\\s*:\\s*|\\s+))("[^"]*"|'[^']*'|[^\\s"']+)`,
    "gi"
  );
  let hit = false;
  const out = text.replace(re, (_m: string, prefix: string) => {
    hit = true;
    return `${prefix}${REDACTED}`;
  });
  return { text: out, hit };
}

// Compile cache for user patterns (config is re-read per call; compiling
// per call would waste work, and a throwing pattern must never break output).
// Two guards against ReDoS from a hostile/mistaken pattern:
// 1. at most MAX_USER_PATTERNS are kept (rest warn-and-skip);
// 2. each pattern is timed once against an adversarial input — one that is
//    slow to reject (> REDOS_BUDGET_MS) is dropped with a warning, because it
//    would run on EVERY formatted row.
export const MAX_USER_PATTERNS = 50;
const REDOS_BUDGET_MS = 25;
// biome-ignore lint/style/useTemplate: concatenation reads clearer than a template here
const REDOS_PROBE = "a".repeat(64) + "!" + "b".repeat(64);
// Textbook catastrophic-backtracking shape: a quantified group containing a
// quantifier — (a+)+, (a*)*, (\w+)*, (a|aa)+. Rejected statically (no
// execution needed); the timing probe below catches non-obvious slow ones.
// Rationale: a user attacking themselves via their own config is out of the
// threat model, but a copy-pasted hostile pattern shouldn't hang queries.
const NESTED_QUANTIFIER = /\([^()]*[+*][^()]*\)[+*?]/;

const compiledCache = new Map<string, RegExp[]>();

function compileUserPatterns(sources: string[]): RegExp[] {
  const key = JSON.stringify(sources);
  const cached = compiledCache.get(key);
  if (cached) return cached;
  const compiled: RegExp[] = [];
  for (const src of sources.slice(0, MAX_USER_PATTERNS)) {
    if (NESTED_QUANTIFIER.test(src)) {
      console.error(
        `[mnemyx] ignoring redactPatterns regex ${JSON.stringify(src)} (nested quantifiers risk catastrophic backtracking)`
      );
      continue;
    }
    let re: RegExp;
    try {
      re = new RegExp(src, "g");
    } catch (err) {
      console.error(
        `[mnemyx] ignoring invalid redactPatterns regex ${JSON.stringify(src)}: ${err instanceof Error ? err.message : String(err)}`
      );
      continue;
    }
    const t0 = Date.now();
    try {
      re.lastIndex = 0;
      void REDOS_PROBE.replace(re, REDACTED);
    } catch {
      continue;
    }
    if (Date.now() - t0 > REDOS_BUDGET_MS) {
      console.error(
        `[mnemyx] ignoring slow redactPatterns regex ${JSON.stringify(src)} (possible catastrophic backtracking)`
      );
      continue;
    }
    re.lastIndex = 0;
    compiled.push(re);
  }
  if (sources.length > MAX_USER_PATTERNS) {
    console.error(
      `[mnemyx] ignoring ${sources.length - MAX_USER_PATTERNS} redactPatterns beyond the ${MAX_USER_PATTERNS} cap`
    );
  }
  compiledCache.set(key, compiled);
  return compiled;
}

export interface RedactResult {
  text: string;
  /** True if anything was masked (caller adds the marker). */
  redacted: boolean;
}

export function redactSecrets(
  text: string,
  extraPatterns: string[] = []
): RedactResult {
  let out = text;
  let hit = false;
  for (const r of DEFAULT_RULES) {
    const next = out.replace(r.pattern, r.replacement ?? REDACTED);
    if (next !== out) {
      hit = true;
      out = next;
    }
  }
  const assign = maskValue(out, ASSIGN_KEY);
  out = assign.text;
  hit = hit || assign.hit;
  const exp = maskExport(out);
  out = exp.text;
  hit = hit || exp.hit;
  for (const re of compileUserPatterns(extraPatterns)) {
    re.lastIndex = 0;
    const next = out.replace(re, REDACTED);
    if (next !== out) {
      hit = true;
      out = next;
    }
  }
  return { text: out, redacted: hit };
}
