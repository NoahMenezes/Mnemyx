import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initDb,
  closeDb,
  bulkInsert,
  searchCommands,
  type HistoryEntry,
} from "./db.ts";

// ---------------------------------------------------------------------------
// `mnemyx bench`: synthetic performance baseline on a throwaway DB.
// Deterministic (seeded PRNG) so runs are comparable across changes.
// Measures what users feel: import throughput, query latency, memory.
// ---------------------------------------------------------------------------

export interface BenchOptions {
  rows?: number;
  queries?: number;
  skipSemantic?: boolean;
}

export interface BenchResult {
  rows: number;
  importMs: number;
  ftsP50: number;
  ftsP95: number;
  semanticP50: number | null;
  semanticP95: number | null;
  semanticNote: string;
  rssMB: number;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VERBS = [
  "git commit -m",
  "git push",
  "docker run",
  "docker ps",
  "kubectl apply -f",
  "curl -fsSL",
  "bun install",
  "cargo build",
  "systemctl restart",
  "ssh deploy@prod",
];
const NOUNS = [
  "fix-auth",
  "payment-api",
  "nginx.conf",
  "release-v2",
  "worker-3",
  "canary",
  "hotfix",
  "migrations",
];

function syntheticHistory(n: number): HistoryEntry[] {
  const rand = mulberry32(42);
  const out: HistoryEntry[] = [];
  for (let i = 0; i < n; i++) {
    const v = VERBS[Math.floor(rand() * VERBS.length)] as string;
    const w = NOUNS[Math.floor(rand() * NOUNS.length)] as string;
    out.push({
      command: `${v} ${w}-${Math.floor(rand() * 500)}`,
      timestamp: 1_700_000_000 + i,
      sourceFile: "/tmp/bench/.zsh_history",
      shell: "zsh",
      timestampApproximate: false,
    });
  }
  return out;
}

const SAMPLE_QUERIES = [
  "git commit",
  "docker",
  "commi",
  "kubectl apply",
  "restart worker",
  "payment api hotfix",
  "ssh deploy",
  "bun install",
  "systemctl",
  "release canary",
];

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] as number;
}

export async function runBench(opts: BenchOptions = {}): Promise<BenchResult> {
  const rows = opts.rows ?? 10_000;
  const queryCount = opts.queries ?? 20;
  const dir = mkdtempSync(join(tmpdir(), "mnemyx-bench-"));
  try {
    initDb(join(dir, "bench.db"));
    const t0 = Date.now();
    bulkInsert(syntheticHistory(rows));
    const importMs = Date.now() - t0;

    const ftsTimes: number[] = [];
    for (let i = 0; i < queryCount; i++) {
      const q = SAMPLE_QUERIES[i % SAMPLE_QUERIES.length] as string;
      const s = Date.now();
      searchCommands(q, 10);
      ftsTimes.push(Date.now() - s);
    }
    ftsTimes.sort((a, b) => a - b);

    let semanticP50: number | null = null;
    let semanticP95: number | null = null;
    let semanticNote = "--skip-semantic flag";
    if (!opts.skipSemantic) {
      try {
        const { backfillMissingEmbeddings, semanticSearch } = await import(
          "./embeddings.ts"
        );
        await backfillMissingEmbeddings(128);
        const semTimes: number[] = [];
        for (let i = 0; i < Math.min(queryCount, 10); i++) {
          const q = SAMPLE_QUERIES[i % SAMPLE_QUERIES.length] as string;
          const s = Date.now();
          await semanticSearch(q, { limit: 10 });
          semTimes.push(Date.now() - s);
        }
        semTimes.sort((a, b) => a - b);
        semanticP50 = percentile(semTimes, 50);
        semanticP95 = percentile(semTimes, 95);
        semanticNote = "ok";
      } catch (err) {
        semanticNote = `unavailable: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      rows,
      importMs,
      ftsP50: percentile(ftsTimes, 50),
      ftsP95: percentile(ftsTimes, 95),
      semanticP50,
      semanticP95,
      semanticNote,
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
    };
  } finally {
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

export function formatBench(r: BenchResult): string {
  const sem =
    r.semanticP50 === null || r.semanticP95 === null
      ? `skipped (${r.semanticNote})`
      : `p50=${r.semanticP50}ms p95=${r.semanticP95}ms`;
  return [
    `mnemyx bench — ${r.rows} synthetic rows`,
    `  import (bulk + FTS index): ${r.importMs}ms (${Math.round(r.rows / (r.importMs / 1000))} rows/s)`,
    `  FTS search:                p50=${r.ftsP50}ms p95=${r.ftsP95}ms`,
    `  semantic search:           ${sem}`,
    `  peak RSS:                  ${r.rssMB}MB`,
  ].join("\n");
}
