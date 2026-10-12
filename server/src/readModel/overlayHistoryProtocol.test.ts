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
import { change, clone, from, getObjectId, merge } from '@automerge/automerge'
import {
  applyResolvedEntityConflicts,
  canonicalOverlayDocumentIds,
  collectAutomergeEntityConflicts,
  isAppendOnlyOverlayOrder,
  mergeConcurrentAutomergeEntity,
  preserveCurrentConflictPaths,
  requiresWholeEntityConflictHealing,
  threeWayMergeOverlayEntity,
  wholeEntityConflictIds,
} from './overlayHistoryProtocol.js'

describe('overlay history protocol', () => {
  it('canonicalizes the current head last without duplicates', () => {
    expect(canonicalOverlayDocumentIds(['old', 'current', 'middle', 'old'], 'current'))
      .toEqual(['old', 'middle', 'current'])
  })

  it('recognizes only prefix-preserving append order', () => {
    expect(isAppendOnlyOverlayOrder(['old', 'current'], ['old', 'current', 'next'])).toBe(true)
    expect(isAppendOnlyOverlayOrder(['old', 'current'], ['current', 'old', 'next'])).toBe(false)
    expect(isAppendOnlyOverlayOrder(['old', 'current'], ['old'])).toBe(false)
  })

  it('forwards independent offline and online fields', () => {
    const base = { id: 'o1', name: 'Base', properties: { owner: 'A', tier: '1' } }
    const result = threeWayMergeOverlayEntity(
      base,
      { ...base, name: 'Offline' },
      { ...base, properties: { owner: 'B', tier: '1' } },
    )
    expect(result).toEqual({
      value: { id: 'o1', name: 'Offline', properties: { owner: 'B', tier: '1' } },
      changed: true,
      conflicts: [],
    })
  })

  it('keeps the published field and records a same-field conflict', () => {
    const result = threeWayMergeOverlayEntity(
      { id: 'o1', name: 'Base', description: 'stable' },
      { id: 'o1', name: 'Offline', description: 'offline detail' },
      { id: 'o1', name: 'Online', description: 'stable' },
    )
    expect(result.value).toEqual({ id: 'o1', name: 'Online', description: 'offline detail' })
    expect(result.conflicts).toEqual(['name'])
  })

  it('handles delete, recreate and delete-vs-edit explicitly', () => {
    const base = { id: 'o1', name: 'Base' }
    expect(threeWayMergeOverlayEntity(base, undefined, base)).toMatchObject({
      value: undefined, changed: true, conflicts: [],
    })
    expect(threeWayMergeOverlayEntity(undefined, { id: 'o1', name: 'Recreated' }, undefined))
      .toMatchObject({ value: { id: 'o1', name: 'Recreated' }, changed: true, conflicts: [] })
    expect(threeWayMergeOverlayEntity(base, undefined, { id: 'o1', name: 'Online' }))
      .toMatchObject({ value: { id: 'o1', name: 'Online' }, changed: false, conflicts: ['$'] })
  })

  it('detects a real concurrent Automerge field conflict hidden by JSON', () => {
    const base = from({ objects: { o1: { id: 'o1', name: 'Base', description: 'stable' } } })
    const offline = change(clone(base), (doc) => {
      doc.objects.o1.name = 'Offline'
      doc.objects.o1.description = 'offline detail'
    })
    const online = change(clone(base), (doc) => { doc.objects.o1.name = 'Online' })
    const reunited = merge(online, offline)
    const conflicts = collectAutomergeEntityConflicts(reunited.objects)

    expect(conflicts.get('o1')?.name?.sort()).toEqual(['Offline', 'Online'])
    expect(requiresWholeEntityConflictHealing(conflicts)).toBe(false)
    expect(preserveCurrentConflictPaths(
      { id: 'o1', name: 'Offline', description: 'offline detail' },
      { id: 'o1', name: 'Online', description: 'stable' },
      ['name'],
    )).toEqual({ id: 'o1', name: 'Online', description: 'offline detail' })
  })

  it('resolves a contended field in place without orphaning concurrent entity edits', () => {
    const baseValue = { id: 'o1', name: 'Base', hot: 'seed', u0: '', u1: '' }
    const base = from({ objects: { o1: baseValue } })
    const left = change(clone(base), (doc) => {
      doc.objects.o1.u0 = 'r3'
      doc.objects.o1.hot = 'left'
    })
    const right = change(clone(base), (doc) => {
      doc.objects.o1.u1 = 'r3'
      doc.objects.o1.hot = 'right'
    })
    const reunited = merge(right, left)
    const conflicts = collectAutomergeEntityConflicts(reunited.objects)
    const objectId = getObjectId(reunited.objects.o1)
    const resolution = mergeConcurrentAutomergeEntity(
      baseValue,
      { ...baseValue, hot: 'published' },
      reunited.objects.o1,
      conflicts.get('o1')!,
    )

    const healed = change(reunited, (doc) => {
      applyResolvedEntityConflicts(doc.objects, 'o1', resolution.value, conflicts.get('o1')!)
    })

    expect(getObjectId(healed.objects.o1)).toBe(objectId)
    expect(healed.objects.o1).toMatchObject({ u0: 'r3', u1: 'r3', hot: 'published' })
    expect(collectAutomergeEntityConflicts(healed.objects)).toEqual(new Map())
  })

  it('merges disjoint fields when two clients concurrently create one sparse overlay key', () => {
    const baseValue = { id: 'o1', name: 'Base', description: 'stable', type: 'app' }
    const empty = from({ objects: {} as Record<string, typeof baseValue> })
    const offline = change(clone(empty), (doc) => {
      doc.objects.o1 = { ...baseValue, name: 'Offline' }
    })
    const online = change(clone(empty), (doc) => {
      doc.objects.o1 = { ...baseValue, description: 'Remote' }
    })
    const reunited = merge(online, offline)
    const selected = reunited.objects.o1
    const conflicts = collectAutomergeEntityConflicts(reunited.objects)

    expect(conflicts.get('o1')?.$).toHaveLength(2)
    expect(requiresWholeEntityConflictHealing(conflicts)).toBe(true)
    expect(mergeConcurrentAutomergeEntity(
      baseValue,
      { ...baseValue, description: 'Remote' },
      selected,
      conflicts.get('o1')!,
    )).toEqual({
      value: { ...baseValue, name: 'Offline', description: 'Remote' },
      changed: JSON.stringify(selected) !== JSON.stringify({
        ...baseValue, name: 'Offline', description: 'Remote',
      }),
      conflicts: [],
    })
  })

  it('keeps the published value and reports a concurrent same-field sparse edit', () => {
    const baseValue = { id: 'o1', name: 'Base', description: 'stable' }
    const result = mergeConcurrentAutomergeEntity(
      baseValue,
      { ...baseValue, name: 'Online' },
      { ...baseValue, name: 'Offline' },
      { $: [
        { ...baseValue, name: 'Offline' },
        { ...baseValue, name: 'Online' },
      ] },
    )
    expect(result.value).toEqual({ ...baseValue, name: 'Online' })
    expect(result.conflicts).toEqual(['name'])
  })

  // ABSENCE IS NOT A VALUE.
  // "The read model has not published this yet" must never be read as "this is
  // absent" — neither as a base nor as a leaf.

  it('never deletes a leaf at an EXPLICIT conflict path when the published value has no opinion on it', () => {
    // An explicit Automerge conflict means the document holds two or more SET
    // values for that field. A published value that lacks the field predates
    // both writes; it is not a deletion. Deleting the leaf here would let
    // `applyResolvedEntityConflicts` transcribe that deletion into the CRDT —
    // both writers' values gone from every peer.
    expect(preserveCurrentConflictPaths(
      { id: 'o1', name: 'Base', hot: 'u1-r0', u1: 'r0' },
      { id: 'o1', name: 'Base' },
      ['hot'],
    )).toEqual({ id: 'o1', name: 'Base', hot: 'u1-r0', u1: 'r0' })
    // Nothing published at all (the entity's first tick): same rule.
    expect(preserveCurrentConflictPaths(
      { id: 'o1', name: 'Base', hot: 'u1-r0' },
      undefined,
      ['hot'],
    )).toEqual({ id: 'o1', name: 'Base', hot: 'u1-r0' })
    // A published value that HAS the field still wins.
    expect(preserveCurrentConflictPaths(
      { id: 'o1', hot: 'u1-r0' },
      { id: 'o1', hot: 'published' },
      ['hot'],
    )).toEqual({ id: 'o1', hot: 'published' })
  })

  it('merges two concurrent CREATIONS of one key as a union when there is no base — the base of a creation is the empty record', () => {
    // An overlay-born entity has a base row saying "did not exist"
    // (`captureOverlayEntityBases` at its first projection), so `base` is
    // undefined here. The merge must not simply keep whatever was published,
    // which would discard BOTH concurrent replacements.
    const published = { id: 'o10', type: 'app', name: 'Ten' }
    const left = { id: 'o10', type: 'app', name: 'Ten', fromLeft: 'L' }
    const right = { id: 'o10', type: 'app', name: 'Ten', fromRight: 'R' }
    const result = mergeConcurrentAutomergeEntity(undefined, published, right, { $: [left, right] })
    expect(result.value).toEqual({ id: 'o10', type: 'app', name: 'Ten', fromLeft: 'L', fromRight: 'R' })
    expect(result.conflicts).toEqual([])

    // Same field written differently by both creators: the published value wins
    // where it has one, and the conflict is REPORTED, not silently resolved.
    const contested = mergeConcurrentAutomergeEntity(
      undefined,
      { id: 'o10', type: 'app', name: 'Ten' },
      { id: 'o10', type: 'app', name: 'Right' },
      { $: [{ id: 'o10', type: 'app', name: 'Left' }, { id: 'o10', type: 'app', name: 'Right' }] },
    )
    expect(contested.value).toEqual({ id: 'o10', type: 'app', name: 'Ten' })
    expect(contested.conflicts).toEqual(['name'])
  })

  it('merges two concurrent creations as a union when NOTHING was published yet either', () => {
    // The projector's first sight of the key is already the `$` conflict: no
    // base, no current. Both branches must survive, not just the first.
    const left = { id: 'o11', type: 'app', name: 'Eleven', fromLeft: 'L' }
    const right = { id: 'o11', type: 'app', name: 'Eleven', fromRight: 'R' }
    const result = mergeConcurrentAutomergeEntity(undefined, undefined, left, { $: [left, right] })
    expect(result.value).toEqual({ id: 'o11', type: 'app', name: 'Eleven', fromLeft: 'L', fromRight: 'R' })
    expect(result.conflicts).toEqual([])
  })

  it('names the entities that carry a `$` conflict — the ONLY ones a server heal may write', () => {
    const conflicts = new Map<string, Record<string, unknown[]>>([
      ['same-field-only', { hot: ['a', 'b'] }],
      ['whole', { $: [{ id: 'whole' }, { id: 'whole', x: 1 }] }],
      ['whole-and-field', { $: [{ id: 'w2' }, { id: 'w2' }], 'name': ['a', 'b'] }],
    ])
    expect(wholeEntityConflictIds(conflicts)).toEqual(['whole', 'whole-and-field'])
    expect(requiresWholeEntityConflictHealing(conflicts)).toBe(true)
    expect(wholeEntityConflictIds(new Map([['o1', { hot: ['a', 'b'] }]]))).toEqual([])
  })
})
