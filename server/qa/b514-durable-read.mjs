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
import { isValidDocumentId } from '@automerge/automerge-repo'

const HEAD = /^[0-9a-f]{64}$/
const MAX_BYTES = 16 * 1024 * 1024
const MAX_ROWS = 10_000
const PREDICATE = "key = $1 OR key LIKE $2 || '/%' ESCAPE '\\'"
const digest = (value) => createHash('sha256').update(value).digest('hex')
const fingerprint = (value) => digest(JSON.stringify(value))

function validateRequest({ documentId, heads, markers = [] }) {
  if (!isValidDocumentId(documentId)) throw new TypeError('Invalid documentId')
  if (!Array.isArray(heads) || heads.length === 0 || heads.length > 512
    || !heads.every((head) => typeof head === 'string' && HEAD.test(head))
    || new Set(heads).size !== heads.length) throw new TypeError('Expected distinct nonempty hex heads')
  if (!Array.isArray(markers) || markers.length > 1_024) throw new TypeError('Invalid markers')
  for (const marker of markers) {
    if (!marker || !Array.isArray(marker.path) || marker.path.length === 0 || marker.path.length > 16
      || !marker.path.every((part) => (typeof part === 'string' && part.length > 0)
        || (Number.isSafeInteger(part) && part >= 0))
      || !Object.hasOwn(marker, 'value') || !(marker.value === null
        || ['string', 'boolean'].includes(typeof marker.value)
        || (typeof marker.value === 'number' && Number.isFinite(marker.value)))) {
      throw new TypeError('Markers require a path and a primitive value')
    }
  }
  // Own the expected frontier before the first await; a caller may keep editing.
  return { documentId, heads: [...heads], markers: markers.map(({ path, value }) => ({ path: [...path], value })) }
}

function markerChecks(doc, markers) {
  return markers.map(({ path, value }, index) => {
    let actual = doc
    let present = true
    for (const part of path) {
      if (actual === null || typeof actual !== 'object' || !Object.hasOwn(actual, part)) {
        present = false
        break
      }
      actual = actual[part]
    }
    return {
      index,
      matched: present && Object.is(actual, value),
      expectedSha256: fingerprint(value),
      // An object at the expected primitive path is a mismatch; do not emit its content.
      actualSha256: present && (actual === null || ['string', 'boolean', 'number'].includes(typeof actual))
        ? fingerprint(actual) : null,
    }
  })
}

/** Pure binary verification: no Repo, peer, adapter, database or write side effect.
 * Unknown kinds and invalid content stay incomplete, even if known chunks contain
 * the requested heads. sync-state is bookkeeping, never document content.
 */
