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
import type { C4Object, Connection, Diagram, Group } from '../../types'
import {
  buildClipboardPayload,
  CANVAS_CLIPBOARD_MIME,
  decodeClipboardPayload,
  encodeClipboardPayload,
  MAX_PAYLOAD_BYTES,
  readClipboardPayload,
} from './canvasClipboard'
import { payloadBounds, planPaste, type PasteContext } from './pastePlan'

const obj = (id: string, extra: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: `Name ${id}`, position: { x: 0, y: 0 }, size: { width: 100, height: 50 },
  tagAssignments: { t1: { tagId: 't1' } as never }, tagOrder: ['t1'], scope: 'internal', status: 'live', properties: {},
  ...extra,
}) as C4Object
const place = (x: number, y = 0) => ({ position: { x, y }, size: { width: 100, height: 50 } })

const source = {
  objects: [obj('A'), obj('B'), obj('C')],
  connections: [
    { id: 'ab', fromId: 'A', toId: 'B', type: 'solid', label: 'calls' } as Connection,
    { id: 'ac', fromId: 'A', toId: 'C', type: 'solid' } as Connection,
    { id: 'low', fromId: 'A', toId: 'B', type: 'solid', kind: 'lower' } as Connection,
  ],
  groups: [
    { id: 'g', name: 'G', color: '#111', objectIds: ['B'], tagAssignments: {}, tagOrder: [] } as Group,
    { id: 'wrap', name: 'W', color: '#111', objectIds: ['A'], parentObjectId: 'P', tagAssignments: {}, tagOrder: [] } as Group,
  ],
}
const diagram = {
  id: 'd1', name: 'd', type: 'context', objectIds: ['A', 'B', 'C'], connectionIds: ['ab', 'ac', 'low'], groupIds: ['g', 'wrap'],
  layouts: { A: place(0), B: place(200), C: place(400), g: place(180, -20) },
  layouts3d: { A: place(1000) },
} as Diagram

describe('buildClipboardPayload', () => {
  it('copies the selection, group members, and only connections with BOTH ends copied', () => {
    const payload = buildClipboardPayload(source, diagram, [{ id: 'A', type: 'object' }, { id: 'g', type: 'group' }], '2d', 'ws', 'copy1')!
    expect(payload.objects.map((o) => o.id).sort()).toEqual(['A', 'B'])
    expect(payload.groups.map((g) => g.id)).toEqual(['g'])
    expect(payload.connections.map((c) => c.id)).toEqual(['ab'])
    expect(payload.placements.A).toEqual(place(0))
  })

  it('records where shapes were SHOWN in the active space', () => {
    const payload = buildClipboardPayload(source, diagram, [{ id: 'A', type: 'object' }], '3d', 'ws', 'c')!
    expect(payload.placements.A).toEqual(place(1000))
  })

  it('never copies a diagram wrapper group, and returns null for nothing copyable', () => {
    expect(buildClipboardPayload(source, diagram, [{ id: 'wrap', type: 'group' }], '2d', 'ws', 'c')).toBeNull()
    expect(buildClipboardPayload(source, diagram, [{ id: 'ab', type: 'connection' }], '2d', 'ws', 'c')).toBeNull()
  })
})

