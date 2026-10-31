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

import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Repo } from '@automerge/automerge-repo'
import pg from 'pg'
import { AuthenticatedWebSocketClientAdapter } from '../qa/authenticatedWebSocketAdapter.mjs'
import { requestedDocumentShare } from '../qa/lib.mjs'

const argv = process.argv.slice(2)
const arg = (name, fallback) => argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const api = arg('api', process.env.QA_API ?? 'http://localhost:3015').replace(/\/$/, '')
const wsBase = arg('ws', process.env.QA_WS ?? 'ws://localhost:3015/automerge')
const pgUrl = arg('pg', process.env.QA_PG ?? 'postgres://maplespire:maplespire@localhost:5455/maplespire')
const landscapeId = arg('landscapeId', process.env.QA_LANDSCAPE_ID ?? 'n54y6DChuvuGnnYu')
const versionId = arg('versionId', process.env.QA_VERSION_ID ?? '88uoFIGymDEvzxR6')
const email = arg('email', process.env.QA_EMAIL ?? 'admin@example.com')
const mutationCount = Number(arg('mutations', '10000'))
const convergenceBudgetMs = Number(arg('budgetMs', '3000'))
const handoffProject = arg('handoffProject', process.env.SYNC_FAILOVER_PROJECT ?? '')
const handoffComposeFile = arg(
  'handoffCompose',
  resolve(dirname(fileURLToPath(import.meta.url)), '../../infra/compose/sync-cell-failover.yml'),
)
const handoffCells = arg('handoffCells', process.env.SYNC_FAILOVER_CELL_URLS ?? '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean)
  .map((baseUrl, index) => ({ service: `sync-cell-${String.fromCharCode(97 + index)}`, baseUrl }))
const runId = randomUUID()
const entityId = `phase13-offline-rotation-gate-${runId}`
const ws = `${wsBase}${wsBase.includes('?') ? '&' : '?'}landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`

if (!Number.isSafeInteger(mutationCount) || mutationCount < 1 || mutationCount > 100_000) {
  throw new Error('--mutations must be an integer from 1 to 100000')
}

async function login() {
  const response = await fetch(`${api}/api/auth/dev-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`dev login returned HTTP ${response.status}`)
  const cookieHeader = response.headers.getSetCookie?.()[0] ?? response.headers.get('set-cookie')
  const cookie = cookieHeader?.match(/maplespire_session=[^;]+/)?.[0]
  if (!cookie) throw new Error('dev login did not return a session cookie')
  return cookie
}

function peer(cookie, urls) {
  const adapter = new AuthenticatedWebSocketClientAdapter(ws, cookie, 0)
  const requested = new Set(urls.map((url) => url.replace(/^automerge:/, '').split('?')[0]))
  const shareConfig = requestedDocumentShare(urls)
  // The server also announces small workspace control documents. This focused
  // gate deliberately accepts only its requested overlay heads so shutdown
  // cannot remain blocked waiting for an unrelated control document.
  shareConfig.access = async (_peerId, documentId) =>
    documentId === undefined || requested.has(documentId)
  const repo = new Repo({ network: [adapter], shareConfig })
  return { adapter, repo }
}

async function readyHandle(peerState, url) {
  const pending = peerState.repo.find(url)
  peerState.repo.shareConfigChanged()
  const handle = await pending
  await handle.whenReady()
  return handle
}

async function waitFor(label, read, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await delay(50)
  }
  throw new Error(`${label} timed out; last value: ${JSON.stringify(value)}`)
}

async function batchStatus(cookie, batchId) {
  const response = await fetch(
    `${api}/api/model/overlay-batches/status?landscapeId=${encodeURIComponent(landscapeId)}&versionId=${encodeURIComponent(versionId)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ batchIds: [batchId] }),
      signal: AbortSignal.timeout(10_000),
    },
  )
  if (!response.ok) throw new Error(`batch status returned HTTP ${response.status}: ${await response.text()}`)
  return (await response.json()).batches?.[0]
}

