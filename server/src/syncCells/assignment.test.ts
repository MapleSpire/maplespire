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
import {
  MAPPING_FINGERPRINT,
  SyncCellTopologyGenerationError,
  partitionProbeOrder,
  syncCellPartitionConfig,
  workspacePartition,
} from './assignment.js'

describe('syncCellPartitionConfig', () => {
  it('T-13d: reads, trims and sorts the fleet reservation without changing either generation', () => {
    const env = { SYNC_CELL_PARTITION_COUNT: '8', SYNC_CELL_MULTI_PARTITION: 'on' }
    const baseline = syncCellPartitionConfig(env)
    for (const raw of [undefined, '', '   ']) {
      expect(syncCellPartitionConfig({ ...env, SYNC_CELL_RESERVED_PARTITIONS: raw }).reservedPartitions).toEqual([])
    }
    const configured = syncCellPartitionConfig({ ...env, SYNC_CELL_RESERVED_PARTITIONS: ' 7, 0 , 3 ' })
    expect(configured.reservedPartitions).toEqual([0, 3, 7])
    expect(configured.configuredGeneration).toBe(baseline.configuredGeneration)
    expect(configured.effectiveGeneration).toBe(baseline.effectiveGeneration)
    expect(configured.topologyGeneration).toBe(baseline.topologyGeneration)
    expect(MAPPING_FINGERPRINT).toBe('ce1461953e2b8ac2')
  })

  it.each(['-1', '+1', '01', '1.0', '1e0', '0x1', 'NaN', 'Infinity', '1 2', '8', '1024',
    '1,1', '1, 1', ',1', '1,', '1,,2', '1, ,2'])('T-13d: refuses malformed reservation env %j', raw => {
    expect(() => syncCellPartitionConfig({
      SYNC_CELL_PARTITION_COUNT: '8', SYNC_CELL_MULTI_PARTITION: 'on', SYNC_CELL_RESERVED_PARTITIONS: raw,
    })).toThrow()
  })

  it('T-13d: permits the full reserved set, including N=1, without inventing a pool slot', () => {
    for (const count of [1, 1024]) {
      const all = Array.from({ length: count }, (_, index) => index)
      const config = syncCellPartitionConfig({
        SYNC_CELL_PARTITION_COUNT: String(count), SYNC_CELL_MULTI_PARTITION: 'on',
        SYNC_CELL_RESERVED_PARTITIONS: all.join(','),
      })
      expect(config.reservedPartitions).toEqual(all)
      expect(partitionProbeOrder('cell-a', count, config.reservedPartitions, 'pool')).toEqual([])
    }
  })

  it('T-10h1: defaults to shadow and carries an explicit placement mode without changing generation', () => {
    const absent = syncCellPartitionConfig({})
    expect(absent).toMatchObject({ placementMode: 'shadow' })
    for (const placementMode of ['shadow', 'placed']) {
      const config = syncCellPartitionConfig({ SYNC_CELL_PLACEMENT_MODE: placementMode })
      expect(config).toMatchObject({ placementMode })
      expect(config.configuredGeneration).toBe(absent.configuredGeneration)
      expect(config.effectiveGeneration).toBe(absent.effectiveGeneration)
      expect(config.topologyGeneration).toBe(absent.topologyGeneration)
    }
  })

  it('T-10h1: rejects every noncanonical placement-mode spelling instead of silently falling back', () => {
    for (const value of ['', ' ', 'SHADOW', 'PLACED', ' shadow', 'placed ', 'hash', 'off', 'true']) {
      expect(() => syncCellPartitionConfig({ SYNC_CELL_PLACEMENT_MODE: value }), JSON.stringify(value))
        .toThrow('SYNC_CELL_PLACEMENT_MODE must be shadow or placed')
    }
  })

  it('defaults to one partition and rejects divergent malformed topology', () => {
    expect(syncCellPartitionConfig({})).toEqual({ partitionCount: 1, placementMode: 'shadow', reservedPartitions: [], configuredGeneration: 'v1', effectiveGeneration: 'v1.ce1461953e2b8ac2', topologyGeneration: 'v1.ce1461953e2b8ac2' })
    expect(syncCellPartitionConfig({
      SYNC_CELL_PARTITION_COUNT: '8',
      SYNC_CELL_MULTI_PARTITION: 'on',
      SYNC_CELL_TOPOLOGY_GENERATION: 'Scale-2026-07',
    })).toEqual({ partitionCount: 8, placementMode: 'shadow', reservedPartitions: [], configuredGeneration: 'scale-2026-07', effectiveGeneration: 'scale-2026-07.ce1461953e2b8ac2', topologyGeneration: 'scale-2026-07.ce1461953e2b8ac2' })
    expect(() => syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '0' })).toThrow('between 1 and')
    expect(() => syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '2.5' })).toThrow('between 1 and')
    expect(() => syncCellPartitionConfig({ SYNC_CELL_TOPOLOGY_GENERATION: '../bad' })).toThrow('safe')
  })

  it('B3g: more than one partition needs SYNC_CELL_MULTI_PARTITION=on, and the error says what is missing', () => {
    // The explicit opt-in prevents an accidental count change on a cell or router.
    expect(() => syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '2' }))
      .toThrow(/SYNC_CELL_MULTI_PARTITION=on/)
    // Name the implemented guards and the coordinated operating procedure.
    expect(() => syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '2' }))
      .toThrow(/B3d2 topology contract.*B3i.*every cell and router.*sync-cell-ownership\.md/)

    // The flag lifts it for an explicitly configured deployment.
    expect(syncCellPartitionConfig({
      NODE_ENV: 'production',
      SYNC_CELL_PARTITION_COUNT: '2',
      SYNC_CELL_MULTI_PARTITION: ' ON ',
    })).toEqual({ partitionCount: 2, placementMode: 'shadow', reservedPartitions: [], configuredGeneration: 'v1', effectiveGeneration: 'v1.ce1461953e2b8ac2', topologyGeneration: 'v1.ce1461953e2b8ac2' })

    // …and only that value. A near miss is not an opt-in: the same shape as
    // `COMPACTION_QUEUE`, and for the same reason — a half-typed flag must not
    // enable multiple partitions accidentally.
    for (const value of ['', 'true', '1', 'once', 'onn', 'off']) {
      expect(
        () => syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '2', SYNC_CELL_MULTI_PARTITION: value }),
        `SYNC_CELL_MULTI_PARTITION=${JSON.stringify(value)} must not lift the refusal`,
      ).toThrow(/SYNC_CELL_MULTI_PARTITION=on/)
    }

    // ONE partition is unaffected with or without the flag — the refusal must
    // not become a new required variable for every shipped deployment.
    expect(syncCellPartitionConfig({ SYNC_CELL_PARTITION_COUNT: '1' }))
      .toEqual({ partitionCount: 1, placementMode: 'shadow', reservedPartitions: [], configuredGeneration: 'v1', effectiveGeneration: 'v1.ce1461953e2b8ac2', topologyGeneration: 'v1.ce1461953e2b8ac2' })
  })

  it('B3d2 signs both shipped spellings without an operator fingerprint override', () => {
    expect(syncCellPartitionConfig({ SYNC_CELL_TOPOLOGY_GENERATION: ' Maplespire-V1 ' }))
      .toMatchObject({ configuredGeneration: 'maplespire-v1', effectiveGeneration: 'maplespire-v1.ce1461953e2b8ac2', topologyGeneration: 'maplespire-v1.ce1461953e2b8ac2' })
    expect(syncCellPartitionConfig({ SYNC_CELL_MAPPING_FINGERPRINT: '1111111111111111' }).effectiveGeneration)
      .toBe('v1.ce1461953e2b8ac2')
    expect(syncCellPartitionConfig({}, '1111111111111111').effectiveGeneration).toBe('v1.1111111111111111')
    expect(syncCellPartitionConfig({}, '2222222222222222').effectiveGeneration).toBe('v1.2222222222222222')
  })

  it('B3d2 validates the configured half before composition and refuses overflow by name', () => {
    const check = (generation: string, fingerprint: string, reason: string) => {
      expect(() => syncCellPartitionConfig({ SYNC_CELL_TOPOLOGY_GENERATION: generation }, fingerprint))
        .toThrow(SyncCellTopologyGenerationError)
      try { syncCellPartitionConfig({ SYNC_CELL_TOPOLOGY_GENERATION: generation }, fingerprint) }
      catch (error) { expect(error).toMatchObject({ code: 'sync_cell_topology_generation_invalid', reason }) }
    }
    check('../bad', 'invalid', 'configured-invalid')
    check('v1', 'ABCDEF0123456789', 'fingerprint-invalid')
    check('v1', 'abcdef', 'fingerprint-invalid')
    const accepted = syncCellPartitionConfig({ SYNC_CELL_TOPOLOGY_GENERATION: 'g'.repeat(47) })
    expect(accepted.effectiveGeneration).toHaveLength(64)
    expect(accepted.effectiveGeneration).toBe('g'.repeat(47) + '.ce1461953e2b8ac2')
    check('g'.repeat(48), MAPPING_FINGERPRINT, 'effective-too-long')
    check('g'.repeat(65), MAPPING_FINGERPRINT, 'configured-invalid')
  })
})

