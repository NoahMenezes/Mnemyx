import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getCommandsMissingEmbeddings,
  storeEmbeddings,
  pruneStaleEmbeddings,
  countEmbeddings,
  getEmbeddingBatch,
  getCommandsByIds,
  sortByOutcomeTier,
  applyDenylist,
  clampLimit,
  MAX_QUERY_LENGTH,
  type CommandRow,
} from "./db.ts";
import { loadConfig, firstToken } from "./config.ts";

// ---------------------------------------------------------------------------
// Phase 4: local semantic search. all-MiniLM-L6-v2 (int8 quantized, 384
// dims) runs fully on-device via ONNX — no cloud, no API keys, no daemon.
//
// Cost (one-time): ~23MB model download to ~/.cache/mnemyx/models on first
// use (offline after that), ~350MB of npm packages (mostly the ONNX
// runtime's multi-platform binaries), ~3MB of vectors for ~2000 commands,
// ~100-200MB RAM while embedding.
//
// SCALE-UP PATH: change EMBEDDING_DTYPE to "fp32" (or EMBEDDING_MODEL to
// all-MiniLM-L12-v2). The model id is stored with every vector, so old
// vectors are pruned and re-embedded automatically — no migration.
// ---------------------------------------------------------------------------

export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
// One-line scale-up: "fp32" (~87MB download, slightly better vectors).
// ("q8" selects the int8-quantized ~23MB weights: onnx/model_quantized.onnx.)
export const EMBEDDING_DTYPE = "q8";
export const EMBEDDING_DIMS = 384;
// DB tag — any change here invalidates stored vectors (safe upgrade path).
export const EMBEDDING_MODEL_ID = `${EMBEDDING_MODEL}:${EMBEDDING_DTYPE}`;

// Model weights live OUTSIDE node_modules on purpose: the library default
// is <package>/.cache (wiped on clean reinstall -> surprise re-download).
// Ours survives reinstalls; HF_HOME overrides (standard convention).
// Resolved lazily (see getExtractor) so exotic environments fail at first
// USE, inside try/catch, never at module import.
export function getModelCacheDir(): string {
  if (process.env.HF_HOME) return process.env.HF_HOME;
  const home = process.env.HOME || homedir();
  return join(home, ".cache", "mnemyx", "models");
}

// Lazy singleton: model loads on first semantic use or background backfill,
// NEVER on server startup (an MCP spawn must stay fast). First call also
// performs the one-time ~23MB download; failures are sticky for the process
// and always degrade to the FTS5 keyword path, never a crash.
let extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
let loadFailed = false;
let loadFailureReason = "unknown";

async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (loadFailed) {
    throw new Error(`embedding model unavailable: ${loadFailureReason}`);
  }
  if (!extractorPromise) {
    extractorPromise = (async () => {
      try {
        // Dynamic import ON PURPOSE: the transformers bundle requires the
        // platform's onnxruntime native binding at load time, and platforms
        // without one (Intel Macs: no darwin/x64 binary) would otherwise
        // crash the whole server at module import — before any fallback can
        // run. Importing lazily here turns that into a catchable error, so
        // affected platforms degrade to keyword search and keep serving.
        const { env, pipeline } = await import(
          "@huggingface/transformers"
        );
        env.cacheDir = getModelCacheDir();
        console.error(
          `[mnemyx] loading embedding model ${EMBEDDING_MODEL_ID} (first run downloads ~23MB to ${getModelCacheDir()}, then works offline)`
        );
        const ext = (await pipeline("feature-extraction", EMBEDDING_MODEL, {
          dtype: EMBEDDING_DTYPE,
        })) as FeatureExtractionPipeline;
        console.error(`[mnemyx] embedding model ready`);
        return ext;
      } catch (err) {
        loadFailed = true;
        loadFailureReason = err instanceof Error ? err.message : String(err);
        extractorPromise = null;
        throw new Error(`embedding model unavailable: ${loadFailureReason}`);
      }
    })();
  }
  return extractorPromise;
}

// Embed a batch of texts -> unit-length vectors (cosine = dot product).
// Throws if the model can't load (caller falls back to keyword search).
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const ext = await getExtractor();
  // NFC-normalized like everything stored, so query and index live in the
  // same space regardless of input normalization form.
  const out = await ext(
    texts.map((t) => t.normalize("NFC")),
    { pooling: "mean", normalize: true }
  );
  const flat = out.data as Float32Array;
  const dims = flat.length / texts.length;
  if (!Number.isInteger(dims) || dims !== EMBEDDING_DIMS) {
    throw new Error(
      `unexpected embedding dims: got ${dims}, want ${EMBEDDING_DIMS}`
    );
  }
  return texts.map((_, i) =>
    Float32Array.from(flat.subarray(i * dims, (i + 1) * dims))
  );
}

