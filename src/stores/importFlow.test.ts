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
import { structurizrSource } from '../lib/import'
import bigBank from '../lib/structurizr/fixtures/big-bank-plc.dsl?raw'

const run = () => structurizrSource.run!(bigBank)

describe('importModel — store integration (the modal "Generate" path)', () => {
  beforeEach(() => {
    useModelStore.setState({
      objects: [],
      connections: [],
      groups: [],
      diagrams: [],
      domains: [{ id: 'd0', name: 'Default', color: '#3B82F6' }],
      currentDiagramId: null,
      selectedItems: [],
    })
  })

  it('merges imported entities into the store and keeps per-diagram layouts', async () => {
    const r = await run()
    useModelStore.getState().importModel({
      objects: r.objects,
      connections: r.connections,
      groups: r.groups,
      diagrams: r.diagrams,
    })
    const s = useModelStore.getState()
    expect(s.objects.length).toBe(r.objects.length)
    expect(s.connections.length).toBe(r.connections.length)
    expect(s.diagrams.length).toBe(r.diagrams.length)
    for (const d of s.diagrams) {
      expect(Object.keys(d.layouts ?? {}).length).toBeGreaterThan(0)
      for (const id of d.objectIds) expect(d.layouts?.[id]).toBeDefined()
    }
    expect(s.objects.every((o) => o.domainId === 'd0')).toBe(true)
  })

  it('navigates to the entry diagram', async () => {
    const r = await run()
    useModelStore.getState().importModel({
      objects: r.objects, connections: r.connections, groups: r.groups, diagrams: r.diagrams,
    })
    useModelStore.getState().setCurrentDiagram(r.entryDiagramId!)
    const cur = useModelStore.getState().getCurrentDiagram()
    expect(cur?.id).toBe(r.entryDiagramId)
    expect(cur?.type).toBe('context')
  })

  it('does not mutate the caller-supplied import objects when stamping the domain', async () => {
    const r = await run()
    const objsBefore = r.objects.map((o) => o.domainId)
    useModelStore.getState().importModel({
      objects: r.objects, connections: r.connections, groups: r.groups, diagrams: r.diagrams,
    })
    expect(r.objects.map((o) => o.domainId)).toEqual(objsBefore)
    expect(r.objects.every((o) => o.domainId === undefined)).toBe(true)
    expect(useModelStore.getState().objects.every((o) => o.domainId === 'd0')).toBe(true)
  })

  it('appends to an existing model without clobbering it', async () => {
    useModelStore.setState({
      objects: [
        {
          id: 'existing',
          type: 'system',
          name: 'Existing',
          position: { x: 0, y: 0 },
          size: { width: 100, height: 80 },
          tagAssignments: {},
          tagOrder: [],
          links: [],
          scope: 'internal',
          status: 'live',
          properties: {},
        },
      ],
      diagrams: [],
      domains: [{ id: 'd0', name: 'Default', color: '#3B82F6' }],
    })
    const r = await run()
    useModelStore.getState().importModel({
      objects: r.objects, connections: r.connections, groups: r.groups, diagrams: r.diagrams,
    })
    expect(useModelStore.getState().objects.length).toBe(r.objects.length + 1)
    expect(useModelStore.getState().objects.some((o) => o.id === 'existing')).toBe(true)
  })
})
