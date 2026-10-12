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

// Seal what the projector believed it wrote, in the transaction that wrote it.
//
// Comparing two full traversals of the document graph captured at different
// times (see divergence.ts) cannot cleanly tell LAG from DIVERGENCE. A digest
// removes that ambiguity structurally instead of filtering it heuristically.
// The projector already writes the `ro_*` rows and its generation
// stamp in ONE transaction (`withReadModelProjectionTransaction`). Adding the
// digest of the id set it just wrote to that same transaction turns
//
//   "the read model at generation N holds exactly this id set"
//
// into a COMMITTED FACT rather than something inferred later. Verification is
// then one indexed aggregate against `ro_*`, with no Automerge repo, no document
// resolution, no fight with the residency evictor, no second pass and no race:
// both operands carry the same generation.
//
// WHAT THIS COVERS (narrowly): the PRIMARY KEYS of four tables —
// ro_objects, ro_connections, ro_groups, ro_diagrams — between the extractor's
// output and the bytes on disk. Within that: a partial commit, an `ON CONFLICT`
// that silently affected no row, rows deleted out of band, a row surviving a
// delete, RLS changing which rows the aggregate sees, a compaction bug, storage
// corruption.
//
// WHAT IT DOES NOT COVER, three separate holes:
//
//  1. ROW CONTENT. The digest is over `id` alone, so a row with the right id and
//     a stale `data`, `parent_id` or `normalized_name` matches perfectly. Since
//     the delta path's whole job is `ON CONFLICT … DO UPDATE`, the dominant
//     failure mode of the incremental projector is invisible here by
//     construction. Hashing `id || content` would close this, but needs a
//     canonical jsonb serialisation pinned on both sides first.
//  2. THE OTHER `ro_*` TABLES. Notably `ro_connection_flows`,
//     `ro_diagram_connections`, the technology/tag/team postings, and
//     `ro_workspace_stats` — which is maintained by `adjustWorkspaceCount(±delta)`
//     with a `GREATEST(0, …)` clamp, i.e. an unreconciled running counter, the
//     textbook drift source.
//  3. A DEFECT IN THE EXTRACTOR. Both the digest and the rows descend from
//     `extractModelEntities`, so a shard it failed to read is absent from both
//     and cancels. `modelDefects.ts` closes that from the reader side, not
//     this file.
//
// Note what hole 3 does NOT close: a document that is present but only PARTIALLY
// synced yields a real, non-empty map, so no defect is recorded and the digest
// then seals the truncated id set as authoritative. Both mechanisms are blind
// there, and nothing in this design addresses it.
//
// WHY (count, XOR) rather than a sorted hash: XOR is order-independent, so the
// SQL side needs no ORDER BY and no sort over 100 000 rows; and it is
// incrementally updatable, which is what lets the delta projection paths
// maintain it later without re-extracting (see the generation note below).
// XOR alone cannot see a duplicated id — a ⊕ a = 0 — so the count travels with
// it. On the `ro_*` tables the primary key makes duplicates unreachable anyway;
// the count is there so the digest stays honest if it is ever pointed at a
// collection that has no such key.

import { createHash } from 'node:crypto'

/** The read-model kinds whose full id set a projection can know. */
export type DigestKind = 'object' | 'connection' | 'group' | 'diagram'

export const DIGEST_KINDS: readonly DigestKind[] = ['object', 'connection', 'group', 'diagram']

export interface ContentDigest {
  /** Cardinality. Carried alongside the XOR because XOR cannot see duplicates. */
  n: number
  /** XOR of the per-id 64-bit hashes, as 16 lowercase hex characters. */
  x: string
}

/** A digest plus the projection generation it was computed at. A digest whose
 * generation is behind `projected_generation` describes a read model that has
 * since changed, and comparing it would manufacture a false mismatch. */
export interface StampedDigest extends ContentDigest {
  g: number
}

const MASK64 = (1n << 64n) - 1n

/**
 * The 64-bit hash of one id.
 *
 * This MUST stay bit-identical to the SQL in `digestSql` below, so the choice is
 * dictated by what PostgreSQL can compute cheaply over a whole table:
 * `('x' || md5(id))::bit(64)::bigint` takes the FIRST 16 hex characters of the
 * md5 — `bit(64)` truncates the 128-bit string on the right — and reinterprets
 * them as a signed bigint. We hold the value unsigned here and only render it as
 * hex, which is the two's-complement representation PostgreSQL's `to_hex`
 * produces for the negative half, so the two agree without either side having to
 * reason about sign.
 *
 * md5 is not a security choice — nothing here defends against a chosen-id
 * attack, and an attacker who can write ids can write rows. It is the widest
 * hash available as a builtin PostgreSQL aggregate input without an extension.
 */
function hash64(id: string): bigint {
  return BigInt(`0x${createHash('md5').update(id, 'utf8').digest('hex').slice(0, 16)}`)
}

/**
 * `String(id)` rather than trusting the declared type, because this must be
 * TOTAL.
 *
 * `createHash().update()` throws a TypeError on a non-string, and the digest is
 * computed by `fullExtractionIntegrity` in an ARGUMENT position — evaluated
 * before `runTracked` opens its health span. A throw there would abort the
 * whole cold build AND leave the workspace with no `last_error_code`, reading
 * as `uninitialized` rather than `failed`, for an entity with a numeric id that
 * otherwise projects fine (node-postgres coerces it for a `text` column).
 * Coercing the same way the database does keeps the two sides agreeing and
 * keeps a bookkeeping value from becoming a failure mode.
 */
