// ---------------------------------------------------------------------------
// Phase 4: vector storage. Float32 little-endian BLOBs; unit-length vectors
// (cosine similarity = dot product). All helpers take the model tag so a
// future model/dtype swap is just "new tag -> old rows look missing".
// ---------------------------------------------------------------------------

import { getDb, withBusyRetry } from "./connection.ts";
import { normalizeScopeRepo } from "./scope.ts";

function encodeVector(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

function decodeVector(blob: Buffer, dims: number): Float32Array {
  return Float32Array.from(
    new Float32Array(
      blob.buffer,
      blob.byteOffset,
      Math.floor(blob.byteLength / 4)
    ).subarray(0, dims)
  );
}

// Drop vectors from any other model tag (upgrade path: re-embed follows).
export function pruneStaleEmbeddings(model: string): number {
  const res = getDb()
    .query(`DELETE FROM command_embeddings WHERE model != ?`)
    .run(model);
  return Number(res.changes);
}

export function countEmbeddings(model: string): number {
  return (
    getDb()
      .query(`SELECT COUNT(*) AS n FROM command_embeddings WHERE model = ?`)
      .get(model) as { n: number }
  ).n;
}

// History rows with no current-model vector yet (backfill source).
// Keyset-paginated by id: pass back the max id seen to advance. (LIMIT
// alone can't skip rows — e.g. denylisted noise the caller declines to
// store would pin the cursor forever.)
export function getCommandsMissingEmbeddings(
  model: string,
  limit: number,
  afterId = 0
): { id: number; command: string }[] {
  return getDb()
    .query(
      `SELECT c.id, c.command FROM commands c
       WHERE c.id > ? AND NOT EXISTS (
         SELECT 1 FROM command_embeddings e
         WHERE e.command_id = c.id AND e.model = ?
       )
       ORDER BY c.id
       LIMIT ?`
    )
    .all(afterId, model, Math.max(Math.floor(limit), 1)) as {
    id: number;
    command: string;
  }[];
}

export function storeEmbeddings(
  ids: number[],
  vectors: Float32Array[],
  model: string,
  dims: number
): void {
  if (ids.length === 0) return;
  if (ids.length !== vectors.length) {
    throw new Error(
      `storeEmbeddings: ${ids.length} ids vs ${vectors.length} vectors`
    );
  }
  const database = getDb();
  const stmt = database.query(
    `INSERT OR REPLACE INTO command_embeddings (command_id, embedding, model, dims)
     VALUES (?, ?, ?, ?)`
  );
  const storeMany = database.transaction(() => {
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const vec = vectors[i];
      if (id === undefined || !vec || vec.length !== dims) {
        throw new Error(
          `storeEmbeddings: bad entry at index ${i} (want id + ${dims} dims)`
        );
      }
      stmt.run(id, encodeVector(vec), model, dims);
    }
  });
  withBusyRetry(() => storeMany());
}

// All stored vectors (+ optional proven-success pre-filter so top-k isn't
// wasted on rows an onlySuccessful query would discard anyway).
// Phase 7: optional strict repo pre-filter (onlyRepo). Boost-only scoping
// stays JS-side in the caller (partitionRepoFirst) so relevance order is
// preserved; strict filtering happens here so top-K isn't wasted.
export function getEmbeddingCandidates(
  model: string,
  onlySuccessful: boolean,
  strictRepo: string | null = null
): { id: number; embedding: Float32Array }[] {
  const normalized = normalizeScopeRepo(strictRepo);
  const needJoin = onlySuccessful || normalized !== null;
  const base = needJoin
    ? `SELECT e.command_id AS id, e.embedding, e.dims FROM command_embeddings e
       JOIN commands c ON c.id = e.command_id
       WHERE e.model = ?${onlySuccessful ? " AND c.exit_code = 0" : ""}${normalized !== null ? " AND c.repo = ?" : ""}`
    : `SELECT e.command_id AS id, e.embedding, e.dims FROM command_embeddings e
       WHERE e.model = ?`;
  const rows = getDb().query(base).all(
    ...(normalized !== null ? [model, normalized] : [model])
  ) as { id: number; embedding: Buffer; dims: number }[];
  return rows.map((r) => ({
    id: r.id,
    embedding: decodeVector(r.embedding, r.dims),
  }));
}

// Keyset-paginated twin of getEmbeddingCandidates: same rows in command_id
// order, so callers can score streaming with bounded memory (a full load is
// ~1.5KB/row — fine at 2k rows, 1.5GB at a million).
export function getEmbeddingBatch(
  model: string,
  onlySuccessful: boolean,
  afterId: number,
  limit: number,
  strictRepo: string | null = null
): { id: number; embedding: Float32Array }[] {
  const normalized = normalizeScopeRepo(strictRepo);
  const needJoin = onlySuccessful || normalized !== null;
  const base = needJoin
    ? `SELECT e.command_id AS id, e.embedding, e.dims FROM command_embeddings e
       JOIN commands c ON c.id = e.command_id
       WHERE e.model = ?${onlySuccessful ? " AND c.exit_code = 0" : ""}${normalized !== null ? " AND c.repo = ?" : ""} AND e.command_id > ?
       ORDER BY e.command_id LIMIT ?`
    : `SELECT e.command_id AS id, e.embedding, e.dims FROM command_embeddings e
       WHERE e.model = ? AND e.command_id > ?
       ORDER BY e.command_id LIMIT ?`;
  const rows = getDb().query(base).all(
    ...(normalized !== null
      ? [model, normalized, afterId, Math.max(Math.floor(limit), 1)]
      : [model, afterId, Math.max(Math.floor(limit), 1)])
  ) as {
    id: number;
    embedding: Buffer;
    dims: number;
  }[];
  return rows.map((r) => ({
    id: r.id,
    embedding: decodeVector(r.embedding, r.dims),
  }));
}
