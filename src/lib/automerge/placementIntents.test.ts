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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { change, from } from '@automerge/automerge'
import type { Connection, Diagram, Group } from '../../types'
import { createMemoryKvStore } from '../modelQuery/kvStore'
import { entityIntentTabId } from './entityIntents'
import type { DiagramDoc } from './types'
import {
  applyPlacementSnapshotToDiagramDoc,
  hydratePlacementIntents,
  PendingPlacementIntents,
  pendingPlacementIntents,
  persistPlacementIntents,
  schedulePersistPlacementIntents,
} from './placementIntents'

const workspace = 'landscape::version'

function diagram(x: number): Diagram {
  return {
    id: 'd1',
    name: 'Diagram',
    type: 'container',
    objectIds: ['o1'],
    connectionIds: ['c1'],
    groupIds: ['g1'],
    layouts: {
      o1: { position: { x, y: 10 }, size: { width: 160, height: 90 } },
      g1: { position: { x: 0, y: 0 }, size: { width: 400, height: 300 } },
    },
  }
}

describe('PendingPlacementIntents', () => {
  let intents: PendingPlacementIntents

  beforeEach(() => {
    intents = new PendingPlacementIntents()
  })

  afterEach(() => {
    pendingPlacementIntents.clearWorkspace(workspace)
    vi.useRealTimers()
  })

  it('revisionNow is the ack ceiling for retirements planned now — a later record survives an earlier ceiling', () => {
    // Pins `revisionNow` as the ack ceiling: acknowledging up to
    // MAX_SAFE_INTEGER instead would swallow a drag recorded after the
    // retirement was planned (e.g. a same-id recreation being dragged).
    const first = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 20, y: 30 }, size: { width: 160, height: 90 } }],
    })
    expect(intents.revisionNow).toBe(first.revision)
    const ceiling = intents.revisionNow
    const later = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 80, y: 90 }, size: { width: 160, height: 90 } }],
    })
    expect(intents.revisionNow).toBe(later.revision)

    intents.acknowledge(workspace, 'd1', ceiling)

    // The re-record carries a higher revision than the plan-time ceiling and
    // MUST survive the retirement.
    expect(intents.hasPending(workspace, 'd1')).toBe(true)
    expect(intents.snapshot(workspace, 'd1')).toMatchObject({
      objects: [{ id: 'o1', position: { x: 80, y: 90 } }],
    })
  })

  it('keeps only the latest absolute placement per entity', () => {
    const first = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 20, y: 30 }, size: { width: 160, height: 90 } }],
    })
    const last = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 80, y: 90 }, size: { width: 160, height: 90 } }],
    })

    // Leading-edge contract: the FIRST record of a key reports it as
    // new (immediate persist); a re-record of the same key does not.
    expect(first.newKeys).toBe(true)
    expect(last.newKeys).toBe(false)
    expect(last.revision).toBeGreaterThan(first.revision)
    expect(intents.snapshot(workspace, 'd1')).toMatchObject({
      throughRevision: last.revision,
      objects: [{ id: 'o1', position: { x: 80, y: 90 } }],
    })
  })

  it('collapses ten thousand offline micro-moves to one final absolute placement', () => {
    for (let index = 0; index < 10_000; index += 1) {
      intents.record(workspace, 'd1', '2d', {
        objects: [{
          id: 'o1',
          position: { x: index, y: index * 2 },
          size: { width: 160, height: 90 },
        }],
      })
    }

    expect(intents.snapshot(workspace, 'd1')?.objects).toEqual([{
      id: 'o1',
      position: { x: 9_999, y: 19_998 },
      size: { width: 160, height: 90 },
      space: '2d',
    }])
  })

  it('rebases pending placements over a stale server projection', () => {
    intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 300, y: 200 }, size: { width: 160, height: 90 } }],
      groups: [{
        id: 'g1',
        position: { x: 20, y: 30 },
        size: { width: 420, height: 320 },
        autoSize: false,
      }],
      connections: [{ id: 'c1', data: { fromAnchor: 3 } }],
    })

    const staleGroups = [{
      id: 'g1', name: 'Group', color: '#888', objectIds: ['o1'], autoSize: true,
    }] as Group[]
    const staleConnections = [{
      id: 'c1', fromId: 'o1', toId: 'o2', type: 'solid', fromAnchor: 1,
    }] as Connection[]

    const rebased = intents.overlayProjection(workspace, 'd1', {
      diagrams: [diagram(10)],
      groups: staleGroups,
      connections: staleConnections,
    })

    expect(rebased.diagrams[0].layouts?.o1.position).toEqual({ x: 300, y: 200 })
    expect(rebased.diagrams[0].layouts?.g1).toEqual({
      position: { x: 20, y: 30 },
      size: { width: 420, height: 320 },
    })
    expect(rebased.groups[0].autoSize).toBe(false)
    expect(rebased.connections[0].fromAnchor).toBe(3)
  })

  it('acknowledgeWhere honours the predicate — the off-active drain must not erase model-doc records', () => {
    // The drain writes ONLY object/pure-geometry-group records into the
    // DiagramDoc; connection and autoSize-group records target the MODEL
    // documents that only the active-diagram flush writes. Forgetting them
    // here would erase the journal with the data written nowhere.
    const recorded = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 1, y: 2 }, size: { width: 160, height: 90 } }],
      groups: [
        { id: 'gGeom', position: { x: 5, y: 6 }, size: { width: 300, height: 200 } },
        { id: 'gAuto', position: { x: 7, y: 8 }, size: { width: 300, height: 200 }, autoSize: true },
      ],
      connections: [{ id: 'c1', data: { fromAnchor: 2 } }],
    })

    intents.acknowledgeWhere(
      workspace, 'd1', recorded.revision,
      (record) => record.kind === 'object'
        || (record.kind === 'group' && record.autoSize === undefined),
    )

    const snapshot = intents.snapshot(workspace, 'd1')!
    expect(snapshot.objects, 'object record acked').toEqual([])
    expect(snapshot.groups.map((g) => g.id), 'only the autoSize group survives').toEqual(['gAuto'])
    expect(snapshot.connections.map((c) => c.id), 'connection record survives').toEqual(['c1'])
    expect(intents.pendingCount(workspace)).toBe(2)
  })

  it('does not acknowledge a newer placement that arrived during a flush', () => {
    const flushing = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 20, y: 30 }, size: { width: 160, height: 90 } }],
    })
    const newer = intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 90, y: 100 }, size: { width: 160, height: 90 } }],
    })

    intents.acknowledge(workspace, 'd1', flushing.revision)

    expect(intents.snapshot(workspace, 'd1')).toMatchObject({
      throughRevision: newer.revision,
      objects: [{ id: 'o1', position: { x: 90, y: 100 } }],
    })
  })

  it('adoption recency: on a key collision the WALL-CLOCK newer record wins, not the last-adopted tab', () => {
    // Revisions are per-tab counters and incomparable across tabs: without
    // the recordedAt tiebreak, registry order would decide which crashed
    // tab's geometry replays.
    const older = {
      workspaceKey: workspace, diagramId: 'd1', space: '2d' as const,
      revision: 90, recordedAt: 1_000, kind: 'object' as const, id: 'o1',
      position: { x: 1, y: 1 }, size: { width: 160, height: 90 },
    }
    const newer = {
      workspaceKey: workspace, diagramId: 'd1', space: '2d' as const,
      revision: 3, recordedAt: 2_000, kind: 'object' as const, id: 'o1',
      position: { x: 99, y: 99 }, size: { width: 160, height: 90 },
    }
    const journal = new PendingPlacementIntents()
    // Adopted newest-first, then the OLDER tab: the older must not clobber.
    journal.hydrate(workspace, [newer])
    journal.hydrate(workspace, [older])
    expect(journal.snapshot(workspace, 'd1')?.objects[0].position).toEqual({ x: 99, y: 99 })
    // And the reverse order converges to the same winner.
    const journal2 = new PendingPlacementIntents()
    journal2.hydrate(workspace, [older])
    journal2.hydrate(workspace, [newer])
    expect(journal2.snapshot(workspace, 'd1')?.objects[0].position).toEqual({ x: 99, y: 99 })
  })

  it('serializes and hydrates a crash-safe pending queue', () => {
    intents.record(workspace, 'd1', '3d', {
      objects: [{ id: 'o1', position: { x: 700, y: 500 }, size: { width: 160, height: 90 } }],
    })

    const restored = new PendingPlacementIntents()
    restored.hydrate(workspace, intents.serialize(workspace))

    expect(restored.snapshot(workspace, 'd1')).toMatchObject({
      objects: [{ id: 'o1', position: { x: 700, y: 500 } }],
    })
  })

  it('applies the bounded snapshot to a real Automerge DiagramDoc', () => {
    intents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 320, y: 240 }, size: { width: 160, height: 90 } }],
    })
    intents.record(workspace, 'd1', '3d', {
      groups: [{ id: 'g1', position: { x: 50, y: 60 }, size: { width: 500, height: 400 } }],
    })
    const snapshot = intents.snapshot(workspace, 'd1')!
    const initial: DiagramDoc = {
      name: 'Diagram',
      type: 'container',
      objectIds: ['o1'],
      connectionIds: [],
      groupIds: ['g1'],
      layouts: {},
      comments: {},
      flows: {},
      checkpoints: [],
    }

    const updated = change(from(initial), (doc) => {
      applyPlacementSnapshotToDiagramDoc(doc, snapshot)
    })

    expect(updated.layouts?.o1.position).toEqual({ x: 320, y: 240 })
    expect(updated.layouts3d?.g1).toEqual({
      position: { x: 50, y: 60 },
      size: { width: 500, height: 400 },
    })
  })

  it('persists, restores and clears the singleton crash-recovery journal', async () => {
    const store = createMemoryKvStore()
    pendingPlacementIntents.clearWorkspace(workspace)
    pendingPlacementIntents.record(workspace, 'd1', '2d', {
      objects: [{ id: 'o1', position: { x: 444, y: 555 }, size: { width: 160, height: 90 } }],
    })
    await persistPlacementIntents(store, workspace)

    pendingPlacementIntents.clearWorkspace(workspace)
    await hydratePlacementIntents(store, workspace)
    const restored = pendingPlacementIntents.snapshot(workspace, 'd1')!
    expect(restored.objects[0].position).toEqual({ x: 444, y: 555 })

    pendingPlacementIntents.acknowledge(workspace, 'd1', restored.throughRevision)
    await persistPlacementIntents(store, workspace)
    pendingPlacementIntents.clearWorkspace(workspace)
    await hydratePlacementIntents(store, workspace)
    expect(pendingPlacementIntents.hasPending(workspace)).toBe(false)
  })

  it('persists the latest intent at maxWait during continuous pointer updates', async () => {
    vi.useFakeTimers()
    const store = createMemoryKvStore()
    const setSpy = vi.spyOn(store, 'set')

    for (let index = 0; index < 20; index += 1) {
      pendingPlacementIntents.record(workspace, 'd1', '3d', {
        objects: [{
          id: 'o1',
          position: { x: index, y: index },
          size: { width: 160, height: 90 },
        }],
      })
      schedulePersistPlacementIntents(store, workspace, 50)
      await vi.advanceTimersByTimeAsync(25)
    }

    expect(setSpy).toHaveBeenCalledTimes(1)
    // v2 (phase B): per-TAB key — the shared v1 key let a clean sibling tab
    // overwrite or delete the journal of the tab that still needed it.
    expect(await store.get(`pending-placement-intents:v2:tab:${entityIntentTabId}`)).toBeDefined()
  })

  it('v2 storage: a clean sibling tab persisting cannot erase THIS tab\'s journal (the v1 defect)', async () => {
    const store = createMemoryKvStore()
    const ws = `${workspace}:sibling`
    // Simulate the crashed/busy tab's on-disk journal under a FOREIGN tab key.
    const foreign = [{
      workspaceKey: ws, diagramId: 'd1', space: '2d' as const, revision: 7,
      kind: 'object' as const, id: 'o1',
      position: { x: 11, y: 22 }, size: { width: 160, height: 90 },
    }]
    await store.set('pending-placement-intents:v2:tab:busy-tab', foreign)
    await store.set('pending-placement-intents:v2:tabs', ['busy-tab'])
    // THIS tab has nothing pending and persists — under v1 this DELETED the
    // shared key, erasing the busy tab's pending placements from disk.
    await persistPlacementIntents(store, ws)
    expect(await store.get('pending-placement-intents:v2:tab:busy-tab')).toEqual(foreign)
    expect(await store.get<string[]>('pending-placement-intents:v2:tabs')).toContain('busy-tab')
  })

  it('adopts the LEGACY v1 single-key journal at hydration and empties it conditionally', async () => {
    const store = createMemoryKvStore()
    const ws = `${workspace}:v1-adopt`
    pendingPlacementIntents.clearWorkspace(ws)
    await store.set('pending-placement-intents:v1', [{
      workspaceKey: ws, diagramId: 'd9', space: '2d' as const, revision: 3,
      kind: 'object' as const, id: 'oL',
      position: { x: 640, y: 480 }, size: { width: 160, height: 90 },
    }])
    await hydratePlacementIntents(store, ws)
    expect(pendingPlacementIntents.snapshot(ws, 'd9')?.objects[0].position).toEqual({ x: 640, y: 480 })
    // Re-homed under our v2 tab key; the v1 key emptied (conditional update).
    expect(await store.get(`pending-placement-intents:v2:tab:${entityIntentTabId}`)).toHaveLength(1)
    expect(await store.get('pending-placement-intents:v1')).toEqual([])
    pendingPlacementIntents.clearWorkspace(ws)
    await persistPlacementIntents(store, ws)
  })
})