// Embed every history row that lacks a current-model vector, in batches.
// Noise-denylisted commands are skipped (no budget spent on `ls`).
// Safe to run on every startup: already-embedded rows are untouched.
// `overrides` exists for tests (stub embedder + fixed denylist = no model,
// no ambient config); production callers omit it.
export async function backfillMissingEmbeddings(
  batchSize = 64,
  overrides: {
    embedFn?: (texts: string[]) => Promise<Float32Array[]>;
    denied?: Set<string>;
  } = {}
): Promise<{ embedded: number }> {
  const embedFn = overrides.embedFn ?? embedTexts;
  pruneStaleEmbeddings(EMBEDDING_MODEL_ID);
  const denied = overrides.denied ?? new Set(loadConfig().denylist);
  const PAGE = batchSize * 3;
  let embedded = 0;
  // Keyset cursor over missing rows. The cursor may only advance past rows
  // that are resolved (stored now, or noise skipped forever) — advancing
  // past an unprocessed row would lose it, and not advancing past skipped
  // noise would pin the cursor. So we walk each page in id order and stop
  // at the first row beyond a full batch; everything before it is resolved.
  let afterId = 0;
  for (;;) {
    const page = getCommandsMissingEmbeddings(
      EMBEDDING_MODEL_ID,
      PAGE,
      afterId
    );
    if (page.length === 0) break; // every row visited
    const batch: { id: number; command: string }[] = [];
    let cursor = afterId;
    for (const row of page) {
      if (denied.has(firstToken(row.command))) {
        cursor = row.id; // noise: resolved by skipping
        continue;
      }
      if (batch.length >= batchSize) break; // rest stays unvisited
      batch.push(row);
      cursor = row.id;
    }
    afterId = cursor;
    if (batch.length === 0) {
      if (page.length < PAGE) break; // tail page, all noise
      continue; // full page of noise, cursor advanced past it
    }
    const vectors = await embedFn(batch.map((m) => m.command));
    storeEmbeddings(
      batch.map((m) => m.id),
      vectors,
      EMBEDDING_MODEL_ID,
      EMBEDDING_DIMS
    );
    embedded += batch.length;
    console.error(`[mnemyx] embedded ${embedded} commands…`);
  }
  return { embedded };
}

export interface SemanticOptions {
  limit?: number;
  onlySuccessful?: boolean;
}

// Semantic search over stored vectors. Throws when unusable (model won't
// load, or zero vectors stored yet) so the caller can fall back to FTS5.
// Ranking: cosine similarity, then the same proven-success boost tiers as
// keyword search, then the denylist — both modes behave identically
// apart from how relevance itself is scored. Memory stays flat: scores
// stream in pages, only the running top-K is kept.
export async function semanticSearch(
  query: string,
  opts: SemanticOptions = {}
): Promise<CommandRow[]> {
  const trimmed = query.trim();
  if (trimmed.length > MAX_QUERY_LENGTH) {
    throw new Error(
      `query too long (${trimmed.length} chars, max ${MAX_QUERY_LENGTH})`
    );
  }
  const stored = countEmbeddings(EMBEDDING_MODEL_ID);
  if (stored === 0) {
    throw new Error("no embeddings stored yet (backfill pending)");
  }
  const [queryVec] = await embedTexts([trimmed]);
  if (!queryVec) throw new Error("failed to embed query");
  const wanted = clampLimit(opts.limit, 20);
  // Bounded-memory top-K: candidates stream in keyset pages while only the
  // running best are kept (a full vector load is ~1.5KB/row — fine at 2k
  // rows, gigabytes at a million). Identical results to scoring everything.
  const keep = Math.min(wanted * 3 + 10, 500);
  const onlySuccessful = opts.onlySuccessful === true;
  const top: { id: number; score: number }[] = [];
  const consider = (id: number, score: number): void => {
    if (top.length < keep) {
      top.push({ id, score });
      if (top.length === keep) top.sort((a, b) => b.score - a.score);
      return;
    }
    const worst = top[top.length - 1];
    if (worst !== undefined && score > worst.score) {
      worst.id = id;
      worst.score = score;
      top.sort((a, b) => b.score - a.score);
    }
  };
  let afterId = 0;
  for (;;) {
    const batch = getEmbeddingBatch(
      EMBEDDING_MODEL_ID,
      onlySuccessful,
      afterId,
      2000
    );
    if (batch.length === 0) break;
    afterId = batch[batch.length - 1]?.id ?? afterId;
    for (const c of batch) consider(c.id, dot(queryVec, c.embedding));
  }
  top.sort((a, b) => b.score - a.score);
  const byId = new Map(
    getCommandsByIds(top.map((s) => s.id)).map((r) => [r.id, r])
  );
  // Preserve score order (byId lookup loses it), drop any missing rows.
  const ordered: CommandRow[] = [];
  for (const s of top) {
    const row = byId.get(s.id);
    if (row) ordered.push(row);
  }
  return applyDenylist(sortByOutcomeTier(ordered), wanted);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
