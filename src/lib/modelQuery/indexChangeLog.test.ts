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
import {
  __resetModelIndexVersionForTest,
  notifyServerInvalidation,
  changedIds,
  modelIndexChangesSince,
  notifyModelIndexChanged,
  useModelIndexVersion,
} from './indexSync'
import type { C4Object, Connection } from '../../types'

beforeEach(() => __resetModelIndexVersionForTest())

const sorted = (change: ReturnType<typeof modelIndexChangesSince>) =>
  change && { objectIds: [...change.objectIds].sort(), connectionIds: [...change.connectionIds].sort() }

describe('model index change log', () => {
  it('unions what every revision since a version touched', () => {
    notifyModelIndexChanged({ objectIds: ['a'], connectionIds: [] })
    notifyModelIndexChanged({ objectIds: ['b', 'a'], connectionIds: ['c1'] })
    expect(sorted(modelIndexChangesSince(0))).toEqual({ objectIds: ['a', 'b'], connectionIds: ['c1'] })
    expect(sorted(modelIndexChangesSince(1))).toEqual({ objectIds: ['a', 'b'], connectionIds: ['c1'] })
    expect(modelIndexChangesSince(2)).toEqual({ objectIds: [], connectionIds: [] })
  })

  it('is unknown (null) when any revision in the window carried no ids', () => {
    notifyModelIndexChanged({ objectIds: ['a'], connectionIds: [] })
    notifyModelIndexChanged()
    notifyModelIndexChanged({ objectIds: ['b'], connectionIds: [] })
    expect(modelIndexChangesSince(0)).toBeNull()
    expect(sorted(modelIndexChangesSince(2))).toEqual({ objectIds: ['b'], connectionIds: [] })
  })

  it('is unknown when the log no longer reaches back', () => {
    for (let i = 0; i < 70; i++) notifyModelIndexChanged({ objectIds: [`o${i}`], connectionIds: [] })
    expect(modelIndexChangesSince(0), 'the first revisions fell out of the log').toBeNull()
    expect(modelIndexChangesSince(69)).toEqual({ objectIds: ['o69'], connectionIds: [] })
  })

  it('is unknown for a version set without a log entry', () => {
    useModelIndexVersion.setState({ version: 3 })
    expect(modelIndexChangesSince(0)).toBeNull()
  })

  it('names every id a delta touches, groups among the objects', () => {
    expect(changedIds({
      upsertObjects: [{ id: 'o1' } as C4Object],
      removeObjectIds: ['o2'],
      upsertGroups: [{ id: 'g1' } as never],
      removeGroupIds: ['g2'],
      addConnections: [{ id: 'c1' } as Connection],
      removeConnections: [{ id: 'c2' } as Connection],
    })).toEqual({ objectIds: ['o1', 'o2', 'g1', 'g2'], connectionIds: ['c1', 'c2'] })
  })

  it('can leave out id-less SERVER invalidations, but never another id-less revision', () => {
    notifyModelIndexChanged({ objectIds: ['a'], connectionIds: [] })
    notifyModelIndexChanged(undefined, 'server-invalidation')
    expect(modelIndexChangesSince(0)).toBeNull()
    expect(modelIndexChangesSince(0, { skipServerInvalidations: true })).toEqual({ objectIds: ['a'], connectionIds: [] })
    notifyModelIndexChanged()
    expect(modelIndexChangesSince(0, { skipServerInvalidations: true })).toBeNull()
  })

  it('a server invalidation is an id-less revision that a feed consumer can leave out', () => {
    notifyModelIndexChanged({ objectIds: ['a'], connectionIds: [] })
    notifyServerInvalidation()
    expect(modelIndexChangesSince(0)).toBeNull()
    expect(modelIndexChangesSince(0, { skipServerInvalidations: true })).toEqual({ objectIds: ['a'], connectionIds: [] })
  })
})