export function verifyStoredAutomergeChunks(request, rows) {
  const { documentId, heads, markers } = validateRequest(request)
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new TypeError('Invalid chunk row count')
  const seen = new Set()
  const chunks = rows.map(({ key, data }) => {
    if (typeof key !== 'string' || key.split('/')[0] !== documentId || seen.has(key)
      || !(data instanceof Uint8Array)) throw new TypeError('Invalid stored chunk row')
    seen.add(key)
    const parts = key.split('/')
    return { key, kind: parts[1] ?? '', data, validKey: parts.length === 3 && parts[2].length > 0 }
  }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  const totalBytes = chunks.reduce((total, chunk) => total + chunk.data.byteLength, 0)
  if (totalBytes > MAX_BYTES) throw new RangeError('Document exceeds the reader byte budget')
  const content = chunks.filter(({ kind }) => kind === 'snapshot' || kind === 'incremental')
  const chunkProofs = chunks.map(({ key, kind, data }) => ({ key, kind, bytes: data.byteLength, sha256: digest(data) }))
  const proof = {
    schema: 'b514-durable-read/v1', documentId,
    status: 'incomplete', reason: null,
    requestedHeads: heads, storedHeads: null, hasAllHeads: null, missingHeads: null,
    markerChecks: null,
    storage: {
      rowCount: chunks.length, totalBytes, contentChunkCount: content.length,
      snapshotChunkCount: content.filter(({ kind }) => kind === 'snapshot').length,
      incrementalChunkCount: content.filter(({ kind }) => kind === 'incremental').length,
      syncStateChunkCount: chunks.filter(({ kind }) => kind === 'sync-state').length,
      otherChunkKinds: [...new Set(chunks.filter(({ kind }) => !['snapshot', 'incremental', 'sync-state'].includes(kind)).map(({ kind }) => kind))],
      fingerprintSha256: fingerprint(chunkProofs), chunks: chunkProofs,
    },
  }
  if (chunks.some(({ validKey }) => !validKey) || proof.storage.otherChunkKinds.length > 0) {
    return { ...proof, reason: 'unsupported-storage-key-or-kind' }
  }
  if (content.length === 0) {
    return { ...proof, status: 'not-durable', reason: 'no-content-chunks', hasAllHeads: false, missingHeads: heads }
  }
  // Same ordering as StorageSubsystem.loadDocData: snapshots then incrementals.
  // A.load is strict about missing dependencies and trailing garbage. Deliberately
  // no loadIncremental fallback: server/automerge-bulk-load.test.mjs demonstrates
  // that fallback accepting garbage that the bulk loader rejects.
  const binary = Buffer.concat(['snapshot', 'incremental'].flatMap((kind) => content.filter((chunk) => chunk.kind === kind).map(({ data }) => data)))
  let doc
  try {
    doc = A.load(binary)
  } catch {
    return { ...proof, reason: 'invalid-automerge-content' }
  }
  try {
    proof.storedHeads = A.getHeads(doc).sort()
    proof.missingHeads = heads.filter((head) => !A.hasHeads(doc, [head]))
    proof.hasAllHeads = proof.missingHeads.length === 0
    proof.markerChecks = markerChecks(doc, markers)
    proof.status = proof.hasAllHeads && proof.markerChecks.every(({ matched }) => matched) ? 'verified' : 'not-durable'
    proof.reason = proof.status === 'verified' ? null : 'heads-or-markers-missing'
    return proof
  } finally {
    A.free(doc)
  }
}

/** Read one document from a caller-owned, connected, EXCLUSIVE AND IDLE pg Client.
 * This function owns its transaction, not the connection: never pass a Pool, an
 * existing transaction, or a client another task uses. The caller must close or
 * release the client after this promise settles, destroying it on transport error.
 * SQL deadlines do not cancel a broken transport; the enclosing process owns its
 * wall-clock limit and cleanup. No credentials, document content or marker values
 * are returned. Marker matching concerns current content, heads concern history.
 */
export async function readDurableDocument(client, request) {
  const ownedRequest = validateRequest(request)
  const documentId = ownedRequest.documentId
  const parameters = [documentId, documentId.replace(/([%_\\])/g, '\\$1')]
  let rows
  let snapshot
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5000ms'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10000ms'")
    const state = await client.query(`SELECT current_setting('transaction_isolation') AS isolation,
      current_setting('transaction_read_only') AS read_only,
      pg_current_snapshot()::text AS snapshot_id,
      transaction_timestamp()::text AS snapshot_at`)
    snapshot = state.rows[0]
    if (snapshot?.isolation !== 'repeatable read' || snapshot.read_only !== 'on'
      || typeof snapshot.snapshot_id !== 'string' || !snapshot.snapshot_id
      || typeof snapshot.snapshot_at !== 'string' || !snapshot.snapshot_at) {
      throw new Error('PostgreSQL did not confirm a read-only repeatable-read snapshot')
    }
    // Count ALL kinds before selecting bytes, including future/unknown ones. The
    // same MVCC snapshot protects the census and read against compaction/deletion.
    const census = await client.query(`SELECT count(*)::text AS row_count,
      COALESCE(sum(octet_length(data)), 0)::text AS total_bytes
      FROM automerge_storage WHERE ${PREDICATE}`, parameters)
    const count = census.rows[0]
    if (!count || !/^\d+$/.test(count.row_count) || !/^\d+$/.test(count.total_bytes)
      || BigInt(count.row_count) > BigInt(MAX_ROWS) || BigInt(count.total_bytes) > BigInt(MAX_BYTES)) {
      throw new RangeError('Stored document census is invalid or exceeds the reader budget')
    }
    const result = await client.query(`SELECT key, data FROM automerge_storage WHERE ${PREDICATE} ORDER BY key`, parameters)
    rows = result.rows
    if (rows.length !== Number(count.row_count)
      || rows.reduce((sum, row) => sum + (row.data?.byteLength ?? NaN), 0) !== Number(count.total_bytes)) {
      throw new Error('Chunk rows do not match the same-snapshot census')
    }
    await client.query('COMMIT')
  } catch (error) {
    try { await client.query('ROLLBACK') } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Durable reader failed and rollback did not complete')
    }
    throw error
  }
  // End the transaction before synchronous WASM decoding and hashing.
  return { ...verifyStoredAutomergeChunks(ownedRequest, rows), source: 'postgresql', snapshot }
}
