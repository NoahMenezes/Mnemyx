// ---------------------------------------------------------------------------
// Public API barrel for the SQLite layer. The implementation lives in
// src/db/ (one concern per file); this module only re-exports, so every
// existing `from "./db.ts"` import keeps working unchanged.
//
//   db/types.ts      shared row interfaces + SELECT column lists
//   db/connection.ts handle lifecycle (init/close), busy-retry, limits
//   db/paths.ts      per-user DB path resolution
//   db/schema.ts     tables, migrations, FTS5 index, vector/commit stores
//   db/scope.ts      query-shaping primitives (LIKE/FTS/rank/repo scope)
//   db/commands.ts   history writes, keyword search, recents, exit stamping
//   db/vectors.ts    Phase 4 embedding BLOB store
//   db/commits.ts    Phase 6 commit store + queries
//   db/errors.ts     Phase 8 error-fingerprint search + rendering
//   db/profile.ts    Phase 7 per-project usage profile
//   db/format.ts     LLM-facing text rendering (redact + sanitize)
// ---------------------------------------------------------------------------

export * from "./db/types.ts";
export * from "./db/connection.ts";
export * from "./db/paths.ts";
export * from "./db/scope.ts";
export * from "./db/commands.ts";
export * from "./db/vectors.ts";
export * from "./db/commits.ts";
export * from "./db/errors.ts";
export * from "./db/profile.ts";
export * from "./db/format.ts";
