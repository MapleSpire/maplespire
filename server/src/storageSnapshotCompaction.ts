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

import { createHash } from 'node:crypto'
import * as A from '@automerge/automerge'

/**
 * On-demand storage compaction of ONE document to ONE snapshot row (G4-16f):
 * the pure half of `PostgresStorageAdapter.compactToSnapshot`.
 *
 * Why: the overlay fold writes every base shard once per pass, so each pass
 * adds one incremental row per base shard, and automerge-repo compacts a
 * document only when its incrementals outweigh its snapshot
 * (`StorageSubsystem #shouldCompact`), which a 200 kB shard gaining ~5 kB a
 * pass does not reach in 30 days. Loading a snapshot plus N incrementals cost
 * ~6 ms more per chunk than the same history as one snapshot (stored 240 ms,
 * saved 116 ms per shard at day 25): 83 % of the in-epoch growth of the pass.
 *
 * THE COVERAGE RULE — what may be deleted. A stored row may be removed only
 * when every change it holds is in the document `doc` whose `A.save` replaces
 * it. Deciding that from what automerge-repo believes (its private
 * `#chunkInfos`) would need a patch of `node_modules`; deciding it from the
 * row's age would race the Repo's own saves (an incremental saved between the
 * read and the delete holds changes `doc` may lack). So each row is CHECKED:
 *  - a row this adapter wrote itself through this path, at the exact version
 *    it wrote (key, arrival_seq, octets, scope), is covered iff `doc` has the
 *    heads that snapshot was made at (`A.hasHeads`): the bytes are `A.save`
 *    of a document at those heads;
 *  - any other row is covered iff applying its bytes to a CLONE of `doc`
 *    changes neither its heads nor leaves a missing dependency
 *    ({@link documentContainsChunk}): every change in the bytes is then
 *    already in `doc`.
 * The delete then names each covered row by its exact version, so a row
 * rewritten after the check (a fresh `arrival_seq`) is not deleted.
 */

/** `[documentId, 'snapshot', headsHash(heads)]` exactly as automerge-repo
 * keys a snapshot (`storage/keyHash.js` `headsHash`: sha-256 of the
 * concatenated heads, hex), so a snapshot it later writes at the same heads
 * upserts the same row. */
export function snapshotStorageKey(documentId: string, heads: readonly string[]): [string, 'snapshot', string] {
  const hash = createHash('sha256')
  for (const head of heads) hash.update(head, 'utf8')
  return [documentId, 'snapshot', hash.digest('hex')]
}

export function sameHeads(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const sorted = [...b].sort()
  return [...a].sort().every((head, index) => head === sorted[index])
}

const CHUNK_MAGIC = [0x85, 0x6f, 0x4a, 0x83] as const

let coverageCheckErrors = 0
/** How many coverage checks threw since the process started (each also
 * logged as `storage_compaction.coverage_check_error`). */
export function storageCompactionCoverageErrors(): number {
  return coverageCheckErrors
}

/**
 * `bytes` is a sequence of whole Automerge chunks of the two kinds
 * automerge-repo stores (a document chunk, type 0, from `A.save`; change
 * chunks, type 1, from `A.saveSince`), each with its magic and a checksum
 * that matches (the first four bytes of the sha-256 of type, length and
 * body — the change hash for a change chunk), tiling the bytes exactly.
 * Why it is asked: `A.loadIncremental` silently IGNORES bytes it cannot read
 * (measured: five garbage bytes leave the heads unchanged), so without it an
 * unreadable row would pass {@link documentContainsChunk} as "nothing new".
 * Any other chunk type (a compressed change, a bundle) answers false: the row
 * is kept, which only costs a row.
 */
export function wellFormedChunks(bytes: Uint8Array): boolean {
  return splitChunks(bytes) !== null
}

/** The chunks of `bytes` (whole, checksummed, type 0 or 1, tiling them
 * exactly), or null ({@link wellFormedChunks}). */
function splitChunks(bytes: Uint8Array): Array<{ type: 0 | 1; bytes: Uint8Array }> | null {
  let offset = 0
  if (!bytes.length) return null
  const chunks: Array<{ type: 0 | 1; bytes: Uint8Array }> = []
  while (offset < bytes.length) {
    if (offset + 10 > bytes.length) return null
    for (let i = 0; i < 4; i += 1) if (bytes[offset + i] !== CHUNK_MAGIC[i]) return null
    const type = bytes[offset + 8]
    if (type !== 0 && type !== 1) return null
    let length = 0
    let shift = 0
    let cursor = offset + 9
    while (true) {
      if (cursor >= bytes.length || shift > 35) return null
      const byte = bytes[cursor++]!
      length += (byte & 0x7f) * 2 ** shift
      shift += 7
      if (!(byte & 0x80)) break
    }
    const end = cursor + length
    if (end > bytes.length) return null
    const checksum = createHash('sha256').update(bytes.subarray(offset + 8, end)).digest()
    for (let i = 0; i < 4; i += 1) if (bytes[offset + 4 + i] !== checksum[i]) return null
    chunks.push({ type, bytes: bytes.subarray(offset, end) })
    offset = end
  }
  return chunks
}

function noteCoverageErrorOf(octets: number, error: unknown): void {
  // Not covered (the row is kept), but never silent: well-formed
  // chunks that Automerge refuses are worth knowing about.
  coverageCheckErrors += 1
  console.warn(JSON.stringify({
    event: 'storage_compaction.coverage_check_error',
    octets,
    total: coverageCheckErrors,
    error: error instanceof Error ? error.message : String(error),
  }))
}

