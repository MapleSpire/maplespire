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

import assert from 'node:assert/strict'
import test from 'node:test'
import * as A from '@automerge/automerge'
import { generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import { readDurableDocument, verifyStoredAutomergeChunks } from './b514-durable-read.mjs'

const { documentId } = parseAutomergeUrl(generateAutomergeUrl())
const chunk = (kind, name, data) => ({ key: `${documentId}/${kind}/${name}`, data })
function fixture() {
  let doc = A.from({ markers: { first: 'before-fault' } })
  const before = A.getHeads(doc)
  const rows = [chunk('snapshot', 'first', A.save(doc))]
  doc = A.change(doc, (d) => { d.markers.second = 'during-fault' })
  rows.push(chunk('incremental', 'z', A.getLastLocalChange(doc)))
  doc = A.change(doc, (d) => { d.markers.third = 'after-fault' })
  rows.push(chunk('incremental', 'a', A.getLastLocalChange(doc)))
  const request = { documentId, heads: [...before, ...A.getHeads(doc)], markers: [{ path: ['markers', 'second'], value: 'during-fault' }] }
  A.free(doc)
  return { rows, request }
}

test('real snapshot and reversed incremental dependencies retain old and new heads', () => {
  const { rows, request } = fixture()
  rows.push(chunk('snapshot', 'duplicate', rows[0].data))
  rows.push(chunk('sync-state', 'peer', new Uint8Array([1, 2])))
  const result = verifyStoredAutomergeChunks(request, rows.reverse())
  assert.equal(result.status, 'verified')
  assert.equal(result.hasAllHeads, true)
  assert.equal(result.storedHeads.length, 1, 'old accepted heads need only exist in history')
  assert.equal(result.storage.contentChunkCount, 4)
  assert.equal(result.storage.syncStateChunkCount, 1)
  assert.equal(result.markerChecks[0].matched, true)
  assert.equal(JSON.stringify(result).includes('during-fault'), false, 'do not publish marker content')
  assert.equal(result.storage.fingerprintSha256, verifyStoredAutomergeChunks(request, [...rows].reverse()).storage.fingerprintSha256)
})

test('concurrent snapshots merge both independently authored frontiers', () => {
  const base = A.from({ markers: {} })
  const left = A.change(A.clone(base), (d) => { d.markers.left = 1 })
  const right = A.change(A.clone(base), (d) => { d.markers.right = 2 })
  const result = verifyStoredAutomergeChunks({ documentId, heads: [...A.getHeads(left), ...A.getHeads(right)], markers: [{ path: ['markers', 'right'], value: 2 }] }, [chunk('snapshot', 'a', A.save(left)), chunk('snapshot', 'b', A.save(right))])
  assert.equal(result.status, 'verified')
  assert.equal(result.storedHeads.length, 2)
  A.free(base)
  A.free(left)
  A.free(right)
})

test('missing acknowledged head and wrong marker are independent refusals', () => {
  const { rows, request } = fixture()
  const missing = verifyStoredAutomergeChunks({ ...request, heads: [...request.heads, 'f'.repeat(64)] }, rows)
  assert.equal(missing.status, 'not-durable')
  assert.deepEqual(missing.missingHeads, ['f'.repeat(64)])
  const wrong = verifyStoredAutomergeChunks({ ...request, markers: [{ path: ['markers', 'second'], value: 'different' }] }, rows)
  assert.equal(wrong.hasAllHeads, true)
  assert.equal(wrong.status, 'not-durable')
  assert.equal(wrong.markerChecks[0].matched, false)
})

test('absent content and sync-state alone cannot certify a document', () => {
  const { request } = fixture()
  for (const rows of [[], [chunk('sync-state', 'peer', new Uint8Array([1, 2]))]]) {
    const result = verifyStoredAutomergeChunks(request, rows)
    assert.equal(result.status, 'not-durable')
    assert.equal(result.hasAllHeads, false)
    assert.equal(result.storage.contentChunkCount, 0)
    assert.equal(result.markerChecks, null)
  }
})

test('unknown chunk kind remains incomplete beside otherwise valid content', () => {
  const { rows, request } = fixture()
  const result = verifyStoredAutomergeChunks(request, [...rows, chunk('future-format', 'x', new Uint8Array([1]))])
  assert.equal(result.status, 'incomplete')
  assert.equal(result.hasAllHeads, null)
  assert.deepEqual(result.storage.otherChunkKinds, ['future-format'])
})

test('strict loader rejects trailing garbage and a missing change dependency', () => {
  const { rows, request } = fixture()
  const corrupt = [{ ...rows[0], data: Buffer.concat([rows[0].data, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]) }]
  // The real dependency's permissive incremental reader WOULD accept this prefix.
  const permissive = A.loadIncremental(A.init(), corrupt[0].data)
  assert.equal(A.hasHeads(permissive, [request.heads[0]]), true)
  A.free(permissive)
  for (const input of [corrupt, [rows[2]]]) {
    const result = verifyStoredAutomergeChunks(request, input)
    assert.equal(result.status, 'incomplete')
    assert.equal(result.reason, 'invalid-automerge-content')
    assert.equal(result.hasAllHeads, null)
  }
})

function fakeClient(rows, { failAt = null, rollbackFails = false, state = {}, census = null } = {}) {
  const calls = []
  return {
    calls,
    async query(sql, parameters) {
      calls.push({ sql, parameters })
      if (sql === 'ROLLBACK' && rollbackFails) throw new Error('rollback failure')
      if (failAt && sql.startsWith(failAt)) throw new Error('query failure')
      if (sql.startsWith('SELECT current_setting')) return { rows: [{ isolation: 'repeatable read', read_only: 'on', snapshot_id: '1:2:', snapshot_at: '2026-09-07 00:00:00+00', ...state }] }
      if (sql.startsWith('SELECT count')) return { rows: [census ?? { row_count: String(rows.length), total_bytes: String(rows.reduce((total, row) => total + row.data.byteLength, 0)) }] }
      if (sql.startsWith('SELECT key')) return { rows }
      return { rows: [] }
    },
  }
}

test('reader takes and confirms one read-only snapshot, then commits before returning proof', async () => {
  const { rows, request } = fixture()
  const client = fakeClient(rows)
  const result = await readDurableDocument(client, request)
  assert.equal(result.status, 'verified')
  assert.equal(result.snapshot.read_only, 'on')
  assert.equal(client.calls[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(client.calls.at(-1).sql, 'COMMIT')
  assert.equal(client.calls.filter(({ sql }) => sql.startsWith('SELECT')).length, 3)
  for (const call of client.calls.filter(({ sql }) => sql.includes('FROM automerge_storage'))) {
    assert.deepEqual(call.parameters, [documentId, documentId])
    assert.equal(call.sql.includes("IN ('snapshot'"), false, 'census may not silently exempt unknown kinds')
  }
})

test('each awaited transaction failure rolls back and never returns a proof', async () => {
  const { rows, request } = fixture()
  for (const failAt of ['BEGIN', 'SET LOCAL statement', 'SET LOCAL idle', 'SELECT current_setting', 'SELECT count', 'SELECT key', 'COMMIT']) {
    const client = fakeClient(rows, { failAt })
    await assert.rejects(readDurableDocument(client, request), /query failure/)
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK', failAt)
  }
  await assert.rejects(readDurableDocument(fakeClient(rows, { failAt: 'SELECT key', rollbackFails: true }), request), (error) => error instanceof AggregateError && error.errors.length === 2)
})

test('wrong isolation, missing metadata, oversized census and changed census refuse before publication', async () => {
  const { rows, request } = fixture()
  for (const options of [
    { state: { isolation: 'read committed' } }, { state: { read_only: 'off' } }, { state: { snapshot_id: null } },
    { census: { row_count: '10001', total_bytes: '0' } }, { census: { row_count: '1', total_bytes: '16777217' } },
    { census: { row_count: '0', total_bytes: '0' } },
  ]) {
    const client = fakeClient(rows, options)
    await assert.rejects(readDurableDocument(client, request))
    assert.equal(client.calls.at(-1).sql, 'ROLLBACK')
  }
})

test('invalid expected frontier makes no database call; rows from another identity are rejected', async () => {
  const { rows, request } = fixture()
  for (const heads of [[], [request.heads[0], request.heads[0]], ['x'.repeat(64)]]) {
    const client = fakeClient(rows)
    await assert.rejects(readDurableDocument(client, { ...request, heads }))
    assert.equal(client.calls.length, 0)
  }
  assert.throws(() => verifyStoredAutomergeChunks(request, [{ ...rows[0], key: `other/snapshot/a` }]))
  assert.throws(() => verifyStoredAutomergeChunks(request, [rows[0], rows[0]]))
})

test('document identity is exact, never an URL carrying path or historical heads', async () => {
  const { rows, request } = fixture()
  for (const id of [`automerge:${documentId}`, `${documentId}#`, `${documentId}/child`]) {
    const client = fakeClient(rows)
    await assert.rejects(readDurableDocument(client, { ...request, documentId: id }), /documentId/)
    assert.equal(client.calls.length, 0)
  }
})

test('the expected frontier and marker are owned before the first asynchronous database step', async () => {
  const { rows, request } = fixture()
  const client = fakeClient(rows)
  const query = client.query
  client.query = async (...args) => {
    if (args[0].startsWith('BEGIN')) {
      request.heads.push('f'.repeat(64))
      request.markers[0].path[0] = 'changed'
      request.markers[0].value = 'changed'
    }
    return query(...args)
  }
  const result = await readDurableDocument(client, request)
  assert.equal(result.status, 'verified')
  assert.equal(result.requestedHeads.includes('f'.repeat(64)), false)
})