describe('encode / read / decode', () => {
  const payload = buildClipboardPayload(source, diagram, [{ id: 'A', type: 'object' }, { id: 'B', type: 'object' }], '2d', 'ws', 'c')!

  it('round-trips through the custom format and through the HTML fallback alone', () => {
    const encoded = encodeClipboardPayload(payload)
    expect(readClipboardPayload((t) => (t === CANVAS_CLIPBOARD_MIME ? encoded.json : null))).toEqual(payload)
    // Safari/Firefox keep only text/html and text/plain.
    expect(readClipboardPayload((t) => (t === 'text/html' ? encoded.html : null))).toEqual(payload)
    expect(encoded.text).toBe('Name A\nName B')
  })

  it('round-trips non-Latin names through base64', () => {
    const p = { ...payload, objects: payload.objects.map((o) => ({ ...o, name: 'Système — 支付 🚀' })) }
    const encoded = encodeClipboardPayload(p)
    expect(readClipboardPayload((t) => (t === 'text/html' ? encoded.html : null))?.objects[0].name).toBe('Système — 支付 🚀')
  })

  it('ignores clipboard content that is not ours', () => {
    expect(readClipboardPayload((t) => (t === 'text/plain' ? 'hello' : null))).toBeNull()
    expect(readClipboardPayload((t) => (t === 'text/html' ? '<b>hi</b>' : null))).toBeNull()
    expect(readClipboardPayload((t) => (t === 'text/html' ? '<!--maplespire-canvas:%%%-->' : null))).toBeNull()
  })

  it('rejects hostile or malformed payloads', () => {
    expect(decodeClipboardPayload('x'.repeat(MAX_PAYLOAD_BYTES + 1))).toBeNull()
    expect(decodeClipboardPayload(JSON.stringify({ ...payload, app: 'other' }))).toBeNull()
    expect(decodeClipboardPayload(JSON.stringify({ ...payload, version: 2 }))).toBeNull()
    expect(decodeClipboardPayload(JSON.stringify({ ...payload, objects: [{ id: 'x', name: 1 }] }))).toBeNull()
  })

  it('keeps only known fields and safe links', () => {
    const hostile = {
      ...payload,
      objects: [{
        ...payload.objects[0],
        __proto__polluted: true,
        kind: 'lower',
        links: ['javascript:alert(1)', 'https://ok.example', { url: 'data:text/html,x' }, { url: 'mailto:a@b.c', label: 'm' }],
      }],
      connections: [],
    }
    const decoded = decodeClipboardPayload(JSON.stringify(hostile))!
    const o = decoded.objects[0] as unknown as Record<string, unknown>
    expect(o.__proto__polluted).toBeUndefined()
    expect(o.kind).toBeUndefined()
    expect(o.links).toEqual(['https://ok.example', { url: 'mailto:a@b.c', label: 'm' }])
  })

  it('drops malformed nested fields a renderer would crash on, and keeps well-formed ones', () => {
    const good = {
      u1: {
        id: 'u1', technologyId: 'postgres', catalogRevision: 1,
        snapshot: { schemaVersion: 1, name: 'PostgreSQL' },
      },
    }
    const decoded = decodeClipboardPayload(JSON.stringify({
      ...payload,
      objects: [
        { ...payload.objects[0], technologyUsages: { u: { id: 'u' } }, technologyUsageOrder: ['u'],
          iconAssignment: { source: 'technology', mode: 'explicit', displayName: 'x', technologyUsageId: 'u' },
          ownerAssignments: { o: { id: 'o' } }, properties: { ok: 'yes', bad: { nested: true } } },
        { ...payload.objects[1], technologyUsages: good, technologyUsageOrder: ['u1', 'ghost'],
          iconAssignment: { source: 'technology', mode: 'automatic', displayName: 'PostgreSQL', technologyUsageId: 'u1' } },
      ],
      connections: [],
    }))!
    const [bad, ok] = decoded.objects
    expect(bad.technologyUsages).toBeUndefined()
    expect(bad.technologyUsageOrder).toBeUndefined()
    expect(bad.iconAssignment).toBeUndefined()
    expect(bad.ownerAssignments).toBeUndefined()
    expect(bad.properties).toEqual({ ok: 'yes' })
    expect(ok.technologyUsages).toEqual(good)
    expect(ok.technologyUsageOrder).toEqual(['u1'])
    expect(ok.iconAssignment?.technologyUsageId).toBe('u1')
  })

  it('drops connections whose ends are not in the payload', () => {
    const decoded = decodeClipboardPayload(JSON.stringify({
      ...payload,
      connections: [...payload.connections, { id: 'dangling', fromId: 'A', toId: 'ZZZ', type: 'solid' }],
    }))!
    expect(decoded.connections.map((c) => c.id)).toEqual(['ab'])
  })
})

