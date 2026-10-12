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

import { beforeEach, describe, expect, it } from 'vitest'
import type { C4Object, TagSnapshot } from '../types'
import { useModelStore } from './modelStore'

const object: C4Object = {
  id: 'orders', type: 'store', name: 'Orders', position: { x: 0, y: 0 }, size: { width: 180, height: 100 },
  tagAssignments: {}, tagOrder: [], scope: 'internal', status: 'live', properties: {},
}
const snapshot: TagSnapshot = {
  tagId: 'tag-risk-high', value: 'High', color: '#E05252', groupId: 'taggrp-risk',
  groupName: 'Risk', catalogRevision: 3,
}

describe('governed Tag assignment store', () => {
  beforeEach(() => useModelStore.setState({ objects: [{ ...object, tagAssignments: {}, tagOrder: [] }], tags: [] }))

  it('persists the stable assignment and its minimal offline snapshot together', () => {
    useModelStore.getState().addTagToObject('orders', snapshot.tagId, snapshot)
    const state = useModelStore.getState()
    expect(state.objects[0].tagAssignments).toEqual({ [snapshot.tagId]: { tagId: snapshot.tagId } })
    expect(state.objects[0].tagOrder).toEqual([snapshot.tagId])
    expect(state.tags).toEqual([snapshot])
  })

  it('updates the fallback revision without duplicating the assignment', () => {
    useModelStore.getState().addTagToObject('orders', snapshot.tagId, snapshot)
    useModelStore.getState().addTagToObject('orders', snapshot.tagId, {
      ...snapshot, value: 'Critical', catalogRevision: 4,
    })
    const state = useModelStore.getState()
    expect(state.objects[0].tagOrder).toEqual([snapshot.tagId])
    expect(state.tags).toHaveLength(1)
    expect(state.tags[0]).toMatchObject({ value: 'Critical', catalogRevision: 4 })
  })

  it('repairs a missing offline snapshot without changing any assignment', () => {
    useModelStore.setState({
      objects: [{ ...object, tagAssignments: { [snapshot.tagId]: { tagId: snapshot.tagId } }, tagOrder: [snapshot.tagId] }],
      tags: [],
    })

    useModelStore.getState().rememberTagSnapshots([snapshot])

    const state = useModelStore.getState()
    expect(state.tags).toEqual([snapshot])
    expect(state.objects[0].tagAssignments).toEqual({ [snapshot.tagId]: { tagId: snapshot.tagId } })
    expect(state.objects[0].tagOrder).toEqual([snapshot.tagId])
  })

  it('keeps normalized entity references stable so opening a diagram does not publish no-op edits', () => {
    const normalized = {
      ...object,
      tagAssignments: { [snapshot.tagId]: { tagId: snapshot.tagId } },
      tagOrder: [snapshot.tagId],
    }
    useModelStore.setState({ objects: [normalized], tags: [snapshot] })

    useModelStore.getState().reconcileTags()

    expect(useModelStore.getState().objects[0]).toBe(normalized)
  })
})
