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
import {
  assertDedicatedCensus, assertDedicatedTopology, classifyDedicatedOwnership,
  assertDedicatedOwner, parseDedicatedFsck,
} from './sync-cell-dedicated-contract.mjs'

const workspace = { landscapeId: 'named-landscape', versionId: 'named-version' }
const options = { generation: 'dedicated@ce1461953e2b8ac2', reservedPartition: 1, partitionCount: 2 }
const fleet = () => [
  { cellId: 'failover-cell-a', enabled: true, topologyConfirmed: true, topologyGeneration: 'dedicated@ce1461953e2b8ac2',
    partitionCount: 2, placementMode: 'placed', reservedPartitions: [1], role: 'pool', partitionIndex: 0,
    partitionReady: true, ready: true, ownedWorkspaceCount: 0, expectedWorkspaceCount: 0 },
  { cellId: 'failover-cell-b', enabled: true, topologyConfirmed: true, topologyGeneration: 'dedicated@ce1461953e2b8ac2',
    partitionCount: 2, placementMode: 'placed', reservedPartitions: [1], role: 'pool', partitionIndex: null,
    partitionReady: false, ready: false, ownedWorkspaceCount: 0, expectedWorkspaceCount: 0 },
  { cellId: 'failover-cell-c', enabled: true, topologyConfirmed: true, topologyGeneration: 'dedicated@ce1461953e2b8ac2',
    partitionCount: 2, placementMode: 'placed', reservedPartitions: [1], role: 'reserved:1', partitionIndex: 1,
    partitionReady: true, ready: true, ownedWorkspaceCount: 1, expectedWorkspaceCount: 1 },
]
const fsck = () => ({ reports: [{ workspace: { ...workspace }, status: 'clean' }], sharedRoots: [] })

test('the named workspace is the whole ownable census, not a member of a filtered result', () => {
  assertDedicatedCensus([{ landscape_id: 'named-landscape', id: 'named-version' }], workspace)
  for (const rows of [[], null, [{ landscape_id: 'other', id: 'named-version' }],
    [{ landscape_id: 'named-landscape', id: 'other' }], [null],
    [{ landscape_id: 'named-landscape', id: 'named-version' }, { landscape_id: 'extra', id: 'extra' }]]) {
    assert.throws(() => assertDedicatedCensus(rows, workspace), /census/)
  }
})

test('C owns the one workspace while the pool owner and standby both report zero', () => {
  const states = fleet()
  const before = structuredClone(states)
  assert.equal(classifyDedicatedOwnership(states, options), 'failover-cell-c')
  assert.equal(assertDedicatedOwner(states, options, 'failover-cell-c').cellId, 'failover-cell-c')
  assert.deepEqual(states, before, 'validation must not repair or mutate evidence')
})

test('cell response order is immaterial and B can be the pool owner', () => {
  const states = fleet()
  Object.assign(states[0], { partitionIndex: null, partitionReady: false, ready: false })
  Object.assign(states[1], { partitionIndex: 0, partitionReady: true, ready: true, ownedWorkspaceCount: 1, expectedWorkspaceCount: 1 })
  Object.assign(states[2], { ownedWorkspaceCount: 0, expectedWorkspaceCount: 0 })
  assert.equal(assertDedicatedOwner(states.reverse(), options, 'failover-cell-b').cellId, 'failover-cell-b')
})

test('a transfer sample distinguishes no owner from a converged destination', () => {
  const states = fleet()
  states[2].ownedWorkspaceCount = 0
  assert.equal(classifyDedicatedOwnership(states, options), null)
  assert.throws(() => assertDedicatedOwner(states, options, 'failover-cell-c'), /not uniquely owned/)
})

for (const [label, transform] of [
  ['A missing', states => states.slice(1)],
  ['B missing', states => [states[0], states[2]]],
  ['C missing', states => states.slice(0, 2)],
  ['duplicate A replacing B', states => [states[0], structuredClone(states[0]), states[2]]],
  ['duplicate C replacing A', states => [structuredClone(states[2]), states[1], states[2]]],
  ['four responses', states => [...states, structuredClone(states[0])]],
  ['unknown C identity', states => { states[2].cellId = 'other-cell-c'; return states }],
  ['null snapshot', states => [states[0], null, states[2]]],
]) {
  test(`the three-cell conjunction refuses ${label}`, () => {
    assert.throws(() => assertDedicatedOwner(transform(fleet()), options, 'failover-cell-c'), /Dedicated gate/)
  })
}

for (const [field, value] of [
  ['enabled', false], ['enabled', undefined], ['topologyConfirmed', false],
  ['topologyGeneration', 'another-generation'], ['topologyGeneration', undefined],
  ['partitionCount', 1], ['partitionCount', '2'], ['placementMode', 'shadow'], ['placementMode', undefined],
  ['reservedPartitions', []], ['reservedPartitions', [0, 1]], ['reservedPartitions', ['1']], ['reservedPartitions', undefined],
  ['role', 'pool'], ['role', undefined], ['partitionIndex', 0], ['partitionIndex', '1'], ['partitionIndex', undefined],
  ['ready', undefined], ['ready', 'true'], ['partitionReady', undefined], ['partitionReady', 1],
]) {
  test(`the reserved cell refuses ${field}=${JSON.stringify(value)}`, () => {
    const states = fleet()
    states[2][field] = value
    assert.throws(() => assertDedicatedTopology(states, options), /Dedicated gate/)
  })
}

test('both pool cells must exclude the reserved role and slot', () => {
  for (const index of [0, 1]) {
    for (const change of [{ role: 'reserved:1' }, { partitionIndex: 1 }, { placementMode: 'shadow' }, { reservedPartitions: [] }]) {
      const states = fleet()
      Object.assign(states[index], change)
      assert.throws(() => assertDedicatedTopology(states, options), /Dedicated gate/)
    }
  }
})