// Literal outputs captured from an earlier implementation, not another
// spelling of the current algorithm, so a behaviour change cannot hide.
// This probe-order corpus is separate from the workspace mapping fingerprint.
const GOLDEN_PROBE_ORDERS = [
  { cellId: 'cell-a', count: 1, order: [0] },
  { cellId: 'cell-a', count: 2, order: [0, 1] },
  { cellId: 'cell-a', count: 3, order: [0, 2, 1] },
  { cellId: 'cell-a', count: 8, order: [4, 3, 7, 5, 6, 0, 2, 1] },
  { cellId: 'cell-a', count: 17, order: [4, 11, 16, 3, 10, 9, 7, 13, 5, 6, 0, 15, 2, 1, 8, 12, 14] },
  { cellId: 'cell-b', count: 1, order: [0] },
  { cellId: 'cell-b', count: 2, order: [0, 1] },
  { cellId: 'cell-b', count: 3, order: [0, 1, 2] },
  { cellId: 'cell-b', count: 8, order: [7, 3, 0, 1, 2, 5, 4, 6] },
  { cellId: 'cell-b', count: 17, order: [13, 7, 16, 3, 0, 1, 10, 2, 5, 4, 9, 11, 8, 14, 6, 15, 12] },
  { cellId: 'cell-reserve', count: 1, order: [0] },
  { cellId: 'cell-reserve', count: 2, order: [1, 0] },
  { cellId: 'cell-reserve', count: 3, order: [2, 1, 0] },
  { cellId: 'cell-reserve', count: 8, order: [7, 2, 3, 6, 5, 1, 0, 4] },
  { cellId: 'cell-reserve', count: 17, order: [7, 16, 2, 13, 10, 15, 3, 6, 5, 14, 1, 0, 12, 11, 8, 4, 9] },
] as const