function compose(...args) {
  return execFileSync(
    'docker',
    ['compose', '-p', handoffProject, '-f', handoffComposeFile, ...args],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
}

async function workspaceRoute(cell, cookie) {
  const query = new URLSearchParams({ landscapeId, versionId })
  const response = await fetch(`${cell.baseUrl}/api/automerge/root?${query}`, {
    headers: { cookie },
    signal: AbortSignal.timeout(2_000),
  })
  response.body?.cancel().catch(() => undefined)
  return { status: response.status, route: response.headers.get('x-maplespire-sync-route') }
}

async function ownership(cell, cookie) {
  const response = await fetch(`${cell.baseUrl}/api/platform/sync-cell`, {
    headers: { cookie },
    signal: AbortSignal.timeout(2_000),
  })
  if (!response.ok) throw new Error(`${cell.service} ownership returned HTTP ${response.status}`)
  return response.json()
}

async function handoffWorkspace(cookie) {
  if (!handoffProject) return null
  if (handoffCells.length < 2) {
    throw new Error('--handoffCells requires at least two comma-separated cell URLs')
  }
  const initial = await waitFor(
    'workspace owner before offline replay',
    async () => Promise.all(handoffCells.map((cell) => workspaceRoute(cell, cookie).catch(() => null))),
    (routes) => routes?.filter((route) => route?.status === 200 && route.route === 'owner').length === 1,
  )
  const ownerIndex = initial.findIndex((route) => route?.status === 200 && route.route === 'owner')
  const original = handoffCells[ownerIndex]
  const originalState = await ownership(original, cookie)
  if (!originalState.ready || !Number.isSafeInteger(originalState.partitionIndex)) {
    throw new Error(`${original.service} is not a ready partition owner`)
  }

  const startedAt = performance.now()
  compose('pause', original.service)
  let replacement
  try {
    replacement = await waitFor(
      'replacement owner before offline replay',
      async () => {
        const states = await Promise.all(handoffCells.map((cell, index) => (
          index === ownerIndex ? Promise.resolve(null) : ownership(cell, cookie).catch(() => null)
        )))
        const index = states.findIndex((state) => (
          state?.ready === true && state.partitionIndex === originalState.partitionIndex
        ))
        return index >= 0 ? { cell: handoffCells[index], state: states[index] } : null
      },
      Boolean,
      30_000,
    )
  } finally {
    compose('unpause', original.service)
  }
  await waitFor(
    'former owner standby after offline handoff',
    () => ownership(original, cookie),
    (state) => state?.ready === false && state.partitionIndex === null,
    30_000,
  )
  return {
    originalService: original.service,
    replacementService: replacement.cell.service,
    partition: originalState.partitionIndex,
    takeoverMs: Math.round(performance.now() - startedAt),
  }
}

const cookie = await login()
const db = new pg.Pool({ connectionString: pgUrl, max: 4 })
const peers = []
try {
  const currentRow = async () => (await db.query(
    `SELECT document_id, segment_url FROM read_model_overlay_segments
     WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object' AND is_current`,
    [landscapeId, versionId],
  )).rows[0]
  const initial = await waitFor('current object head', currentRow, Boolean)
  const h1Url = initial.segment_url

  const offline = peer(cookie, [h1Url])
  const online = peer(cookie, [h1Url])
  peers.push(offline, online)
  const [offlineHandle, onlineHandle] = await Promise.all([
    readyHandle(offline, h1Url), readyHandle(online, h1Url),
  ])

  const baselineToken = randomUUID()
  const baselineBatchId = `gate-baseline-${baselineToken}`
  onlineHandle.change((doc) => {
    doc.writeHeadVersion = 2
    // Statement form, then re-read: the VALUE of `??=` is the plain literal,
    // not the Automerge list/map, so a write through it is lost when absent.
    doc.writeBatchIds ??= []
    doc.writeBatchIds.push(baselineBatchId)
    doc.objects ??= {}
    doc.objects[entityId] = {
      id: entityId,
      type: 'component',
      name: 'Offline rotation gate',
      description: 'baseline',
      status: 'live',
      scope: 'internal',
      properties: { baselineToken },
    }
  })
  await waitFor(
    'offline baseline replication',
    () => offlineHandle.doc()?.objects?.[entityId]?.properties?.baselineToken,
    (value) => value === baselineToken,
  )
  await waitFor(
    'durable baseline acknowledgement',
    () => batchStatus(cookie, baselineBatchId),
    (row) => row?.status === 'projected',
  )
  offline.adapter.disconnect()
  await delay(100)

  const onlineMarker = `online-${randomUUID()}`
  onlineHandle.change((doc) => {
    const object = doc.objects[entityId]
    object.description = 'online-current-value'
    object.properties.onlineMarker = onlineMarker
    doc.writeBatchIds ??= []
    for (let index = 0; index < 32; index += 1) {
      doc.writeBatchIds.push(`gate-rotate-${baselineToken}-${index}`)
    }
  })
  const finalRotationBatchId = `gate-rotate-${baselineToken}-31`
  await waitFor(
    'durable rotation-trigger acknowledgement',
    () => batchStatus(cookie, finalRotationBatchId),
    (row) => row?.status === 'projected',
  )

  const rotated = await waitFor(
    'server write-head rotation', currentRow,
    (row) => Boolean(row && row.document_id !== initial.document_id),
  )
  const h2Url = rotated.segment_url
  const offlineBatchId = `gate-offline-${randomUUID()}`
  for (let index = 0; index < mutationCount; index += 1) {
    offlineHandle.change((doc) => {
      const object = doc.objects[entityId]
      object.properties.offlineCounter = index
      if (index === mutationCount - 1) {
        object.description = 'offline-conflicting-value'
        doc.writeBatchIds ??= []
        doc.writeBatchIds.push(offlineBatchId)
      }
    })
  }

  const handoff = await handoffWorkspace(cookie)
  const convergenceStart = performance.now()
  offline.adapter.connect(offline.adapter.peerId, offline.adapter.peerMetadata)
  const terminal = await waitFor(
    'terminal forwarded acknowledgement',
    () => batchStatus(cookie, offlineBatchId),
    (row) => ['forwarded', 'conflict'].includes(row?.status),
    60_000,
  )
  const convergenceMs = Math.round(performance.now() - convergenceStart)

  const observer = peer(cookie, [h2Url])
  peers.push(observer)
  const currentHandle = await readyHandle(observer, h2Url)
  const projected = await waitFor(
    'forwarded current-head value',
    () => currentHandle.doc()?.objects?.[entityId],
    (object) => object?.properties?.offlineCounter === mutationCount - 1
      && object?.properties?.onlineMarker === onlineMarker
      && object?.description === 'online-current-value',
    30_000,
  )
  const conflict = (await db.query(
    `SELECT conflict_paths, status FROM read_model_overlay_conflicts
     WHERE landscape_id = $1 AND version_id = $2 AND collection = 'object'
       AND entity_id = $3 AND historical_document_id = $4
       AND current_document_id = $5 AND status = 'open'`,
    [landscapeId, versionId, entityId, initial.document_id, rotated.document_id],
  )).rows[0]

  const result = {
    test: 'overlay-offline-rotation-gate',
    mutationCount,
    oldDocumentId: initial.document_id,
    currentDocumentId: rotated.document_id,
    terminalStatus: terminal.status,
    convergenceMs,
    convergenceBudgetMs,
    withinBudget: convergenceMs <= convergenceBudgetMs,
    finalOfflineCounter: projected.properties.offlineCounter,
    onlineMarkerPreserved: projected.properties.onlineMarker === onlineMarker,
    currentConflictValuePreserved: projected.description === 'online-current-value',
    conflictPaths: conflict?.conflict_paths ?? [],
    conflictRecorded: conflict?.status === 'open' && conflict.conflict_paths?.includes('description'),
    handoff,
  }
  console.log(JSON.stringify(result))
  if (!result.withinBudget
    || result.terminalStatus !== 'conflict'
    || !result.onlineMarkerPreserved
    || !result.currentConflictValuePreserved
    || !result.conflictRecorded) process.exitCode = 1
} finally {
  await Promise.allSettled(peers.map((peerState) => peerState.repo.shutdown()))
  await db.end()
}
