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
import { showsExternalUsage } from './externalUsage'

const row = (scope: 'internal' | 'external' | undefined, external: number | undefined, total: number, isGroup = false) =>
  ({ scope, externalDiagramCount: external, diagramCount: total, isGroup })

describe('showsExternalUsage — "External in N of M diagrams" only where it departs from the default', () => {
  it('shows an internal default that is external somewhere', () => {
    expect(showsExternalUsage(row('internal', 1, 3))).toBe(true)
    expect(showsExternalUsage(row('internal', 0, 3))).toBe(false)
  })

  it('shows an external default that some diagram overrides to internal', () => {
    expect(showsExternalUsage(row('external', 2, 3))).toBe(true)
    expect(showsExternalUsage(row('external', 3, 3))).toBe(false)
  })

  it('shows nothing for a group, an object on no diagram, or a source that cannot count', () => {
    expect(showsExternalUsage(row(undefined, 1, 2, true))).toBe(false)
    expect(showsExternalUsage(row('internal', 0, 0))).toBe(false)
    expect(showsExternalUsage(row('internal', undefined, 2))).toBe(false)
  })
})