describe('T-13d reserved partition probe order', () => {
  it.each(GOLDEN_PROBE_ORDERS)('pins the empty pool bytes for $cellId at N=$count', ({ cellId, count, order }) => {
    expect(JSON.stringify(partitionProbeOrder(cellId, count, [], 'pool'))).toBe(JSON.stringify(order))
    expect(partitionProbeOrder(cellId, count)).toEqual(order)
  })

  it('a reserved role probes only its own member for every supported count', () => {
    for (let count = 1; count <= 1024; count += 1) {
      const reserved = [...new Set([0, count - 1])]
      for (const index of reserved) {
        expect(partitionProbeOrder('cell-reserve', count, reserved, `reserved:${index}`), `N=${count}, k=${index}`)
          .toEqual([index])
      }
    }
  })

  it('pool excludes every reserved member at every position for all 1024 counts', () => {
    for (let count = 1; count <= 1024; count += 1) {
      const all = Array.from({ length: count }, (_, index) => index)
      const reserved = all.filter(index => index % 2 === 0 || index === count - 1)
      const blocked = new Set(reserved)
      const allowed = all.filter(index => !blocked.has(index))
      const order = partitionProbeOrder('cell-a', count, reserved, 'pool')
      // Exact complement also catches lost or duplicate ordinary slots. A
      // vacuous empty result cannot satisfy this assertion when any are free.
      expect([...order].sort((a, b) => a - b), `complement N=${count}`).toEqual(allowed)
      expect(order.some(index => blocked.has(index)), `reserved probe N=${count}`).toBe(false)
      expect(order, `stable relative order N=${count}`)
        .toEqual(partitionProbeOrder('cell-a', count).filter(index => !blocked.has(index)))
    }
  }, 60_000)

  it('the pool never falls back when all slots are reserved', () => {
    for (let count = 1; count <= 1024; count += 1) {
      expect(partitionProbeOrder('cell-b', count, Array.from({ length: count }, (_, index) => index), 'pool'))
        .toEqual([])
    }
  })

  it('does not mutate the fleet reservation supplied to either role', () => {
    const reserved = Object.freeze([7, 1, 3])
    expect(partitionProbeOrder('cell-a', 8, reserved, 'pool')).toEqual([4, 5, 6, 0, 2])
    expect(partitionProbeOrder('cell-b', 8, reserved, 'reserved:3')).toEqual([3])
    expect(reserved).toEqual([7, 1, 3])
  })
})

