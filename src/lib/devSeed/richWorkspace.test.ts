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

import { describe, it, expect } from 'vitest'
import { generateRichWorkspace } from './richWorkspace'

describe('generateRichWorkspace', () => {
  const w = generateRichWorkspace({ seed: 7 })

  it('hits the requested counts', () => {
    expect(w.objects.length).toBe(20000)
    expect(w.connections.length).toBe(30000)
    expect(w.diagrams.length).toBe(200)
    expect(w.decisionRecords.length).toBe(400)
    expect(w.flows.length).toBe(400) // 2 per diagram
  })

  it('gives every object a description + 5 technologies + tags', () => {
    for (const o of [w.objects[0], w.objects[9999], w.objects[19999]]) {
      expect(Object.keys(o.technologyUsages ?? {})).toHaveLength(5)
      expect((o.description ?? '').length).toBeGreaterThan(10)
      expect(o.tagOrder.length).toBeGreaterThan(0)
      expect(Object.keys(o.tagAssignments)).toEqual(expect.arrayContaining(o.tagOrder))
    }
  })

  it('builds the C4 hierarchy with drill-down diagrams at levels 1/2/3', () => {
    expect(w.objects.filter((o) => o.type === 'system').length).toBeGreaterThan(0)
    expect(w.objects.filter((o) => o.type === 'component').every((o) => !!o.parentId)).toBe(true)
    expect(w.diagrams.some((d) => d.type === 'context')).toBe(true)
    expect(w.diagrams.some((d) => d.type === 'container' && !!d.parentObjectId)).toBe(true)
    expect(w.diagrams.some((d) => d.type === 'component' && !!d.parentObjectId)).toBe(true)
  })

  it('has at least one hub object with ~10000 connections', () => {
    const degree = new Map<string, number>()
    for (const c of w.connections) {
      degree.set(c.fromId, (degree.get(c.fromId) ?? 0) + 1)
      degree.set(c.toId, (degree.get(c.toId) ?? 0) + 1)
    }
    expect(Math.max(...degree.values())).toBeGreaterThanOrEqual(10000)
  })

  it('puts 100 comments on some diagrams and links ADRs to diagrams', () => {
    const perDiagram = new Map<string, number>()
    for (const c of w.comments) perDiagram.set(c.diagramId, (perDiagram.get(c.diagramId) ?? 0) + 1)
    expect(Math.max(...perDiagram.values())).toBe(100)
    const diagramIds = new Set(w.diagrams.map((d) => d.id))
    expect(w.decisionRecords.every((a) => a.related.length > 0)).toBe(true)
    expect(w.decisionRecords.some((a) => a.related.some((l) => l.type === 'diagram' && diagramIds.has(l.targetId!)))).toBe(true)
  })

  it('has some big diagrams (~100 objects)', () => {
    expect(w.diagrams.some((d) => d.objectIds.length >= 100)).toBe(true)
  })

  it('is deterministic for a given seed', () => {
    const w2 = generateRichWorkspace({ seed: 7 })
    expect(w2.objects[12345].id).toBe(w.objects[12345].id)
    expect(w2.connections.length).toBe(w.connections.length)
  })

  it('prefixes every id with rs- so __clearLoad removes it', () => {
    expect(w.objects.every((o) => o.id.startsWith('rs-'))).toBe(true)
    expect(w.connections.every((c) => c.id.startsWith('rs-'))).toBe(true)
    expect(w.diagrams.every((d) => d.id.startsWith('rs-'))).toBe(true)
  })
})
