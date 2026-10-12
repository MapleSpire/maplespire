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

import { describe, it, expect, beforeEach } from 'vitest'
import { useModelStore } from './modelStore'
import type { C4Object, Connection, Diagram, Flow, Group } from '../types'

// Duplicating a diagram copies the VIEW. Every other copy path in this repo
// (duplicating a shape, importing JSON, forking a version) mints fresh entity
// ids; this one must NOT, or the model silently doubles behind the user.

const obj = (id: string): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 160, height: 90 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
})
const conn = (id: string, fromId: string, toId: string): Connection => ({ id, fromId, toId, type: 'solid' })
const group = (id: string): Group => ({ id, name: id, objectIds: ['A'], position: { x: 0, y: 0 }, size: { width: 400, height: 300 } } as Group)

const source: Diagram = {
  id: 'd1',
  name: 'Containers',
  type: 'container',
  objectIds: ['A', 'B'],
  connectionIds: ['c1'],
  groupIds: ['g1'],
  layouts: {
    A: { position: { x: 40, y: 60 }, size: { width: 160, height: 90 } },
    B: { position: { x: 400, y: 60 }, size: { width: 160, height: 90 } },
  },
}

const flow: Flow = {
  id: 'f1',
  name: 'Sign in',
  diagramId: 'd1',
  steps: [{ id: 's1', order: 0, type: 'process', title: 'Authenticate', objectId: 'A' }],
}

beforeEach(() => {
  useModelStore.setState({
    objects: [obj('A'), obj('B')],
    connections: [conn('c1', 'A', 'B')],
    groups: [group('g1')],
    diagrams: [source],
    flows: [flow],
    domains: [],
    currentDiagramId: 'd1',
    selectedItems: [],
  })
})

describe('duplicateDiagram', () => {
  it('adds a diagram without adding a single model entity', () => {
    const before = useModelStore.getState()
    const objectIds = before.objects.map((o) => o.id)
    const connectionIds = before.connections.map((c) => c.id)
    const groupIds = before.groups.map((g) => g.id)

    useModelStore.getState().duplicateDiagram(source, [flow], 'Containers (copy)')

    const after = useModelStore.getState()
    expect(after.diagrams).toHaveLength(2)
    expect(after.objects.map((o) => o.id)).toEqual(objectIds)
    expect(after.connections.map((c) => c.id)).toEqual(connectionIds)
    expect(after.groups.map((g) => g.id)).toEqual(groupIds)
  })

  it('points the copy at the same objects, connections and groups', () => {
    const id = useModelStore.getState().duplicateDiagram(source, [], 'Containers (copy)')
    const copy = useModelStore.getState().diagrams.find((d) => d.id === id)!
    expect(copy.objectIds).toEqual(['A', 'B'])
    expect(copy.connectionIds).toEqual(['c1'])
    expect(copy.groupIds).toEqual(['g1'])
  })

  it('gives the copy its own id and the supplied name', () => {
    const id = useModelStore.getState().duplicateDiagram(source, [], 'Containers (copy)')
    expect(id).not.toBe('d1')
    expect(useModelStore.getState().diagrams.find((d) => d.id === id)!.name).toBe('Containers (copy)')
    expect(useModelStore.getState().diagrams.find((d) => d.id === 'd1')!.name).toBe('Containers')
  })

  it('keeps the source diagram exactly as it was', () => {
    useModelStore.getState().duplicateDiagram(source, [flow], 'Containers (copy)')
    const original = useModelStore.getState().diagrams.find((d) => d.id === 'd1')!
    expect(original.layouts).toEqual(source.layouts)
    expect(original.objectIds).toEqual(['A', 'B'])
  })

  it('moving a shape in the copy does not move it in the source', () => {
    // Immer's copy-on-write already insulates the store from a shallow layouts
    // copy — the aliasing that would matter shows up one layer down, when the
    // structure is handed to another Automerge document. `duplicate.test.ts`
    // covers that; this covers the behaviour a user can actually see.
    const id = useModelStore.getState().duplicateDiagram(source, [], 'Copy')
    useModelStore.getState().applyDiagramLayout(id, {
      A: { position: { x: 999, y: 999 }, size: { width: 160, height: 90 } },
    }, [])

    const original = useModelStore.getState().diagrams.find((d) => d.id === 'd1')!
    expect(original.layouts!.A.position).toEqual({ x: 40, y: 60 })
  })

  it('copies the flows onto the new diagram with fresh ids', () => {
    const id = useModelStore.getState().duplicateDiagram(source, [flow], 'Copy')
    const flows = useModelStore.getState().flows
    expect(flows).toHaveLength(2)
    const copied = flows.find((f) => f.diagramId === id)!
    expect(copied.id).not.toBe('f1')
    expect(copied.steps[0].id).not.toBe('s1')
    // The step still points at the shared object.
    expect(copied.steps[0]).toMatchObject({ objectId: 'A' })
    expect(flows.find((f) => f.id === 'f1')!.diagramId).toBe('d1')
  })

  it('adds no flow rows when the source has none', () => {
    useModelStore.setState({ flows: [] })
    useModelStore.getState().duplicateDiagram(source, [], 'Copy')
    expect(useModelStore.getState().flows).toEqual([])
  })

  it('does not switch the active diagram', () => {
    // Selecting the copy would switch the active document, and that
    // re-projection resets the store's flow window before the copy's DiagramDoc
    // exists to hold the flows we just wrote.
    useModelStore.getState().duplicateDiagram(source, [flow], 'Copy')
    expect(useModelStore.getState().currentDiagramId).toBe('d1')
  })
})