export function digestOfIds(ids: Iterable<string>): ContentDigest {
  let n = 0
  let x = 0n
  for (const id of ids) {
    n += 1
    x ^= hash64(typeof id === 'string' ? id : String(id))
  }
  return { n, x: (x & MASK64).toString(16).padStart(16, '0') }
}

export function digestsEqual(a: ContentDigest, b: ContentDigest): boolean {
  return a.n === b.n && a.x === b.x
}

/** The `ro_` table each kind is verified against. */
const DIGEST_TABLE: Record<DigestKind, string> = {
  object: 'ro_objects',
  connection: 'ro_connections',
  group: 'ro_groups',
  diagram: 'ro_diagrams',
}

/**
 * The SQL counterpart of `digestOfIds`, as one aggregate over the workspace's
 * rows.
 *
 * `bit_xor` returns NULL over zero rows, which would render as an empty string
 * and compare unequal to the all-zero digest of an empty set — hence the
 * COALESCE. `to_hex` drops leading zeros, hence the `lpad`. Both of those are
 * the sort of detail that produces a permanent, inexplicable mismatch on exactly
 * one workspace, so they are covered by an integration test that compares this
 * query against `digestOfIds` over the same ids rather than against a constant.
 *
 * The table name is interpolated from a closed record, never from a caller
 * string — this query takes only the workspace key as parameters.
 */
export function digestSql(kind: DigestKind): string {
  return `SELECT count(*)::bigint AS n,
       lpad(to_hex(coalesce(bit_xor(('x' || md5(id))::bit(64)::bigint), 0)), 16, '0') AS x
     FROM ${DIGEST_TABLE[kind]}
     WHERE landscape_id = $1 AND version_id = $2`
}

export function digestTable(kind: DigestKind): string {
  return DIGEST_TABLE[kind]
}

/** Parse what `digestSql` returned. `count(*)::bigint` arrives as a string from
 * node-postgres, and `Number()` on it is exact well past any plausible row
 * count. A row that cannot be parsed is a broken read, not an empty set. */
export function parseDigestRow(row: { n: string | number; x: string } | undefined): ContentDigest | null {
  if (!row) return null
  const n = Number(row.n)
  if (!Number.isFinite(n) || typeof row.x !== 'string' || !/^[0-9a-f]{16}$/.test(row.x)) return null
  return { n, x: row.x }
}

export type DigestOutcome = 'match' | 'mismatch' | 'not-verifiable'

export interface DigestVerdict {
  kind: DigestKind
  outcome: DigestOutcome
  /** What the projector sealed, when there is one. */
  expected: StampedDigest | null
  /** What the table holds now. Null when the aggregate could not be read. */
  actual: ContentDigest | null
  /** Always present for `not-verifiable`: a verdict of "I did not check" has to
   * say why, or it reads as "I checked and it was fine". */
  reason?: string
}

/**
 * Decide ONE kind, given the sealed digest and the live aggregate.
 *
 * Pure, so the rule is unit-tested rather than only exercised against a live
 * database, and so the generation guard in particular can be tested at every
 * boundary. The guard is the whole reason this is trustworthy: a digest sealed
 * at generation 7 says nothing about a read model that has been projected 40
 * times since, and reporting `match` for it would claim "clean" for something
 * never measured.
 */
export function verifyDigest(
  kind: DigestKind,
  expected: StampedDigest | null,
  actual: ContentDigest | null,
  projectedGeneration: number | null,
): DigestVerdict {
  if (!expected) {
    return {
      kind,
      outcome: 'not-verifiable',
      expected: null,
      actual,
      reason: `no digest has been sealed for ${kind} on this workspace`,
    }
  }
  if (projectedGeneration === null) {
    return {
      kind,
      outcome: 'not-verifiable',
      expected,
      actual,
      reason: 'the workspace has no projection generation, so the digest cannot be dated',
    }
  }
  if (expected.g !== projectedGeneration) {
    return {
      kind,
      outcome: 'not-verifiable',
      expected,
      actual,
      reason: `digest was sealed at generation ${expected.g}, read model is at ${projectedGeneration}`,
    }
  }
  if (!actual) {
    return { kind, outcome: 'not-verifiable', expected, actual: null, reason: 'the read-model aggregate could not be read' }
  }
  return { kind, outcome: digestsEqual(expected, actual) ? 'match' : 'mismatch', expected, actual }
}

/** Compact one-line report. `verified` is stated explicitly because "0 mismatches"
 * over 0 verified kinds is the shape that reads as healthy and is not. */
export function summarizeDigestVerdicts(verdicts: readonly DigestVerdict[]): string {
  const mismatched = verdicts.filter((v) => v.outcome === 'mismatch')
  const verified = verdicts.filter((v) => v.outcome === 'match').length
  const head = `verified=${verified}/${verdicts.length}`
  if (mismatched.length === 0) return head
  const detail = mismatched
    .map((v) => `${v.kind}: sealed ${v.expected?.n ?? '?'}/${v.expected?.x ?? '?'} vs rows ${v.actual?.n ?? '?'}/${v.actual?.x ?? '?'}`)
    .join('; ')
  return `${head} MISMATCH ${detail}`
}
