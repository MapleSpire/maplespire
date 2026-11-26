// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 Olivier Albertini
//
// This file is part of MapleSpire.
// MapleSpire is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// MapleSpire is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.

/**
 * The durable-heads memo (G4-16f): the heads of a STRICT decode of one
 * document's content rows, keyed by the table those rows were read from and
 * the exact row versions decoded.
 *
 * Why: the cold build's durable proof (`prepareDocumentWatermarkProofs`)
 * re-read and re-decoded, in full, the bytes the extraction had just loaded
 * through `StorageSubsystem.loadDoc` — ~108 s of a 249 s cold attach on the
 * aged high corpus at 3 years (426 sealed fold products), 5.6 s of 15.9 s on
 * mid at 6 months (`read_model.cold_build_phases` afterShardsMs, measured
 * 2026-11-07 on the build that added that phase).
 *
 * A row version is (storage key, arrival_seq, octet length). Soundness:
 *  - every content write mints a fresh `arrival_seq`: a plain INSERT takes the
 *    column DEFAULT `nextval`, an upsert's `ON CONFLICT DO UPDATE` sets
 *    `arrival_seq = nextval(...)` (`PostgresStorageAdapter.save`), and a
 *    sequence never hands out a value twice. So a row whose (key, seq) is
 *    unchanged holds the bytes that were decoded; a concurrent writer, a
 *    foreign insert or a compaction changes the SET and the lookup misses;
 *  - a hit requires the CURRENT set to EQUAL the remembered one exactly — a
 *    subset would certify heads that omit a row now durable;
 *  - a NULL `arrival_seq` (rows older than the clock) is never remembered;
 *  - only a decode that passed `Automerge.load` (no `loadIncremental`
 *    fallback) with `getMissingDeps(doc, [])` empty may populate it — the
 *    same predicate the durable heads worker enforces;
 *  - the watermark claim itself is unchanged: the proof still compares these
 *    heads with the sampled and the current runtime heads.
 *
 * THE SCOPE. "A sequence never hands out a value twice" holds for ONE
 * sequence. Every isolated test schema has its own `automerge_arrival_seq`
 * starting at 1 (`ensureReadModelSchema` per schema,
 * `testing/isolatedSchema.ts`), and so does every database, so two tables can
 * hold the same document id under the same (key, seq, length) with different
 * bytes. Keyed by document id alone, the memo certified the second table's
 * proof with the first table's heads (`durableHeadsMemo.integration.test.ts`,
 * "two tables, same document id, same row versions, different bytes": RED
 * before the scope, GREEN with it). So every row version carries a `scope`:
 * `<database oid>:<tableoid>` of the `automerge_storage` row it came from,
 * selected IN THE SAME STATEMENT as the row (`durableHeadsScopeSql`), and an
 * entry only answers a lookup whose rows carry the same scope. Consequences:
 *  - a scope cannot be forgotten or mis-wired: no call site states which
 *    database it reads, the row says it; a row without a valid scope is never
 *    remembered and never hits (`scopeOf`);
 *  - two Pool objects on the same table SHARE entries — which production
 *    needs: the sync Repo's adapter reads on `pool` and the projector's proof
 *    on `readModelPool` (`index.ts`, `ProjectorFleet` `db: readModelPool`),
 *    two pools on the same database (`readModelDatabasePoolConfig` only
 *    changes `max`). A scope per Pool object would have lost every
 *    extraction-load hit there (integration test "a cold build on a SECOND
 *    pool of the same schema still certifies through the adapter's hits");
 *  - NOT the database name: the isolated schemas share one database, and a
 *    dropped and recreated table or database gets a new oid, so its restarted
 *    sequence cannot meet entries remembered against the old one.
 * What the scope does NOT cover: two CLUSTERS reached by one process whose
 * database oid and storage table oid coincide (identically migrated fresh
 * clusters can). `system_identifier` would separate them, but it comes from
 * `pg_control_system()`, which this statement would then run on EVERY
 * `loadRange` — available to a non-superuser on postgres:16 (measured
 * 2026-11-07), NOT verified on Aurora PostgreSQL; a failure there would fail every
 * document load. No production path runs the adapter or the proof against a
 * second database today (every `new PostgresStorageAdapter` outside tests
 * reads `db.ts`'s `pool`). Nor does it cover a sequence rewound UNDER a
 * running process (a restore into the live table); restores go through a
 * fresh database and a restart. In both cases automerge-repo's keys are
 * content-addressed (an incremental key hashes its bytes, a snapshot key
 * hashes its heads — StorageSubsystem `keyHash` / `headsHash`), so a
 * colliding triple could only lie for a hand-written key.
 *
 * WHAT IS PERSISTED IS NOT SCOPED. The memo lives in memory and every entry
 * carries its scope; the sealed-product cache's `rows_digest`
 * (`sealedProductCache.ts`, WHAT A HIT TRUSTS) is a PERSISTED digest of the
 * same triples with no scope at all, so an `automerge_storage` recreated
 * with a restarted sequence while the cache tables survive is covered there
 * by the content-addressed keys above and by nothing else. And an entry
 * remembered from a cache HIT (`projectorService.ts`, `readCachedShard`,
 * `durableHeadsMemo.remember(hit.documentId, hit.rows, hit.heads)`) holds
 * the heads the cache HEADER states, trusted as written by its one writer
 * from a strict decode in the same transaction as the entities — not heads
 * this process decoded. Its rows are the ones the hit's statement read,
 * scope included, so it hits only on that table.
 *
 * Bounds: one entry per (scope, document) (a new decode replaces it, a
 * mismatch deletes it), least-recently-used eviction past `maxDocuments`
 * entries or `maxRowVersions` remembered row versions in total, across ALL
 * scopes — so the process-wide total is bounded whatever the number of pools,
 * schemas or databases; an entry of a table no longer read stays only until
 * it is evicted. Sizing, NOT measured as heap: an entry is about 130 bytes of
 * JSON per row version, so the cap is roughly 26 MB of strings at worst. The
 * aged high corpus at 3 years (G4-16f: 455 listed shards, 1 190 product
 * chunks, measured) needs under 2 000 row versions per
 * workspace, so the caps leave room for about a hundred such workspaces
 * before live traffic can evict a cold build's entries between its extraction
 * and its proof; an eviction only costs speed (`proofMemoMisses` in
 * `read_model.cold_build_phases`).
 */

