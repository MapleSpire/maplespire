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
import { planStaticRegistryRootRepair } from './staticRegistryReferenceRepair.js'

const rootUrl = 'automerge:root' as never
const first = 'automerge:first' as never
const second = 'automerge:second' as never
const phantom = 'automerge:phantom' as never

describe('planStaticRegistryRootRepair', () => {
  it('trims only an unavailable suffix beyond the projected diagram cardinality', () => {
    expect(planStaticRegistryRootRepair({
      landscapeId: 'landscape',
      versionId: 'version',
      rootUrl,
      source: 'performance-seed-editable',
      diagramCount: 400,
      shardUrls: [first, second, phantom],
      storedUrls: new Set([first, second]),
    })).toMatchObject({
      requiredRegistryCount: 2,
      currentRegistryCount: 3,
      retainedUrls: [first, second],
      removedUrls: [phantom],
    })
  })

  it('refuses to hide a hole in the required durable prefix', () => {
    expect(planStaticRegistryRootRepair({
      landscapeId: 'landscape',
      versionId: 'version',
      rootUrl,
      source: 'performance-seed-editable',
      diagramCount: 400,
      shardUrls: [first, phantom, second],
      storedUrls: new Set([first, second]),
    })).toBeNull()
  })

  it('refuses to discard a durable suffix or touch an unknown source', () => {
    const base = {
      landscapeId: 'landscape', versionId: 'version', rootUrl,
      diagramCount: 200, shardUrls: [first, second], storedUrls: new Set([first, second]),
    }
    expect(planStaticRegistryRootRepair({ ...base, source: 'performance-seed-editable' })).toBeNull()
    expect(planStaticRegistryRootRepair({ ...base, source: 'unknown', storedUrls: new Set([first]) })).toBeNull()
  })
})
