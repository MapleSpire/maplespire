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
import { validateCreateVersion } from './landscapeVersions.js'

const okManifest = { schema: 1, capturedAt: 'now', landscapeId: 'default', versionId: 'current', docs: [] }

describe('validateCreateVersion', () => {
  it('accepts a well-formed payload', () => {
    expect(validateCreateVersion({ label: 'v1', manifest: okManifest })).toBeNull()
    expect(validateCreateVersion({ label: 'v1', kind: 'named', manifest: okManifest })).toBeNull()
  })

  it('rejects a missing/blank label', () => {
    expect(validateCreateVersion({ manifest: okManifest })).toMatch(/label/)
    expect(validateCreateVersion({ label: '   ', manifest: okManifest })).toMatch(/label/)
  })

  it('rejects an over-long label', () => {
    expect(validateCreateVersion({ label: 'x'.repeat(201), manifest: okManifest })).toMatch(/too long/)
  })

  it('rejects a missing manifest', () => {
    expect(validateCreateVersion({ label: 'v1' })).toMatch(/manifest/)
  })

  it('rejects a non-object body', () => {
    expect(validateCreateVersion(null)).toMatch(/invalid body/)
    expect(validateCreateVersion('nope')).toMatch(/invalid body/)
  })

  it('rejects a non-string kind', () => {
    expect(validateCreateVersion({ label: 'v1', kind: 5, manifest: okManifest })).toMatch(/kind/)
  })
})