export interface DurableRowVersion {
  key: string
  /** BIGINT as text; never coerced to Number. */
  arrivalSeq: string | null
  octets: number
}

/** A row version as ONE statement read it, with the scope of the table it was
 * read from (`durableHeadsScopeSql`). Null: no scope (never remembered). */
export interface ScopedRowVersion extends DurableRowVersion {
  scope: string | null
}

/**
 * The SQL expression of a row's scope: `<database oid>:<tableoid>`, for an
 * `automerge_storage` row referenced as `relation` in the same statement. A
 * NULL row (an outer join's missing side) gives NULL. Both parts are core
 * catalog facts (a system column and `pg_database`), not a function that can
 * be revoked or absent. Cost, since every `loadRange` carries it: 20 000
 * evaluations of the `pg_database` lookup in a PL/pgSQL loop took 16.7 ms
 * against 6.0 ms for `SELECT 1` (about 0.5 µs each; postgres:16-alpine,
 * measured 2026-11-07, not committed).
 */
export function durableHeadsScopeSql(relation: string): string {
  return `((SELECT oid FROM pg_database WHERE datname = current_database())::text || ':' || ${relation}.tableoid::text)`
}

const SCOPE_SHAPE = /^\d+:\d+$/

/** The one valid scope every row shares; null when any row has none, an
 * invalid one, or a different one. */
export function scopeOf(rows: readonly ScopedRowVersion[]): string | null {
  let scope: string | null = null
  for (const row of rows) {
    if (typeof row.scope !== 'string' || !SCOPE_SHAPE.test(row.scope)) return null
    if (scope === null) scope = row.scope
    else if (scope !== row.scope) return null
  }
  return scope
}

interface Entry {
  documentId: string
  versions: readonly string[]
  heads: readonly string[]
}

/** Canonical, sorted encoding of a row-version set; null when any row has no
 * arrival sequence (such a set can never be remembered or hit). The scope is
 * NOT part of it: `sealedProductCache.ts` persists its digest in the same
 * table's database. */