// The workspace mapping corpus, recorded from a known-good baseline.
// Rows are indices 0..63 of the existing landscape-${index}/version-${index % 17}
// generator. Columns are the explicit partition counts below. These literals,
// compared per input, are the primary oracle; never regenerate them during CI.
const GOLDEN_PARTITION_COUNTS = [1, 2, 3, 4, 5, 16, 17, 1024] as const
const GOLDEN_PARTITIONS = [
  [0, 1, 1, 1, 1, 9, 9, 9],
  [0, 0, 0, 0, 4, 13, 13, 837],
  [0, 0, 0, 0, 4, 11, 11, 133],
  [0, 1, 1, 3, 3, 9, 9, 974],
  [0, 0, 0, 0, 4, 5, 5, 154],
  [0, 0, 2, 2, 2, 2, 2, 743],
  [0, 1, 1, 1, 4, 4, 4, 397],
  [0, 0, 2, 2, 4, 12, 12, 12],
  [0, 0, 0, 3, 3, 6, 6, 133],
  [0, 0, 0, 0, 0, 0, 0, 540],
  [0, 0, 2, 2, 4, 4, 4, 916],
  [0, 0, 2, 2, 2, 8, 8, 133],
  [0, 1, 1, 3, 3, 7, 7, 415],
  [0, 0, 2, 3, 3, 3, 3, 961],
  [0, 0, 0, 0, 0, 0, 0, 31],
  [0, 1, 1, 3, 3, 10, 10, 491],
  [0, 0, 0, 0, 4, 5, 5, 422],
  [0, 1, 1, 1, 1, 9, 9, 825],
  [0, 0, 2, 2, 2, 11, 11, 429],
  [0, 0, 0, 0, 0, 0, 0, 369],
  [0, 1, 1, 1, 1, 1, 1, 473],
  [0, 1, 1, 3, 3, 3, 3, 818],
  [0, 1, 1, 1, 1, 10, 10, 145],
  [0, 0, 2, 2, 2, 8, 8, 177],
  [0, 0, 0, 0, 4, 14, 14, 840],
  [0, 0, 0, 0, 0, 6, 6, 953],
  [0, 1, 1, 1, 1, 10, 10, 912],
  [0, 0, 2, 2, 2, 2, 2, 227],
  [0, 0, 0, 0, 0, 13, 13, 160],
  [0, 0, 2, 2, 2, 10, 10, 148],
  [0, 0, 0, 0, 4, 15, 15, 400],
  [0, 1, 2, 3, 3, 10, 10, 62],
  [0, 0, 0, 0, 0, 9, 9, 879],
  [0, 1, 1, 1, 1, 13, 13, 391],
  [0, 0, 2, 2, 2, 13, 13, 942],
  [0, 1, 2, 3, 3, 14, 14, 446],
  [0, 0, 2, 2, 2, 8, 8, 622],
  [0, 1, 1, 1, 1, 1, 1, 95],
  [0, 1, 1, 1, 1, 15, 15, 391],
  [0, 1, 1, 1, 1, 1, 1, 555],
  [0, 0, 0, 3, 3, 3, 3, 589],
  [0, 0, 0, 3, 3, 14, 16, 849],
  [0, 1, 2, 2, 2, 10, 10, 1006],
  [0, 1, 1, 1, 1, 10, 10, 651],
  [0, 1, 1, 1, 1, 7, 7, 738],
  [0, 1, 2, 2, 2, 2, 2, 54],
  [0, 0, 2, 3, 4, 5, 5, 725],
  [0, 0, 0, 0, 0, 6, 6, 21],
  [0, 0, 0, 0, 0, 7, 7, 998],
  [0, 0, 0, 0, 0, 0, 0, 154],
  [0, 1, 1, 1, 1, 1, 16, 933],
  [0, 0, 0, 0, 0, 7, 7, 486],
  [0, 0, 0, 0, 0, 9, 9, 243],
  [0, 0, 2, 2, 2, 8, 8, 189],
  [0, 1, 2, 2, 2, 6, 6, 194],
  [0, 0, 0, 0, 0, 8, 8, 99],
  [0, 0, 0, 0, 0, 0, 0, 973],
  [0, 1, 1, 1, 4, 4, 4, 403],
  [0, 1, 1, 1, 1, 9, 9, 946],
  [0, 1, 1, 1, 1, 7, 7, 362],
  [0, 0, 2, 2, 2, 15, 15, 29],
  [0, 1, 1, 1, 1, 15, 15, 447],
  [0, 1, 1, 1, 1, 13, 13, 299],
  [0, 0, 0, 0, 0, 0, 0, 727],
] as const

