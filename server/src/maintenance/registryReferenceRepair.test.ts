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
import { classifyMissingRegistryReference } from './registryReferenceRepair.js'

describe('registry reference repair', () => {
  it('removes only references absent from storage ownership and projection', () => {
    expect(classifyMissingRegistryReference({ mapped: false, projected: false })).toEqual({
      mapped: false,
      projected: false,
      safeToRemove: true,
    })
    expect(classifyMissingRegistryReference({ mapped: true, projected: false }).safeToRemove).toBe(false)
    expect(classifyMissingRegistryReference({ mapped: false, projected: true }).safeToRemove).toBe(false)
  })
})