/**
 * Every change stored in `bytes` (a snapshot or an incremental chunk, or a
 * concatenation of them) is already in `doc`, whose heads are `heads`. The
 * bytes must be whole, checksummed chunks ({@link wellFormedChunks}); then
 *  - each CHANGE chunk (type 1) is decoded on its own (`A.decodeChange`,
 *    which refuses a body that is not a change — `loadIncremental` would
 *    silently ignore it, measured on a hand-framed garbage body with a valid
 *    checksum) and its hash must be in `doc` (`A.hasHeads`): the change is
 *    then there, byte for byte (its hash is of its bytes);
 *  - DOCUMENT chunks (type 0) are loaded into a clone of `doc` and must add
 *    no head and queue no change with a missing dependency. (A document
 *    chunk's body is not checked beyond its checksum: corruption fails the
 *    checksum; a body crafted to pass it is not a threat this rules out.)
 * Anything that throws is NOT covered, and is counted and logged. `doc`
 * itself is never modified; the clone is freed.
 */
export function documentContainsChunk(
  doc: A.Doc<unknown>, heads: readonly string[], bytes: Uint8Array,
  /** Count and log a refusal (once per ROW — the concatenated first
   * try of `partitionCoveredRows` passes false, its row-by-row fallback
   * counts). */
  countErrors = true,
): boolean {
  const noteCoverageError = countErrors ? noteCoverageErrorOf : () => undefined
  const chunks = splitChunks(bytes)
  if (!chunks) return false
  const hashes: string[] = []
  const documents: Uint8Array[] = []
  try {
    for (const chunk of chunks) {
      if (chunk.type === 1) {
        const hash = A.decodeChange(chunk.bytes).hash
        if (!hash) return false
        hashes.push(hash)
      } else documents.push(chunk.bytes)
    }
  } catch (error) {
    noteCoverageError(bytes.byteLength, error)
    return false
  }
  if (hashes.length && !A.hasHeads(doc, hashes)) return false
  if (!documents.length) return true
  let probe: A.Doc<unknown> | undefined
  try {
    const all = new Uint8Array(documents.reduce((sum, chunk) => sum + chunk.byteLength, 0))
    let offset = 0
    for (const chunk of documents) { all.set(chunk, offset); offset += chunk.byteLength }
    probe = A.clone(doc)
    probe = A.loadIncremental(probe, all)
    // `getMissingDeps` is close to redundant now: change chunks are
    // checked by hash above, and a document chunk carries its own history.
    // Kept as a defence: a document chunk whose changes reference one the
    // clone lacks must not pass as "nothing new".
    return sameHeads(A.getHeads(probe), heads) && A.getMissingDeps(probe, []).length === 0
  } catch (error) {
    noteCoverageError(bytes.byteLength, error)
    return false
  } finally {
    if (probe) {
      try { A.free(probe) } catch { /* already released */ }
    }
  }
}

/** A snapshot row this adapter wrote through `compactToSnapshot`: its exact
 * stored version and the heads of the document it is `A.save` of. */
export interface OwnSnapshotRow {
  key: string
  arrivalSeq: string
  octets: number
  /** md5 of the bytes as stored, from the writing statement's RETURNING:
   * a row of the same key, sequence and length whose bytes were
   * changed in place is NOT this row. */
  digest: string
  scope: string | null
  heads: readonly string[]
}

/** One stored content row of the document, as the compaction read it. `data`
 * is absent for the row the adapter recognised as its own snapshot. */
export interface CompactionCandidateRow {
  key: string
  arrivalSeq: string | null
  octets: number
  /** md5 of the stored bytes, read in the same statement (the delete
   * compares it). Absent: the row can never be deleted. */
  digest?: string
  scope: string | null
  data?: Uint8Array
}

/** Split `rows` into the ones `doc` (heads `heads`) covers and the rest
 * (THE COVERAGE RULE above). */
export function partitionCoveredRows(
  doc: A.Doc<unknown>,
  heads: readonly string[],
  rows: readonly CompactionCandidateRow[],
  own: OwnSnapshotRow | undefined,
): { covered: CompactionCandidateRow[]; kept: CompactionCandidateRow[] } {
  const covered: CompactionCandidateRow[] = []
  const kept: CompactionCandidateRow[] = []
  const toCheck: CompactionCandidateRow[] = []
  for (const row of rows) {
    const isOwn = own !== undefined && row.key === own.key && row.arrivalSeq === own.arrivalSeq
      && row.octets === own.octets && row.scope === own.scope
      && row.digest !== undefined && row.digest === own.digest
    if (isOwn) (A.hasHeads(doc, [...own.heads]) ? covered : kept).push(row)
    else if (row.data === undefined) kept.push(row)
    else toCheck.push(row)
  }
  // ONE clone-and-load of every row to check, concatenated (the
  // first pass on a shard with ~40 rows paid 40 clones; measured 15/11/2026
  // on 512 objects, 40 rows, 520 kB, 441 k ops: the whole first
  // `compactToSnapshot` 52-61 ms either way, the clone being cheap, so
  // this is a bound on the worst case rather than a measured gain); the concatenation
  // is covered iff each part is (whole chunks tile it, and a change in any
  // part that `doc` lacks moves the heads or leaves a missing dependency).
  // Only when it is NOT covered, row by row, to keep the rows that are.
  if (toCheck.length > 1) {
    const total = toCheck.reduce((sum, row) => sum + row.data!.byteLength, 0)
    const all = new Uint8Array(total)
    let offset = 0
    for (const row of toCheck) { all.set(row.data!, offset); offset += row.data!.byteLength }
    if (documentContainsChunk(doc, heads, all, false)) {
      covered.push(...toCheck)
      return { covered, kept }
    }
  }
  for (const row of toCheck) (documentContainsChunk(doc, heads, row.data!) ? covered : kept).push(row)
  return { covered, kept }
}