describe('workspacePartition', () => {
  it.each(GOLDEN_PARTITIONS.map((partitions, index) => ({ index, partitions })))(
    'B3b: pins the output table for workspace index $index',
    ({ index, partitions }) => {
      const workspace = { landscapeId: `landscape-${index}`, versionId: `version-${index % 17}` }
      expect(partitions).toHaveLength(8)
      GOLDEN_PARTITION_COUNTS.forEach((count, column) => {
        expect(workspacePartition(workspace, count), `${workspace.landscapeId}/${workspace.versionId} at ${count} partitions`)
          .toBe(partitions[column])
      })
    },
  )

  it('B3b: pins the corpus dimensions and its cumulative mapping fingerprint', () => {
    expect(GOLDEN_PARTITIONS).toHaveLength(64)
    expect(GOLDEN_PARTITION_COUNTS).toEqual([1, 2, 3, 4, 5, 16, 17, 1024])
    // Ordered JSON array: [schema, counts, [[landscapeId, versionId, outputs], ...]].
    // UTF-8, JSON.stringify with no spacing, BOM or final newline; SHA-256 hex,
    // first 16 characters (64 bits). The per-input assertions above remain primary.
    const rows = GOLDEN_PARTITIONS.map((_, index) => {
      const workspace = { landscapeId: `landscape-${index}`, versionId: `version-${index % 17}` }
      return [workspace.landscapeId, workspace.versionId,
        GOLDEN_PARTITION_COUNTS.map(count => workspacePartition(workspace, count))]
    })
    const serialized = JSON.stringify(['maplespire-workspace-mapping/v1', GOLDEN_PARTITION_COUNTS, rows])
    expect(createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16))
      .toBe(MAPPING_FINGERPRINT)
    // This finite corpus is not all possible inputs or a hash of executable code.
    // Editing the algorithm, table and literal together can still pass; that
    // relies on review of those changes. partitionProbeOrder is excluded: cellId -> probe
    // order is a separate question from workspace -> partition; its test is below.
  })

  it('B3d2: effective generation agrees with the fingerprint of the actual mapping corpus', () => {
    const rows = GOLDEN_PARTITIONS.map((_, index) => {
      const workspace = { landscapeId: `landscape-${index}`, versionId: `version-${index % 17}` }
      return [workspace.landscapeId, workspace.versionId,
        GOLDEN_PARTITION_COUNTS.map(count => workspacePartition(workspace, count))]
    })
    const serialized = JSON.stringify(['maplespire-workspace-mapping/v1', GOLDEN_PARTITION_COUNTS, rows])
    const observedFingerprint = createHash('sha256').update(serialized, 'utf8').digest('hex').slice(0, 16)
    // Unlike the separate literal assertion, this becomes red when the mapping
    // changes while the runtime fingerprint remains the old literal.
    expect(syncCellPartitionConfig({}).effectiveGeneration).toBe(`v1.${observedFingerprint}`)
  })

  it('is deterministic, bounded and minimally remaps when one partition is added', () => {
    let moved = 0
    const used = new Set<number>()
    for (let index = 0; index < 2_000; index += 1) {
      const workspace = { landscapeId: `landscape-${index}`, versionId: `version-${index % 17}` }
      const four = workspacePartition(workspace, 4)
      const five = workspacePartition(workspace, 5)
      expect(workspacePartition(workspace, 4)).toBe(four)
      expect(four).toBeGreaterThanOrEqual(0)
      expect(four).toBeLessThan(4)
      used.add(five)
      if (four !== five) {
        moved += 1
        expect(five).toBe(4)
      }
    }
    expect(used).toEqual(new Set([0, 1, 2, 3, 4]))
    expect(moved).toBeGreaterThan(300)
    expect(moved).toBeLessThan(500)
  })

  it('probes every slot exactly once in a stable cell-specific order', () => {
    const first = partitionProbeOrder('cell-a', 8)
    expect(first).toEqual(partitionProbeOrder('cell-a', 8))
    expect(new Set(first)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]))
    expect(partitionProbeOrder('cell-b', 8)).not.toEqual(first)
  })
})
