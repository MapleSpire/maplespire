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
import { describe, expect, it } from 'vitest'
import { runColdApiChecks, type ColdApiExpectation } from './coldApi.js'

const ICON = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
const ICON_SHA = createHash('sha256').update(ICON).digest('hex')
const ICON_PATH = `/assets/technologies/${ICON_SHA}.svg`

const EXPECTATION: ColdApiExpectation = {
  selection: {
    projectionGroups: 1, projectionObjects: 12,
    eligibleProjectionGroups: 1, eligibleProjectionObjects: 12,
    candidateWorkspaces: 1, excludedProjectionGroups: 0, excludedProjectionObjects: 0,
    excluded: [], exclusionsTruncated: false,
    selected: { landscapeId: 'landscape-1', versionId: 'version-1', queryVersionId: 'version-1', objects: 12 },
  },
  workspace: {
    landscapeId: 'landscape-1',
    versionId: 'version-1',
    queryVersionId: 'version-1',
    objects: 12,
    connections: 7,
    diagrams: 3,
    dependencyFocusId: 'object-a',
    assetPath: ICON_PATH,
  },
}

type Reply = { status: number; body: string; bytes?: Buffer }

/** Serves canned replies by path prefix and records what was asked. */
function fakeServer(replies: Record<string, Reply | Reply[]>) {
  const requested: string[] = []
  const queues = new Map<string, Reply[]>(
    Object.entries(replies).map(([path, reply]) => [path, Array.isArray(reply) ? [...reply] : [reply]]),
  )
  const fetchImpl = async (url: string) => {
    const path = new URL(url).pathname
    requested.push(path)
    const queue = queues.get(path)
    if (!queue || queue.length === 0) return { status: 404, text: async () => '{}' }
    const reply = queue.length > 1 ? queue.shift()! : queue[0]!
    return {
      status: reply.status,
      text: async () => reply.body,
      arrayBuffer: async () => {
        const buffer = reply.bytes ?? Buffer.from(reply.body)
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      },
    }
  }
  return { fetchImpl, requested }
}

const HEALTHY = {
  '/api/health': { status: 200, body: JSON.stringify({ status: 'ok' }) },
  // Nested under `checks`, matching /api/ready. A flat fixture here would have
  // let the top-level read that shipped and failed on the stack pass in CI.
  '/api/ready': { status: 200, body: JSON.stringify({ status: 'ready', checks: { database: true, readModel: true } }) },
  '/api/model/page-objects': { status: 200, body: JSON.stringify({ objects: [{ id: 'a' }] }) },
  '/api/model/connections/page': { status: 200, body: JSON.stringify({ items: [{ id: 'c' }] }) },
  '/api/model/dependencies/page': { status: 200, body: JSON.stringify({ items: [{ peerId: 'b' }] }) },
  '/api/model/diagrams/page': { status: 200, body: JSON.stringify({ total: 3, items: [] }) },
  [ICON_PATH]: { status: 200, body: '', bytes: ICON },
}

