import { test, expect } from "bun:test";
import { redactSecrets, REDACTED } from "./redact.ts";
import { formatRows, type CommandRow } from "./db.ts";

function row(command: string): CommandRow {
  return {
    id: 1,
    command,
    timestamp: 1000,
    sourceFile: "/tmp/fake/.zsh_history",
    shell: "zsh",
    timestampApproximate: false,
    exitCode: null,
    cwd: null,
    repo: null,
  };
}

test("provider tokens are masked wholesale", () => {
  const cases: [string, string][] = [
    ["aws configure AKIAIOSFODNN7EXAMPLE", "aws configure"],
    ["git clone https://ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD", "git clone https://"],
    ["export X=1 github_pat_abcdefghijklmnopqrstuvwxyz0123", "export X=1"],
    ["curl -H 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig'", "curl -H 'Authorization:"],
    ["deploy xoxb-123456789012-abcdefghij", "deploy"],
  ];
  for (const [input, keptPrefix] of cases) {
    const r = redactSecrets(input);
    expect(r.redacted).toBe(true);
    expect(r.text).toContain(REDACTED);
    expect(r.text.startsWith(keptPrefix)).toBe(true);
    // The secret value itself must be gone.
    expect(r.text).not.toContain("EXAMPLE");
    expect(r.text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  }
});

test("key=value assignments mask only the value", () => {
  const r = redactSecrets(`curl -d password=hunter2 https://api/x`);
  expect(r.redacted).toBe(true);
  expect(r.text).toBe(`curl -d password=${REDACTED} https://api/x`);
  const quoted = redactSecrets(`login --token "a b c secret here" --verbose`);
  expect(quoted.text).toBe(`login --token ${REDACTED} --verbose`);
  expect(quoted.text).not.toContain("secret here");
});

test("export respects underscore segments (MONKEY stays, AWS_SECRET masks)", () => {
  expect(redactSecrets("export MONKEY=business").redacted).toBe(false);
  expect(redactSecrets("export MONKEY=business").text).toBe(
    "export MONKEY=business"
  );
  expect(redactSecrets("export PATH=/usr/bin:/bin").redacted).toBe(false);
  const masked = redactSecrets("export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI");
  expect(masked.redacted).toBe(true);
  expect(masked.text).toBe(`export AWS_SECRET_ACCESS_KEY=${REDACTED}`);
  expect(redactSecrets("export Token=abc123").text).toBe(
    `export Token=${REDACTED}`
  );
});

test("PEM blocks and basic-auth URLs mask", () => {
  const pem = redactSecrets(
    "echo -----BEGIN RSA PRIVATE KEY-----\nMIIBOg==\n-----END RSA PRIVATE KEY----- | clip"
  );
  expect(pem.redacted).toBe(true);
  expect(pem.text).not.toContain("MIIBOg");
  const url = redactSecrets("git clone https://user:s3cr3t@host/repo.git");
  expect(url.text).toBe("git clone https://user:[redacted]@host/repo.git");
});

test("ordinary commands pass through byte-identical (no over-matching)", () => {
  const ordinary = [
    "git commit -m fix",
    "sudo dnf install fira-code-fonts -y",
    "docker ps --all",
    "ls -la /tmp",
    "echo hello world",
    "make; make install",
    "export EDITOR=vim",
    "curl -fsSL https://example.com/install.sh | bash",
    "ps aux | grep postgres",
    "tar -xzvf archive.tar.gz",
  ];
  for (const cmd of ordinary) {
    const r = redactSecrets(cmd);
    expect(r.redacted).toBe(false);
    expect(r.text).toBe(cmd);
  }
});

test("user patterns extend; invalid regexes warn and skip safely", () => {
  const r = redactSecrets("deploy mycompany-internal-42 now", [
    "mycompany-internal-\\d+",
    "([unclosed",
  ]);
  expect(r.redacted).toBe(true);
  expect(r.text).toBe(`deploy ${REDACTED} now`);
  const clean = redactSecrets("deploy ordinary now", ["([unclosed"]);
  expect(clean.redacted).toBe(false);
  expect(clean.text).toBe("deploy ordinary now");
});

test("nested-quantifier patterns are rejected statically (ReDoS guard)", () => {
  for (const evil of ["(a+)+$", "(a*)*", "(\\w+)*b", "(a|aa)+$"]) {
    const r = redactSecrets("deploy aaaa now", [evil]);
    // Evil pattern ignored: output equals the no-pattern result.
    expect(r).toEqual(redactSecrets("deploy aaaa now"));
  }
  // Safe lookalikes still work.
  expect(redactSecrets("deploy v1.2 now", ["v\\d+\\.\\d+"]).text).toBe(
    `deploy ${REDACTED} now`
  );
});

test("pattern count is capped at MAX_USER_PATTERNS", async () => {
  const { MAX_USER_PATTERNS } = await import("./redact.ts");
  const many = Array.from({ length: MAX_USER_PATTERNS + 5 }, (_, i) => `zzz${i}zzz`);
  const r = redactSecrets("deploy zzz0zzz now", many);
  expect(r.redacted).toBe(true);
  expect(r.text).toBe(`deploy ${REDACTED} now`);
});

test("formatRows masks secrets, tags the hit, leaves clean rows alone", () => {  const text = formatRows([
    row("export AWS_SECRET=hunter2"),
    row("git status"),
  ]);
  expect(text).not.toContain("hunter2");
  expect(text).toContain(`export AWS_SECRET=${REDACTED}`);
  expect(text).toContain(REDACTED);
  expect(text).toContain("git status");
  // Clean row carries no marker on its line.
  const statusLine = text.split("\n").find((l) => l.includes("git status"));
  expect(statusLine?.includes(REDACTED)).toBe(false);
});