export function rowVersionSet(rows: readonly DurableRowVersion[]): string[] | null {
  const versions: string[] = []
  for (const row of rows) {
    if (row.arrivalSeq === null || row.arrivalSeq === undefined) return null
    if (!Number.isSafeInteger(row.octets) || row.octets < 0) return null
    versions.push(JSON.stringify([row.key, row.arrivalSeq, row.octets]))
  }
  return versions.sort()
}

/** A scope never contains a space (`SCOPE_SHAPE`), so the first space ends it. */
const entryKey = (scope: string, documentId: string) => `${scope} ${documentId}`

export class DurableHeadsMemo {
  /** Insertion order is recency: the first key is the least recently used. */
  private readonly entries = new Map<string, Entry>()
  /** documentId -> its entry keys, one per scope, so `forget` is not a scan. */
  private readonly keysByDocument = new Map<string, Set<string>>()
  private rowVersionCount = 0
  hits = 0
  misses = 0

  constructor(
    private readonly maxDocuments = 10_000,
    private readonly maxRowVersions = 200_000,
  ) {}

  get size(): number { return this.entries.size }

  /** Remember a strict, dependency-complete decode of exactly `rows`, all
   * read from one table (`scopeOf`). */
  remember(documentId: string, rows: readonly ScopedRowVersion[], heads: readonly string[]): boolean {
    const scope = scopeOf(rows)
    const versions = rowVersionSet(rows)
    // A new decode replaces the old entry; without a table to name, the
    // document is dropped everywhere (only ever costs a decode).
    if (scope === null) this.forget(documentId)
    else this.drop(entryKey(scope, documentId))
    if (scope === null || !versions || versions.length === 0 || versions.length > this.maxRowVersions) return false
    const key = entryKey(scope, documentId)
    this.entries.set(key, { documentId, versions, heads: [...heads] })
    let keys = this.keysByDocument.get(documentId)
    if (!keys) { keys = new Set(); this.keysByDocument.set(documentId, keys) }
    keys.add(key)
    this.rowVersionCount += versions.length
    while (this.entries.size > this.maxDocuments || this.rowVersionCount > this.maxRowVersions) {
      this.drop(this.entries.keys().next().value as string)
    }
    return true
  }

  /** The remembered heads when `rows` come from the remembered table and
   * their set EQUALS the remembered one; otherwise undefined, and a stale
   * entry of that table is dropped. */
  lookup(documentId: string, rows: readonly ScopedRowVersion[]): readonly string[] | undefined {
    const scope = scopeOf(rows)
    const key = scope === null ? undefined : entryKey(scope, documentId)
    const entry = key === undefined ? undefined : this.entries.get(key)
    if (!key || !entry) { this.misses++; return undefined }
    const versions = rowVersionSet(rows)
    if (!versions || versions.length !== entry.versions.length
      || !versions.every((version, index) => version === entry.versions[index])) {
      this.drop(key)
      this.misses++
      return undefined
    }
    // Refresh recency.
    this.entries.delete(key)
    this.entries.set(key, entry)
    this.hits++
    return [...entry.heads]
  }

  /** Drop `documentId` under EVERY scope. Only ever removes, so a caller that
   * cannot name the table (a removal, a refused bind) costs at most a decode
   * elsewhere, never a wrong hit. */
  forget(documentId: string): void {
    const keys = this.keysByDocument.get(documentId)
    if (!keys) return
    for (const key of [...keys]) this.drop(key)
  }

  clear(): void {
    this.entries.clear()
    this.keysByDocument.clear()
    this.rowVersionCount = 0
  }

  private drop(key: string): void {
    const entry = this.entries.get(key)
    if (!entry) return
    this.entries.delete(key)
    this.rowVersionCount -= entry.versions.length
    const keys = this.keysByDocument.get(entry.documentId)
    keys?.delete(key)
    if (keys?.size === 0) this.keysByDocument.delete(entry.documentId)
  }
}

/** Process-wide: fed by every `PostgresStorageAdapter` strict load, by the
 * proof's own worker decodes, by the cold build's sealed-product cache
 * hits, and by `PostgresStorageAdapter.compactToSnapshot` with the ONE row
 * version its own statement wrote, `A.save` of a dependency-complete
 * document, and that document's heads; read by the projector's proof. Entries are per table (THE SCOPE
 * above), so sharing one instance across pools is what lets the adapter's
 * pool and the projector's pool meet. */
export const durableHeadsMemo = new DurableHeadsMemo()
