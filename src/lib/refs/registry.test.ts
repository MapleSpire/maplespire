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
import {
  REFERENCE_REGISTRY,
  referenceDescriptor,
  referencesFrom,
  referencesInto,
} from './registry'

describe('reference registry', () => {
  it('gives every reference a unique id built from source and field', () => {
    const ids = REFERENCE_REGISTRY.map((entry) => entry.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const entry of REFERENCE_REGISTRY) {
      expect(entry.id.startsWith(`${entry.source}.`)).toBe(true)
    }
  })

  it('states a reason on every entry — the registry is the argument, not just the list', () => {
    for (const entry of REFERENCE_REGISTRY) {
      expect(entry.note.length, entry.id).toBeGreaterThan(20)
    }
  })

  it('marks every reference into a windowed collection as windowedTarget', () => {
    // The two collections that are bounded on the client: the ADR page (2 000)
    // and the diagram registry under a server-fed summary. Anything pointing at
    // them must be resolvable to `unknown`, which means lazy3.
    for (const entry of REFERENCE_REGISTRY) {
      if (!entry.windowedTarget) continue
      expect(entry.policy, entry.id).toBe('lazy3')
    }
  })

  it('never puts an eager sweep on a windowed target', () => {
    // An eager sweep over a collection the writer cannot enumerate is silently
    // partial — it looks correct and deletes half the references.
    const eager = REFERENCE_REGISTRY.filter((e) => e.policy === 'eager' || e.policy === 'tombstone')
    expect(eager.filter((e) => e.windowedTarget)).toEqual([])
  })

  it('gives snapshot and sanitize entries no local target to resolve', () => {
    // These are the exceptions: a foreign system or an external URL. If one
    // ever pointed at a model collection it would be a mis-classification.
    const modelCollections = new Set(['object', 'connection', 'group', 'diagram', 'decisionRecord', 'domain'])
    for (const entry of REFERENCE_REGISTRY) {
      if (entry.policy !== 'snapshot' && entry.policy !== 'sanitize') continue
      for (const target of entry.target.split('|')) {
        expect(modelCollections.has(target), entry.id).toBe(false)
      }
    }
  })

  it('declares both connection endpoints, including the group case', () => {
    // deleteGroup swept groupIds and left the connections behind for exactly as
    // long as nobody wrote this row down.
    for (const id of ['connection.fromId', 'connection.toId']) {
      const entry = referenceDescriptor(id)
      expect(entry?.target.split('|')).toEqual(['object', 'group'])
    }
  })

  it('indexes references by the collection they point into', () => {
    const intoGroup = referencesInto('group').map((e) => e.id)
    expect(intoGroup).toContain('diagram.groupIds')
    expect(intoGroup).toContain('connection.fromId')
    expect(intoGroup).toContain('connection.toId')
  })

  it('indexes references by the entity that owns them', () => {
    const fromDiagram = referencesFrom('diagram').map((e) => e.id)
    expect(fromDiagram).toContain('diagram.parentObjectId')
    expect(fromDiagram).not.toContain('comment.diagramId')
  })

  it('returns nothing for an id that is not declared', () => {
    expect(referenceDescriptor('object.nope')).toBeUndefined()
  })
})
