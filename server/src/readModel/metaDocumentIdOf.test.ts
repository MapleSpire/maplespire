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

import { ImmutableString, generateAutomergeUrl, parseAutomergeUrl } from '@automerge/automerge-repo'
import { describe, expect, it } from 'vitest'
import { metaDocumentIdOf } from './projectorService.js'

/**
 * G4-16f: `metaIsCurrent` compares the ModelMeta the
 * ROOT names with the one a writer holds BY DOCUMENT ID, so a root spelling
 * the same meta non-canonically is not mistaken for a repoint — which would
 * silently stop the rotator and the fold writer on a workspace nobody rolled.
 */
describe('metaDocumentIdOf — the normalisation behind metaIsCurrent', () => {
  const url = generateAutomergeUrl()
  const id = String(parseAutomergeUrl(url).documentId)

  it('every spelling of one ModelMeta is the same document id', () => {
    expect(metaDocumentIdOf(url)).toBe(id)
    expect(metaDocumentIdOf(new ImmutableString(url))).toBe(id)
    expect(metaDocumentIdOf(`${url}?via=root`)).toBe(id)
    expect(metaDocumentIdOf(id)).toBe(id)
  })

  it('a different meta is a different id; an absent pointer is none', () => {
    expect(metaDocumentIdOf(generateAutomergeUrl())).not.toBe(id)
    expect(metaDocumentIdOf('')).toBeNull()
    expect(metaDocumentIdOf(undefined)).toBeNull()
    expect(metaDocumentIdOf(null)).toBeNull()
  })
})
