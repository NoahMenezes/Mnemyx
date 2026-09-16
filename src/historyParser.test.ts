import { test, expect } from "bun:test";
import {
  parseZshHistory,
  parsePlainHistory,
  dedupeConsecutive,
  getHistoryFilePaths,
} from "./historyParser.ts";
import type { HistoryEntry } from "./db.ts";

const SRC = "/home/test/.zsh_history";
const FALLBACK = 999;

function mk(command: string): HistoryEntry {
  return {
    command,
    timestamp: 1,
    sourceFile: SRC,
    shell: "zsh",
    timestampApproximate: false,
  };
}

test("zsh extended lines parse timestamp and keep ; inside commands", () => {
  const rows = parseZshHistory(
    ": 1787806104:0;sudo dnf install foo -y\n: 1787806136:5;make; make install\n",
    SRC,
    FALLBACK
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.command).toBe("sudo dnf install foo -y");
  expect(rows[0]?.timestamp).toBe(1787806104);
  expect(rows[0]?.timestampApproximate).toBe(false);
  expect(rows[0]?.shell).toBe("zsh");
  expect(rows[1]?.command).toBe("make; make install");
});

test("zsh multiline commands joined: user backslash + escape backslash", () => {
  // Real encoding seen in the wild: the user's own trailing `\` plus the
  // file's escape `\` = `\\` + newline. Must become ONE entry with the
  // user's single backslash restored and the real timestamp kept.
  const rows = parseZshHistory(
    ": 1789207634:0;sudo mv pkg /opt/pkg && \\\\\nchmod +x /opt/pkg && \\\\\nls\n: 1789207700:0;echo done\n",
    SRC,
    FALLBACK
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.command).toBe(
    "sudo mv pkg /opt/pkg && \\\nchmod +x /opt/pkg && \\\nls"
  );
  expect(rows[0]?.timestamp).toBe(1789207634);
  expect(rows[0]?.timestampApproximate).toBe(false);
});

test("zsh single-backslash embedded newline decodes without backslash", () => {
  const rows = parseZshHistory(
    ": 100:0;echo foo\\\nbar\n: 101:0;next\n",
    SRC,
    FALLBACK
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.command).toBe("echo foo\nbar");
});

test("zsh trailing backslash before a header stays literal, entries split", () => {
  const rows = parseZshHistory(
    ": 100:0;echo foo\\\\\n: 101:0;ls\n",
    SRC,
    FALLBACK
  );
  expect(rows).toHaveLength(2);
  expect(rows[0]?.command).toBe("echo foo\\\\");
  expect(rows[1]?.command).toBe("ls");
});

test("zsh plain lines (EXTENDED_HISTORY off) fall back to approximate time", () => {
  const rows = parseZshHistory("git status\n\n", SRC, FALLBACK);
  expect(rows).toHaveLength(1);
  expect(rows[0]?.command).toBe("git status");
  expect(rows[0]?.timestamp).toBe(FALLBACK);
  expect(rows[0]?.timestampApproximate).toBe(true);
});

test("plain history: one per line, mtime fallback, blanks skipped", () => {
  const rows = parsePlainHistory(
    "clear\n\n  git status  \n",
    "/home/test/.bash_history",
    "bash",
    FALLBACK
  );
  expect(rows.map((r) => r.command)).toEqual(["clear", "git status"]);
  expect(rows.every((r) => r.timestampApproximate)).toBe(true);
  expect(rows[0]?.shell).toBe("bash");
});

test("dedupeConsecutive collapses runs, keeps near-misses and repeats", () => {
  const rows = dedupeConsecutive([
    mk("ls"),
    mk("ls"),
    mk("ls -la"),
    mk("ls -la"),
    mk("ls"),
  ]);
  expect(rows.map((r) => r.command)).toEqual(["ls", "ls -la", "ls"]);
  expect(dedupeConsecutive([])).toEqual([]);
});

test("commands normalize NFD input to NFC at parse time", () => {
  const nfd = "café".normalize("NFD");
  const zsh = parseZshHistory(`: 100:0;open ${nfd}\n`, SRC, FALLBACK);
  expect(zsh[0]?.command).toBe("open café");
  const plain = parsePlainHistory(`open ${nfd}\n`, SRC, "bash", FALLBACK);
  expect(plain[0]?.command).toBe("open café");
});

test("history sources are zsh + bash only (scope lock, no fish/powershell)", () => {  const sources = getHistoryFilePaths();
  const shells = new Set(sources.map((s) => s.shell));
  expect(shells.has("zsh")).toBe(true);
  expect(shells.has("bash")).toBe(true);
  expect(shells.has("fish" as never)).toBe(false);
  expect(shells.has("powershell" as never)).toBe(false);
  expect(sources.some((s) => s.path.includes(".zsh_history"))).toBe(true);
  expect(sources.some((s) => s.path.includes(".bash_history"))).toBe(true);
});
