import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDb, closeDb, bulkInsert, countEmbeddings } from "./db.ts";
import {
  backfillMissingEmbeddings,
  EMBEDDING_MODEL,
  EMBEDDING_MODEL_ID,
  EMBEDDING_DIMS,
  getModelCacheDir,
} from "./embeddings.ts";
import type { HistoryEntry } from "./db.ts";

const dir = mkdtempSync(join(tmpdir(), "mnemyx-emb-test-"));
let n = 0;
const dbPath = (): string => join(dir, `t${n++}.db`);

beforeEach(() => closeDb());
afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function entry(command: string, timestamp = 1): HistoryEntry {
  return {
    command,
    timestamp,
    sourceFile: "/tmp/fake/.zsh_history",
    shell: "zsh",
    timestampApproximate: false,
  };
}

// Deterministic stand-in for the ONNX model: distinct unit-ish vectors,
// no download, no native code. Tests the cursor/storage logic, not ML.
async function stubEmbed(texts: string[]): Promise<Float32Array[]> {
  return texts.map((t) => {
    let h = 0;
    for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const v = new Float32Array(EMBEDDING_DIMS).fill(0.001);
    v[Math.abs(h) % EMBEDDING_DIMS] = 1;
    return v;
  });
}
// Built-in noise tokens only (user config can only ever ADD denials,
// so these stay denied under any ambient config).
const NOISE = ["ls", "cd", "clear", "exit"];

test("model id contract: MiniLM family, 384 dims, q8 tag", () => {
  expect(EMBEDDING_MODEL).toBe("Xenova/all-MiniLM-L6-v2");
  expect(EMBEDDING_DIMS).toBe(384);
  expect(EMBEDDING_MODEL_ID).toContain(":q8");
  expect(getModelCacheDir().length).toBeGreaterThan(0);
});

test("no static value-import of transformers (Intel-Mac crash guard)", async () => {
  // Platforms without an onnxruntime native binary (Intel Macs: no
  // darwin/x64 build) throw when the transformers bundle LOADS, because it
  // requires the .node binding at top level. embeddings.ts must therefore
  // only ever import it lazily (dynamic import inside try/catch) so those
  // platforms degrade to keyword search instead of crashing at startup.
  // This test pins that property structurally.
  const src = await Bun.file(
    new URL("./embeddings.ts", import.meta.url)
  ).text();
  const lines = src.split("\n");
  const staticImports = lines.filter(
    (l) =>
      /^\s*import\s/.test(l) &&
      l.includes("@huggingface/transformers") &&
      !l.includes("import type")
  );
  expect(staticImports).toEqual([]);
});

test("backfill covers everything past noise heads and sparse ids", async () => {
  initDb(dbPath());
  // Adversarial layout: 200-row noise head (pins naive LIMIT cursors),
  // sparse storable rows throughout, noise tail. Regression test for the
  // Phase 4 cursor bugs (pin on noise, skip-forward data loss).
  const rows: HistoryEntry[] = [];
  for (let i = 0; i < 200; i++) {
    rows.push(entry(NOISE[i % NOISE.length]!, 1000 + i));
  }
  const storable: string[] = [];
  for (let i = 0; i < 40; i++) {
    const cmd = `deploy-service-${i} --env prod`;
    storable.push(cmd);
    rows.push(entry(cmd, 2000 + i));
    rows.push(entry(NOISE[(i + 1) % NOISE.length]!, 3000 + i));
  }
  for (let i = 0; i < 50; i++) {
    rows.push(entry(NOISE[i % NOISE.length]!, 4000 + i));
  }
  bulkInsert(rows);
  const denied = new Set(NOISE);
  const r1 = await backfillMissingEmbeddings(16, {
    embedFn: stubEmbed,
    denied,
  });
  expect(r1.embedded).toBe(storable.length);
  expect(countEmbeddings(EMBEDDING_MODEL_ID)).toBe(storable.length);
  // Rerun terminates immediately with zero work (idempotent).
  const r2 = await backfillMissingEmbeddings(16, {
    embedFn: stubEmbed,
    denied,
  });
  expect(r2.embedded).toBe(0);
});

test("backfill on an empty DB is an instant no-op", async () => {
  initDb(dbPath());
  let calls = 0;
  const counting = async (t: string[]): Promise<Float32Array[]> => {
    calls++;
    return stubEmbed(t);
  };
  const r = await backfillMissingEmbeddings(16, {
    embedFn: counting,
    denied: new Set(NOISE),
  });
  expect(r.embedded).toBe(0);
  expect(calls).toBe(0);
});

test("overlong semantic queries throw before touching the model", async () => {
  initDb(dbPath());
  const { semanticSearch } = await import("./embeddings.ts");
  const long = "a".repeat(501);
  let err: unknown = null;
  try {
    await semanticSearch(long, { limit: 5 });
  } catch (e) {
    err = e;
  }
  expect(String((err as Error)?.message ?? err)).toMatch(/too long/);
});