describe('planPaste', () => {
  const payload = buildClipboardPayload(source, diagram, [{ id: 'A', type: 'object' }, { id: 'g', type: 'group' }], '2d', 'ws', 'c')!
  let n = 0
  const ctx = (over: Partial<PasteContext>): PasteContext => ({
    workspaceKey: 'ws',
    target: diagram,
    objectExists: () => true,
    groupExists: () => true,
    connectionExists: () => true,
    knownTagIds: new Set(['t1']),
    forceCopy: false,
    offset: { x: 0, y: 0 },
    mintId: () => `new${++n}`,
    copyName: (name) => `${name} (copy)`,
    ...over,
  })
  const otherDiagram = { id: 'd2', name: 'd2', type: 'context', objectIds: [], connectionIds: [], groupIds: [] } as unknown as Diagram

  it('pasting where the originals already are makes COPIES with fresh ids, remapped members and connections', () => {
    const plan = planPaste(payload, ctx({ offset: { x: 20, y: 20 } }))
    expect(plan.mode).toBe('copy')
    expect(plan.newObjects.map((o) => o.name).sort()).toEqual(['Name A (copy)', 'Name B (copy)'])
    const ids = new Set([...plan.newObjects.map((o) => o.id), ...plan.newGroups.map((g) => g.id)])
    expect(ids.has('A') || ids.has('B') || ids.has('g')).toBe(false)
    expect(plan.newGroups[0].objectIds.every((id) => ids.has(id))).toBe(true)
    expect(plan.newConnections).toHaveLength(1)
    expect(ids.has(plan.newConnections[0].fromId) && ids.has(plan.newConnections[0].toId)).toBe(true)
    expect(plan.newConnections[0].label).toBe('calls')
    const a = plan.newObjects.find((o) => o.name === 'Name A (copy)')!
    expect(plan.placements[a.id].position).toEqual({ x: 20, y: 20 })
    expect(plan.selection.map((s) => s.id).sort()).toEqual([...ids].sort())
  })

  it('copied connections keep their bends WITH the shapes (offset like them)', () => {
    const bent = { ...payload, connections: [{ ...payload.connections[0], waypoints: [{ x: 100, y: 10 }], waypoints3d: [{ x: 5, y: 5 }] }] }
    const plan = planPaste(bent, ctx({ offset: { x: 20, y: 30 } }))
    expect(plan.newConnections[0].waypoints).toEqual([{ x: 120, y: 40 }])
    expect(plan.newConnections[0].waypoints3d).toEqual([{ x: 25, y: 35 }])
  })

  it('pasting into ANOTHER view of the same workspace references the same elements', () => {
    const plan = planPaste(payload, ctx({ target: otherDiagram }))
    expect(plan.mode).toBe('reference')
    expect(plan.newObjects).toHaveLength(0)
    expect(plan.addObjectIds.sort()).toEqual(['A', 'B'])
    expect(plan.addGroupIds).toEqual(['g'])
    expect(plan.addConnectionIds).toEqual(['ab'])
  })

  it('copies instead when an element no longer exists, when forced, or across workspaces', () => {
    expect(planPaste(payload, ctx({ target: otherDiagram, objectExists: (id) => id !== 'B' })).mode).toBe('copy')
    expect(planPaste(payload, ctx({ target: otherDiagram, forceCopy: true })).mode).toBe('copy')
    expect(planPaste(payload, ctx({ target: otherDiagram, workspaceKey: 'other' })).mode).toBe('copy')
  })

  it('a cross-workspace copy drops tags the target does not know and the source parent', () => {
    const withParent = { ...payload, objects: payload.objects.map((o) => ({ ...o, parentId: 'P', domainId: 'dom' })) }
    const plan = planPaste(withParent, ctx({ target: otherDiagram, workspaceKey: 'other', knownTagIds: new Set(), defaultDomainId: 'home' }))
    expect(plan.newObjects.every((o) => Object.keys(o.tagAssignments).length === 0 && o.tagOrder.length === 0)).toBe(true)
    expect(plan.newObjects.every((o) => o.parentId === undefined && o.domainId === 'home')).toBe(true)
  })

  it('re-parents an app pasted on a container diagram to the element that diagram details', () => {
    const container = { ...otherDiagram, type: 'container', parentObjectId: 'SYS' } as Diagram
    const plan = planPaste(payload, ctx({ target: container, forceCopy: true }))
    expect(plan.newObjects.every((o) => o.parentId === 'SYS')).toBe(true)
  })

  it('a group-only paste onto the diagram that already draws the group makes a COPY', () => {
    const groupOnly = { ...payload, objects: [], connections: [] }
    expect(planPaste(groupOnly, ctx({})).mode).toBe('copy')
    // Control: the same payload into a view that does not draw it is a reference.
    expect(planPaste(groupOnly, ctx({ target: otherDiagram })).mode).toBe('reference')
  })

  it('a copied connection keeps its DIRECTION: from the copy of its source to the copy of its target', () => {
    const plan = planPaste(payload, ctx({}))
    const copyOf = (name: string) => plan.newObjects.find((o) => o.name === `${name} (copy)`)!.id
    expect(plan.newConnections).toHaveLength(1)
    expect(plan.newConnections[0].fromId).toBe(copyOf('Name A'))
    expect(plan.newConnections[0].toId).toBe(copyOf('Name B'))
  })

  it('a cross-workspace copy filters tags on groups and connections too, and re-homes the group domain', () => {
    const tags = { tagAssignments: { t1: { tagId: 't1' }, t9: { tagId: 't9' } } as never, tagOrder: ['t1', 't9'] }
    const tagged = {
      ...payload,
      groups: payload.groups.map((g) => ({ ...g, ...tags, domainId: 'dom' })),
      connections: payload.connections.map((c) => ({ ...c, ...tags })),
    }
    const plan = planPaste(tagged, ctx({ target: otherDiagram, workspaceKey: 'other', knownTagIds: new Set(['t1']), defaultDomainId: 'home' }))
    expect(plan.mode).toBe('copy')
    expect(plan.newGroups).toHaveLength(1)
    expect(plan.newConnections).toHaveLength(1)
    for (const entity of [...plan.newGroups, ...plan.newConnections]) {
      expect(Object.keys(entity.tagAssignments ?? {})).toEqual(['t1'])
      expect(entity.tagOrder).toEqual(['t1'])
    }
    expect(plan.newGroups[0].domainId).toBe('home')
  })

  it('payloadBounds spans every placement', () => {
    expect(payloadBounds(payload)).toEqual({ x: 0, y: -20, width: 300, height: 70 })
  })
})
