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

describe('Automerge repo environment guards', () => {
  it('loads without an IndexedDB or window implementation', async () => {
    expect(globalThis.indexedDB).toBeUndefined()
    expect(globalThis.window).toBeUndefined()

    const module = await import('./repo')

    expect(module.repo).toBeDefined()
  })
})
