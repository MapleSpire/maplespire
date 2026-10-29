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
import { interpretAsDocumentId, Repo, type BinaryDocumentId } from '@automerge/automerge-repo'
import { isMintedDocumentId } from './repo'
import * as server from '../../../server/src/rbac/documentIdMint.js'

// The browser decides from an id's FORMAT whether the server can claim the
// document before anything points at it — which decides whether a pointer to
// it may be held back (deferredReferences.ts). Its constants mirror the
// server's; this pins them against ids the server really mints.

const WORKSPACE = { landscapeId: 'L1', versionId: 'V1' }

describe('isMintedDocumentId (browser) agrees with the server mint', () => {
  it('recognises ids the server mints', () => {
    for (let i = 0; i < 20; i++) {
      const id = interpretAsDocumentId(server.mintDocumentIdBytes(WORKSPACE, 'parity-secret') as BinaryDocumentId)
      expect(isMintedDocumentId(id)).toBe(true)
      expect(server.isMintedDocumentId(id)).toBe(true)
    }
  })

  it('rejects the random ids a browser creates without a reserve', () => {
    const repo = new Repo({ network: [] })
    for (let i = 0; i < 20; i++) {
      const id = repo.create({}).documentId
      expect(isMintedDocumentId(id)).toBe(false)
      expect(server.isMintedDocumentId(id)).toBe(false)
    }
  })

  it('rejects a minted-length id of another version', () => {
    const bytes = server.mintDocumentIdBytes(WORKSPACE, 'parity-secret')
    bytes[0] = server.MINT_VERSION + 1
    const id = interpretAsDocumentId(bytes as BinaryDocumentId)
    expect(isMintedDocumentId(id)).toBe(false)
    expect(server.isMintedDocumentId(id)).toBe(false)
  })
})