test('callers cannot accidentally qualify a different expected topology', () => {
  for (const expected of [{}, { ...options, generation: '' }, { ...options, reservedPartition: 0 },
    { ...options, partitionCount: 3 }, { ...options, partitionCount: '2' }]) {
    assert.throws(() => assertDedicatedTopology(fleet(), expected), /Dedicated gate/)
  }
})

for (const field of ['ownedWorkspaceCount', 'expectedWorkspaceCount']) {
  for (const value of [undefined, null, '0', false, -1, 2, 0.5, NaN, Infinity]) {
    test(`no missing or malformed ${field}=${String(value)} becomes a zero witness`, () => {
      const states = fleet()
      states[0][field] = value
      assert.throws(() => classifyDedicatedOwnership(states, options), /must be an integer/)
    })
  }
}

for (const other of [0, 1]) {
  test(`C answering yes is insufficient when pool cell ${other === 0 ? 'A' : 'B'} also answers yes`, () => {
    const states = fleet()
    states[other].ownedWorkspaceCount = 1
    assert.throws(() => classifyDedicatedOwnership(states, options), { code: 'DEDICATED_MULTIPLE_OWNERS' })
  })
}

test('a mixed observation receives its code only after every snapshot count was validated', () => {
  const states = fleet()
  states[0].ownedWorkspaceCount = 1
  delete states[2].expectedWorkspaceCount
  assert.throws(() => classifyDedicatedOwnership(states, options), error => {
    assert.match(error.message, /must be an integer/)
    assert.notEqual(error.code, 'DEDICATED_MULTIPLE_OWNERS')
    return true
  })
})

test('a unique owner does not establish convergence of every expected count', () => {
  for (const index of [0, 1, 2]) {
    const states = fleet()
    states[index].expectedWorkspaceCount = index === 2 ? 0 : 1
    assert.equal(classifyDedicatedOwnership(states, options), 'failover-cell-c')
    assert.throws(() => assertDedicatedOwner(states, options, 'failover-cell-c'), /not converged/)
  }
})

test('a destination must hold a ready partition, but the standby need not', () => {
  for (const change of [{ ready: false }, { partitionReady: false }, { partitionIndex: null }]) {
    const states = fleet()
    Object.assign(states[2], change)
    assert.throws(() => assertDedicatedOwner(states, options, 'failover-cell-c'), /not a ready partition owner/)
  }
  assert.throws(() => assertDedicatedOwner(fleet(), options, 'failover-cell-a'), /not uniquely owned/)
  assert.throws(() => assertDedicatedOwner(fleet(), options, 'invented-cell'), /destination cell/)
})

test('fsck parses the complete report after npm preambles with either newline convention', () => {
  const report = fsck()
  for (const newline of ['\n', '\r\n']) {
    const output = ['> maplespire-server@0.0.0 fsck', '> tsx scripts/fsck-workspaces.ts --landscape-id named-landscape --version-id named-version --json', '',
      JSON.stringify(report, null, 2), ''].join(newline)
    assert.deepEqual(parseDedicatedFsck(output, workspace), report)
  }
})

for (const [label, change] of [
  ['zero reports', report => { report.reports = [] }],
  ['two reports including a clean target', report => { report.reports.push({ workspace: { landscapeId: 'other', versionId: 'other' }, status: 'clean' }) }],
  ['wrong landscape', report => { report.reports[0].workspace.landscapeId = 'other' }],
  ['wrong version', report => { report.reports[0].workspace.versionId = 'other' }],
  ['incomplete', report => { report.reports[0].status = 'incomplete' }],
  ['violations', report => { report.reports[0].status = 'violations' }],
  ['missing status', report => { delete report.reports[0].status }],
  ['missing report identity', report => { delete report.reports[0].workspace }],
  ['missing shared-root results', report => { delete report.sharedRoots }],
]) {
  test(`fsck refuses ${label}`, () => {
    const report = fsck()
    change(report)
    assert.throws(() => parseDedicatedFsck(JSON.stringify(report), workspace), /Dedicated gate/)
  })
}

test('fsck refuses non-JSON, truncated, duplicate and trailing report output', () => {
  for (const output of ['', 'npm failed', '{"reports":', JSON.stringify(fsck()) + '\n' + JSON.stringify(fsck()),
    JSON.stringify(fsck()) + '\nfsck failed after reporting', 'null', '[]']) {
    assert.throws(() => parseDedicatedFsck(output, workspace), /fsck/)
  }
})

test('unrelated park findings do not replace the filtered verdict, while a target twin refuses', () => {
  const report = fsck()
  report.sharedRoots = [{ rootUrl: 'automerge:shared-root', workspaces: [
    { landscapeId: 'other', versionId: 'one' }, { landscapeId: 'other', versionId: 'two' },
  ] }]
  assert.deepEqual(parseDedicatedFsck(JSON.stringify(report), workspace), report)
  report.sharedRoots[0].workspaces[1] = { ...workspace }
  assert.throws(() => parseDedicatedFsck(JSON.stringify(report), workspace), /includes the target/)
})

test('malformed shared-root evidence cannot conceal an unparsed target twin', () => {
  for (const finding of [null, {}, { rootUrl: 'automerge:root', workspaces: [] },
    { rootUrl: 'automerge:root', workspaces: [null, { ...workspace }] }]) {
    const report = fsck()
    report.sharedRoots = [finding]
    assert.throws(() => parseDedicatedFsck(JSON.stringify(report), workspace), /Dedicated gate/)
  }
})
