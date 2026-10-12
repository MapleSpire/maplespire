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
import { useModelStore, getDiagramIndex } from './modelStore'
import type { C4Object, Diagram } from '../types'

/**
 * getRelatedDiagrams used to cost O(D) TWICE per call — a `diagrams.find` per
 * reverse posting, and an unindexed full scan for the detail+parent buckets —
 * and the canvas pays it once per visible shape. At 50k diagrams and 500 shapes
 * that is ~10^8 iterations per fire, on a trigger (a layout change) that cannot
 * alter membership.
 *
 * Behaviour tests alone would not have caught it: the answers were correct, only
 * the cost was wrong. So the scale test below asserts on WORK, by counting how
 * many diagrams the call actually touches.
 */

const obj = (id: string, over: Partial<C4Object> = {}): C4Object => ({
  id, type: 'app', name: id, position: { x: 0, y: 0 }, size: { width: 1, height: 1 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {}, ...over,
})
const dg = (id: string, over: Partial<Diagram> = {}): Diagram => ({
  id, name: id, type: 'container', objectIds: [], connectionIds: [], groupIds: [], ...over,
})

beforeEach(() => {
  useModelStore.setState({
    objects: [], connections: [], groups: [], diagrams: [], domains: [], flows: [],
    currentDiagramId: null, selectedItems: [],
  })
})

describe('getRelatedDiagrams buckets', () => {
  beforeEach(() => {
    useModelStore.setState({
      objects: [obj('shop'), obj('web', { parentId: 'shop' })],
      diagrams: [
        dg('ctx', { type: 'context', objectIds: ['shop'] }),
        // Deliberately does NOT contain 'web': a diagram that contains the
        // object is a `reference`, and reference takes precedence, which would
        // mask the `parent` bucket being tested below.
        dg('shopDetail', { parentObjectId: 'shop' }),
        dg('webDetail', { type: 'component', parentObjectId: 'web' }),
        dg('other', { objectIds: ['shop'] }),
      ],
      currentDiagramId: 'shopDetail',
    })
  })

  it('puts diagrams that CONTAIN the object in reference', () => {
    const r = useModelStore.getState().getRelatedDiagrams('shop')
    expect(r.reference.map((d) => d.id).sort()).toEqual(['ctx', 'other'])
  })

  it('puts diagrams that DETAIL the object in detail', () => {
    const r = useModelStore.getState().getRelatedDiagrams('web')
    expect(r.detail.map((d) => d.id)).toEqual(['webDetail'])
  })

  it('puts diagrams detailing the object PARENT in parent', () => {
    // 'web' has parentId 'shop'; 'shopDetail' details 'shop' — but it is the
    // current diagram, so it is excluded everywhere.
    useModelStore.setState({ currentDiagramId: 'ctx' })
    const r = useModelStore.getState().getRelatedDiagrams('web')
    expect(r.parent.map((d) => d.id)).toEqual(['shopDetail'])
  })

  it('never returns the current diagram in any bucket', () => {
    const r = useModelStore.getState().getRelatedDiagrams('shop')
    const all = [...r.detail, ...r.reference, ...r.parent].map((d) => d.id)
    expect(all).not.toContain('shopDetail')
  })

  it('reports a diagram in exactly one bucket, reference first', () => {
    // 'ctx' both contains 'shop' and could match nothing else; pin the
    // precedence the other three tier implementations also apply.
    useModelStore.setState({
      diagrams: [
        dg('ctx', { type: 'context', objectIds: ['shop'], parentObjectId: 'shop' }),
        dg('cur'),
      ],
      currentDiagramId: 'cur',
    })
    const r = useModelStore.getState().getRelatedDiagrams('shop')
    expect(r.reference.map((d) => d.id)).toEqual(['ctx'])
    expect(r.detail).toEqual([])
  })

  it('returns empty buckets for an object that is not in the model', () => {
    expect(useModelStore.getState().getRelatedDiagrams('ghost'))
      .toEqual({ detail: [], reference: [], parent: [] })
  })
})

describe('getRelatedDiagrams cost', () => {
  it('does not scale with the number of diagrams in the landscape', () => {
    // 5,000 unrelated diagrams plus a handful that actually relate. A correct
    // implementation touches only the related ones; the old one iterated all
    // 5,000 twice over.
    const D = 5000
    const diagrams: Diagram[] = [dg('cur')]
    for (let i = 0; i < D; i++) diagrams.push(dg(`noise${i}`, { objectIds: [`x${i}`] }))
    diagrams.push(dg('ctx', { type: 'context', objectIds: ['shop'] }))
    diagrams.push(dg('shopDetail', { parentObjectId: 'shop' }))

    useModelStore.setState({
      objects: [obj('shop')],
      diagrams,
      currentDiagramId: 'cur',
    })

    // Count how many diagrams the call actually inspects, by making `id` a
    // counting getter on every diagram in the store.
    const idx = getDiagramIndex()
    let touched = 0
    for (const d of idx.diagramById.values()) {
      const id = d.id
      Object.defineProperty(d, 'id', { get() { touched++; return id }, configurable: true })
    }

    const r = useModelStore.getState().getRelatedDiagrams('shop')

    expect(r.reference.map((d) => d.id).length).toBe(1)
    expect(r.detail.length).toBe(1)
    // Two related diagrams; the reads are theirs plus a small constant. If the
    // O(D) scan ever returns, this lands in the thousands.
    expect(touched).toBeLessThan(50)
  })

  it('indexes every diagram that details an object, not just the first', () => {
    useModelStore.setState({
      objects: [obj('shop')],
      diagrams: [
        dg('cur'),
        dg('a', { parentObjectId: 'shop' }),
        dg('b', { parentObjectId: 'shop' }),
      ],
      currentDiagramId: 'cur',
    })
    const r = useModelStore.getState().getRelatedDiagrams('shop')
    expect(r.detail.map((d) => d.id).sort()).toEqual(['a', 'b'])
  })

  it('rebuilds the parent index when a diagram stops detailing an object', () => {
    useModelStore.setState({
      objects: [obj('shop')],
      diagrams: [dg('cur'), dg('a', { parentObjectId: 'shop' })],
      currentDiagramId: 'cur',
    })
    expect(useModelStore.getState().getRelatedDiagrams('shop').detail).toHaveLength(1)

    useModelStore.setState({ diagrams: [dg('cur'), dg('a')] })
    expect(useModelStore.getState().getRelatedDiagrams('shop').detail).toHaveLength(0)
  })
})
