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

/**
 * The wire round trip: an id minted by the server, encoded the way the mint
 * endpoint puts it on the wire (base64), decoded the way the browser reserve
 * decodes it (atob, byte for byte — src/lib/automerge/mintedIdReserve.ts), named the way
 * `createHandleNamed` names it (`interpretAsDocumentId` = bs58check), arrives
 * at the route gate in EXACTLY the form `verifyDocumentId` knows how to
 * decode. Any encoding desynchronisation across those four hops — truncation
 * to 16 bytes, URL-safe base64, a double encode — turns `bound` into
 * `unminted`/`foreign` and this test fails.
 */
import { describe, it, expect } from 'vitest'
import { interpretAsDocumentId, type BinaryDocumentId } from '@automerge/automerge-repo'
import { mintDocumentIdBytes, encodeMintedIdForWire, verifyDocumentId, MINTED_ID_BYTES } from './documentIdMint.js'

describe('minted document ids — browser wire round trip', () => {
  it('a browser-named id (base64 → bs58check) verifies bound for its workspace', () => {
    const SECRET = 'wire-round-trip-secret'
    const workspace = { landscapeId: 'L-wire', versionId: 'V-wire' }
    const sibling = { landscapeId: 'L-wire', versionId: 'V-sibling' }

    // Hop 1 — the endpoint's OWN encoder (index.ts calls this same function),
    // so the endpoint's encoding line is under this test, not a copy of it.
    const onTheWire = encodeMintedIdForWire(mintDocumentIdBytes(workspace, SECRET))

    // Hop 2 — the reserve's decoding (mintedIdReserve.decode: atob, char codes).
    const binary = atob(onTheWire)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    expect(bytes.length).toBe(MINTED_ID_BYTES)

    // Hop 3 — the naming (repo.ts importDocumentNamed: interpretAsDocumentId
    // = bs58check.encode of the raw 24 bytes).
    const docId = String(interpretAsDocumentId(bytes as BinaryDocumentId))

    // Hop 4 — the gate. The MAC must answer `bound` for the minting
    // workspace, and the same string must read `foreign` for a sibling —
    // never `unminted`, which would mean the format got mangled in transit.
    expect(verifyDocumentId(workspace, docId, SECRET).kind).toBe('bound')
    expect(verifyDocumentId(sibling, docId, SECRET).kind).toBe('foreign')
  })
})
