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

// Shared helpers for the QA performance harness. These scripts run as HEADLESS
// Automerge peers (Node 22 has a global WebSocket) connecting to the running dev
// server, so they exercise the real sync path (client <-> server <-> client) and
// real Postgres persistence — just without the browser UI.
import { Repo } from '@automerge/automerge-repo'
import { WebSocketClientAdapter } from '@automerge/automerge-repo-network-websocket'
import { AuthenticatedWebSocketClientAdapter } from './authenticatedWebSocketAdapter.mjs'
import * as A from '@automerge/automerge'
import { performance } from 'node:perf_hooks'
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const QA_LANDSCAPE_ID = process.env.QA_LANDSCAPE_ID
const QA_VERSION_ID = process.env.QA_VERSION_ID
const WS_BASE = process.env.QA_WS ?? 'ws://localhost:3001/automerge'
const WS_SEPARATOR = WS_BASE.includes('?') ? '&' : '?'
export const WS = QA_LANDSCAPE_ID && QA_VERSION_ID && !WS_BASE.includes('landscapeId=') && !WS_BASE.includes('versionId=')
  ? `${WS_BASE}${WS_SEPARATOR}landscapeId=${encodeURIComponent(QA_LANDSCAPE_ID)}&versionId=${encodeURIComponent(QA_VERSION_ID)}`
  : WS_BASE
export const API = process.env.QA_API ?? 'http://localhost:3001'
export const PG = process.env.QA_PG ?? 'postgres://maplespire:maplespire@localhost:5432/maplespire'
export const SESSION_COOKIE = process.env.QA_SESSION_COOKIE ?? ''

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT_FILE = resolve(HERE, 'last-root.txt')

/** A fresh in-memory headless peer (no local storage — every QA client is "cold"). */
function requestedDocumentIds(urls) {
  return new Set(urls.map((url) => url.replace(/^automerge:/, '').split('?')[0]))
}

/**
 * Mirror the browser's ActiveDocumentShare policy for an explicit cold request.
 * Selective-sync servers do not proactively announce non-core documents; the
 * requesting peer must announce the exact document it intends to open.
 */
export function requestedDocumentShare(urls) {
  const requested = requestedDocumentIds(urls)
  return {
    announce: async (_peerId, documentId) => documentId !== undefined && requested.has(documentId),
    // A focused cold peer must not accept workspace control documents merely
    // because the server pins them. Accepting an unrequested ModelMeta leaves
    // Repo.shutdown() waiting for a document the gate never intends to hydrate.
    access: async (_peerId, documentId) => documentId !== undefined && requested.has(documentId),
  }
}

export function newRepo(requestedUrls = []) {
  const adapter = SESSION_COOKIE
    ? new AuthenticatedWebSocketClientAdapter(WS, SESSION_COOKIE)
    : new WebSocketClientAdapter(WS)
  const repo = new Repo({
    network: [adapter],
    ...(requestedUrls.length > 0 ? { shareConfig: requestedDocumentShare(requestedUrls) } : {}),
  })
  Object.defineProperty(repo, '__qaNetworkAdapter', { value: adapter })
  return repo
}

/** Parse `--key value` / `--flag` CLI args into an object with numeric coercion. */
export function args(defaults = {}) {
  const out = { ...defaults }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      const k = a[i].slice(2)
      const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
      out[k] = typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
    }
  }
  return out
}

export function saveRootUrl(url) {
  writeFileSync(ROOT_FILE, url, 'utf8')
}
export function loadRootUrl(fallback) {
  if (fallback) return fallback
  if (existsSync(ROOT_FILE)) return readFileSync(ROOT_FILE, 'utf8').trim()
  throw new Error('no --root given and qa/last-root.txt missing; run seed.mjs first')
}

export function emptyRoot() {
  return {
    model: { objects: {}, connections: {}, groups: {}, domains: {}, tags: {}, decisionRecords: {} },
    diagrams: {},
  }
}

export function makeObject(id, over = {}) {
  return {
    id,
    type: 'app',
    name: id,
    position: { x: (Math.imul(hash(id), 13) % 4000) / 1, y: (Math.imul(hash(id), 7) % 3000) / 1 },
    size: { width: 160, height: 100 },
    tags: [],
    scope: 'internal',
    status: 'live',
    properties: {},
    ...over,
  }
}
export function makeConnection(id, fromId, toId) {
  return { id, fromId, toId, type: 'solid' }
}
export function emptyDiagramDoc(name, type = 'context') {
  return { name, type, objectIds: [], connectionIds: [], groupIds: [], layouts: {}, comments: {}, flows: {}, checkpoints: [] }
}

// Deterministic-ish hash so positions vary without Math.random (kept reproducible).
function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Serialized size of a handle's doc in bytes (snapshot) — a good size proxy. */
export function docBytes(handle) {
  const doc = handle.doc()
  return doc ? A.save(doc).length : 0
}
/** Number of changes (≈ versions) in a handle's doc. */
export function changeCount(handle) {
  const doc = handle.doc()
  return doc ? A.getAllChanges(doc).length : 0
}
export function mem() {
  const m = process.memoryUsage()
  return { rssMB: +(m.rss / 1e6).toFixed(1), heapMB: +(m.heapUsed / 1e6).toFixed(1) }
}
export const t = () => performance.now()
export const ms = (start) => Math.round(performance.now() - start)

/** Structured result line — agents parse the last JSON line of stdout. */
export function emit(obj) {
  console.log('QARESULT ' + JSON.stringify(obj))
}
export function log(...a) {
  console.error(...a) // human progress on stderr; keep stdout clean for QARESULT
}

/**
 * Read the platform-admin transport snapshot when credentials are available.
 * The convergence test remains useful without it: a missing/unauthorized
 * snapshot is reported as null instead of weakening the CRDT assertions.
 */
export async function fetchAutomergeStats() {
  try {
    const response = await fetch(`${API}/api/automerge/stats`, {
      headers: SESSION_COOKIE ? { Cookie: SESSION_COOKIE } : {},
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      log(`transport stats unavailable: HTTP ${response.status}`)
      return null
    }
    return await response.json()
  } catch (error) {
    log(`transport stats unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

/** Give the repo time to flush all pending syncs to the server, then shut down. */
export async function flushAndClose(repo, settleMs = 4000) {
  await new Promise((r) => setTimeout(r, settleMs))
  try {
    await repo.flush?.()
  } catch {
    /* older repo without flush() — the settle delay covers it */
  }
  repo.__qaNetworkAdapter?.disconnect?.()
  await new Promise((r) => setTimeout(r, 100))
  await repo.shutdown()
}
