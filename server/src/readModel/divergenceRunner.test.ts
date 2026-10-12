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

import { describe, expect, it } from 'vitest'

import { runDivergenceCheck } from './divergenceRunner.js'

const workspace = { landscapeId: 'L', versionId: 'V' }
const noSleep = async () => {}

/** Minimal Pool stand-in: answers the three queries the runner issues. */
function fakePool(options: {
  objects?: string[]
  connections?: string[]
  groups?: string[]
  diagrams?: string[]
  flows?: string[]
  generations: Array<number | null>
}) {
  let generationCall = 0
  const rowsFor = (ids: string[] | undefined) => ({ rows: (ids ?? []).map((id) => ({ id })) })
  return {
    query: async (sql: string) => {
      if (sql.includes('read_model_projection_state')) {
        const value = options.generations[Math.min(generationCall++, options.generations.length - 1)]
        return { rows: value === null ? [] : [{ projected_generation: String(value) }] }
      }
      if (sql.includes('ro_connection_flows')) return rowsFor(options.flows)
      if (sql.includes('ro_objects')) return rowsFor(options.objects)
      if (sql.includes('ro_connections')) return rowsFor(options.connections)
      if (sql.includes('ro_groups')) return rowsFor(options.groups)
      if (sql.includes('ro_diagrams')) return rowsFor(options.diagrams)
      throw new Error(`unexpected query: ${sql}`)
    },
  } as never
}

const inventory = (over: Partial<Record<'objects' | 'connections' | 'groups' | 'diagrams' | 'flows', string[]>> = {}) => ({
  objects: [], connections: [], groups: [], diagrams: [], flows: [], ...over,
})

describe('runDivergenceCheck', () => {
  it('reports clean when both sides hold the same ids', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: ['a'], connections: ['c'], generations: [5, 5] }),
      workspace,
      loadCrdtEntities: async () => inventory({ objects: ['a'], connections: ['c'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('clean')
    expect(result.counts.object).toEqual({ crdt: 1, readModel: 1 })
    expect(result.counts.connection).toEqual({ crdt: 1, readModel: 1 })
  })

  it('confirms divergence when an object never reaches the read model', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: [], connections: [], generations: [5, 5] }),
      workspace,
      loadCrdtEntities: async () => inventory({ objects: ['orphan'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('diverged')
    expect(result.confirmed).toEqual([{ kind: 'missing-in-read-model', entity: 'object', id: 'orphan' }])
  })

  it('confirms a read-model row that outlived its CRDT entity', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: ['ghost'], connections: [], generations: [5, 5] }),
      workspace,
      loadCrdtEntities: async () => inventory(),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('diverged')
    expect(result.confirmed[0]!.kind).toBe('missing-in-crdt')
  })

  it('is inconclusive when the projector advanced between the two passes', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: [], connections: [], generations: [5, 6] }),
      workspace,
      loadCrdtEntities: async () => inventory({ objects: ['a'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('inconclusive')
    expect(result.reason).toMatch(/advanced/)
  })

  it('records an ERROR outcome instead of letting a broken checker read as healthy', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: [], connections: [], generations: [1, 1] }),
      workspace,
      loadCrdtEntities: async () => { throw new Error('repo unavailable') },
      sleep: noSleep,
    })
    expect(result.outcome).toBe('error')
    expect(result.reason).toMatch(/repo unavailable/)
  })

  it('compares the CRDT side TWICE, so a difference that heals is not reported', async () => {
    let call = 0
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: ['a'], connections: [], generations: [3, 3] }),
      workspace,
      // First pass sees an extra object; second pass agrees with the read model.
      loadCrdtEntities: async () => (call++ === 0
        ? inventory({ objects: ['a', 'inflight'] })
        : inventory({ objects: ['a'] })),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('clean')
    expect(result.healed).toBe(1)
  })
})

describe('the kinds the first version could not see', () => {
  const inv = (over: Partial<Record<'objects' | 'connections' | 'groups' | 'diagrams' | 'flows', string[]>> = {}) => ({
    objects: [], connections: [], groups: [], diagrams: [], flows: [], ...over,
  })

  it('detects every flow row being deleted — the case the first version missed entirely', async () => {
    // Comparing only ro_objects and ro_connections would let a wiped
    // ro_connection_flows go undetected.
    const result = await runDivergenceCheck({
      pool: fakePool({ flows: [], generations: [4, 4] }),
      workspace,
      loadCrdtEntities: async () => inv({ flows: ['d1:f1', 'd1:f2'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('diverged')
    expect(result.confirmed.map((c) => c.id).sort()).toEqual(['d1:f1', 'd1:f2'])
    expect(result.confirmed.every((c) => c.entity === 'flow')).toBe(true)
  })

  it('detects a missing group', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ groups: [], generations: [1, 1] }),
      workspace,
      loadCrdtEntities: async () => inv({ groups: ['g1'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('diverged')
    expect(result.confirmed[0]!.entity).toBe('group')
  })

  it('detects a diagram the read model never received', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ diagrams: [], generations: [1, 1] }),
      workspace,
      loadCrdtEntities: async () => inv({ diagrams: ['d9'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('diverged')
    expect(result.confirmed[0]!.entity).toBe('diagram')
  })

  it('reports per-kind counts so a report says WHICH kind drifted', async () => {
    const result = await runDivergenceCheck({
      pool: fakePool({ objects: ['a'], flows: ['d:f'], generations: [1, 1] }),
      workspace,
      loadCrdtEntities: async () => inv({ objects: ['a'], flows: ['d:f'] }),
      sleep: noSleep,
    })
    expect(result.outcome).toBe('clean')
    expect(result.counts.flow).toEqual({ crdt: 1, readModel: 1 })
    expect(result.counts.group).toEqual({ crdt: 0, readModel: 0 })
  })
})
