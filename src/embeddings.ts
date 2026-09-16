import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getCommandsMissingEmbeddings,
  storeEmbeddings,
  pruneStaleEmbeddings,
  countEmbeddings,
  getEmbeddingCandidates,
  getCommandsByIds,
  sortByOutcomeTier,
  applyDenylist,
  type CommandRow,
} from "./db.ts";
import { loadConfig, firstToken } from "./config.ts";

// ---------------------------------------------------------------------------
// Phase 4: local semantic search. all-MiniLM-L6-v2 (int8 quantized, 384
// dims) runs fully on-device via ONNX — no cloud, no API keys, no daemon.
//
// Cost (one-time): ~23MB model download to ~/.cache/huggingface on first
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
export function getModelCacheDir(): string {
  if (process.env.HF_HOME) return process.env.HF_HOME;
  const home = process.env.HOME || homedir();
  return join(home, ".cache", "mnemyx", "models");
}
env.cacheDir = getModelCacheDir();

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
  const out = await ext(texts, { pooling: "mean", normalize: true });
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
export async function backfillMissingEmbeddings(
  batchSize = 64
): Promise<{ embedded: number }> {
  pruneStaleEmbeddings(EMBEDDING_MODEL_ID);
  const denied = new Set(loadConfig().denylist);
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
    const vectors = await embedTexts(batch.map((m) => m.command));
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
// apart from how relevance itself is scored.
export async function semanticSearch(
  query: string,
  opts: SemanticOptions = {}
): Promise<CommandRow[]> {
  const stored = countEmbeddings(EMBEDDING_MODEL_ID);
  if (stored === 0) {
    throw new Error("no embeddings stored yet (backfill pending)");
  }
  const [queryVec] = await embedTexts([query]);
  if (!queryVec) throw new Error("failed to embed query");
  const candidates = getEmbeddingCandidates(
    EMBEDDING_MODEL_ID,
    opts.onlySuccessful === true
  );
  const scored = candidates.map((c) => ({
    id: c.id,
    score: dot(queryVec, c.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  const wanted = opts.limit ?? 20;
  const topIds = scored.slice(0, Math.min(wanted * 3 + 10, 500)).map((s) => s.id);
  const byId = new Map(getCommandsByIds(topIds).map((r) => [r.id, r]));
  // Preserve score order (byId lookup loses it), drop any missing rows.
  const ordered: CommandRow[] = [];
  for (const s of scored) {
    if (ordered.length >= topIds.length) break;
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