describe('cold API verification', () => {
  it('passes when every read-model page answers with content', async () => {
    const server = fakeServer(HEALTHY)
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      fetchImpl: server.fetchImpl,
    })
    expect(outcome.outcome).toBe('passed')
    expect(outcome.selection).toEqual(EXPECTATION.selection)
    expect(server.requested).toEqual([
      '/api/health',
      '/api/ready',
      '/api/model/page-objects',
      '/api/model/connections/page',
      '/api/model/dependencies/page',
      '/api/model/diagrams/page',
      ICON_PATH,
    ])
  })

  it('retries a warming projector, then passes', async () => {
    // ensureWorkspace answers 503 until the workspace has a live projector, which
    // on a cold process is the normal first seconds. Failing there would measure
    // boot latency instead of the restore.
    const server = fakeServer({
      ...HEALTHY,
      '/api/model/page-objects': [
        { status: 503, body: '{"error":"projector_warming"}' },
        { status: 200, body: JSON.stringify({ objects: [{ id: 'a' }] }) },
      ],
    })
    let clock = 0
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      fetchImpl: server.fetchImpl,
      deadlineMs: 60_000,
      now: () => (clock += 10),
    })
    expect(outcome.outcome).toBe('passed')
    expect(server.requested.filter((path) => path === '/api/model/page-objects')).toHaveLength(2)
  })

  it('does not retry a 4xx — that is an answer, not a warm-up', async () => {
    const server = fakeServer({
      ...HEALTHY,
      '/api/model/dependencies/page': { status: 400, body: '{"error":"focus is required"}' },
    })
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      fetchImpl: server.fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(server.requested.filter((path) => path === '/api/model/dependencies/page')).toHaveLength(1)
    expect(outcome.checks.find((check) => check.name === 'dependencies')?.detail).toContain('HTTP 400')
  })

  it('fails a 200 that carries an empty page over a workspace that has rows', async () => {
    // The failure this whole check exists to catch: a restore that serves, but
    // serves nothing. HTTP 200 alone would have called it healthy.
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      fetchImpl: fakeServer({
        ...HEALTHY,
        '/api/model/page-objects': { status: 200, body: JSON.stringify({ objects: [] }) },
      }).fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.checks.find((check) => check.name === 'model-objects')?.detail)
      .toContain('the page returned 0')
    expect(outcome.selection).toEqual(EXPECTATION.selection)
  })

  it('fails when the projector never became ready', async () => {
    let clock = 0
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      deadlineMs: 5,
      now: () => (clock += 10),
      fetchImpl: fakeServer({
        ...HEALTHY,
        '/api/ready': { status: 200, body: JSON.stringify({ status: 'ready', checks: { database: true, readModel: false } }) },
      }).fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.checks.find((check) => check.name === 'ready')?.detail)
      .toContain('read-model projector never became ready')
  })

  it('fails when the restored volume serves the wrong bytes under a content-addressed name', async () => {
    // A 200 is not the assertion. This is the failure mode a filename-only check
    // cannot see: the blob is present, the right size, and not the image.
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      fetchImpl: fakeServer({
        ...HEALTHY,
        [ICON_PATH]: { status: 200, body: '', bytes: Buffer.from('<svg id="wrong"/>') },
      }).fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.checks.find((check) => check.name === 'technology-asset')?.detail)
      .toContain('the URL claims')
  })

  it('fails when the restored volume does not serve an archived icon at all', async () => {
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      fetchImpl: fakeServer({ ...HEALTHY, [ICON_PATH]: { status: 404, body: 'Not Found' } }).fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.checks.find((check) => check.name === 'technology-asset')?.detail)
      .toContain('HTTP 404')
  })

  it('fails a restore with nothing to serve instead of reporting it skipped', async () => {
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: null,
      fetchImpl: fakeServer(HEALTHY).fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.checks.at(-1)?.name).toBe('workspace')
    expect(outcome.selection).toBeNull()
  })

  it('keeps the exclusion census when every projection was excluded', async () => {
    const selection = {
      projectionGroups: 1, projectionObjects: 104,
      eligibleProjectionGroups: 0, eligibleProjectionObjects: 0,
      candidateWorkspaces: 0, excludedProjectionGroups: 1, excludedProjectionObjects: 104,
      excluded: [{ landscapeId: 'deleted', versionId: 'old', objects: 104,
        status: null, reason: 'missing_landscape' as const }],
      exclusionsTruncated: false, selected: null,
    }
    const server = fakeServer(HEALTHY)
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: { workspace: null, selection },
      fetchImpl: server.fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.selection).toEqual(selection)
    expect(server.requested).toEqual(['/api/health', '/api/ready'])
  })

  it('gives up at the deadline rather than retrying a wedged endpoint forever', async () => {
    let clock = 0
    const outcome = await runColdApiChecks({
      baseUrl: 'http://127.0.0.1:1234',
      expectation: EXPECTATION,
      deadlineMs: 5,
      now: () => (clock += 10),
      fetchImpl: fakeServer({
        ...HEALTHY,
        '/api/model/connections/page': { status: 503, body: '{}' },
      }).fetchImpl,
    })
    expect(outcome.outcome).toBe('failed')
    expect(outcome.checks.find((check) => check.name === 'model-connections')?.detail)
      .toContain('gave up after the deadline')
  })
})
