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
import { generateAutomergeUrl } from '@automerge/automerge-repo'
import { OVERLAY_WRITE_HEAD_VERSION, buildModelMeta } from './modelMeta.js'

const OBJECT_HEAD = generateAutomergeUrl()
const CONNECTION_HEAD = generateAutomergeUrl()

describe('buildModelMeta', () => {
  it('pins the protocol version at 1 — the SERVER job\'s own tripwire', () => {
    // Every other server test derives its expected version from the constant
    // (which catches a producer that re-hardcodes a digit), so without this
    // line a lone server bump would leave the whole server suite green.
    //
    // So each package pins its own copy, and
    // `src/lib/automerge/overlayWriteHead.conformance.test.ts` asserts the two
    // are EQUAL. Lone bump on either side → that side's pin plus the conformance
    // row. Coordinated bump → both pins, which is correct, because a coordinated
    // bump is a data migration: every ModelMeta in every database still holds
    // the old number. Discharge it with `scripts/repair-overlay-heads.ts` before
    // moving this literal.
    expect(OVERLAY_WRITE_HEAD_VERSION).toBe(1)
  })

  it('stamps the constant rather than a literal', () => {
    const meta = buildModelMeta({ objectWriteHead: OBJECT_HEAD, connectionWriteHead: CONNECTION_HEAD })
    expect(meta.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
  })

  it('throws when a head is missing — the branch TypeScript cannot reach', () => {
    // The guard's own comment scopes it to JS callers and to an `as any` at a
    // boundary, which is precisely the population the compiler does not cover —
    // so it is precisely the branch that needs a test.
    const good = { objectWriteHead: OBJECT_HEAD, connectionWriteHead: CONNECTION_HEAD }
    for (const missing of ['objectWriteHead', 'connectionWriteHead'] as const) {
      const seed = { ...good, [missing]: '' } as unknown as Parameters<typeof buildModelMeta>[0]
      expect(() => buildModelMeta(seed)).toThrow(/requires both overlay write heads/)
    }
    // Counter-control: the same call with both heads present must NOT throw, or
    // the two rows above would pass against a constructor that always throws.
    expect(() => buildModelMeta(good)).not.toThrow()
  })

  it('keeps the write head LAST in its base list', () => {
    // `forkRoot.remapModelMeta` remaps the head by its POSITION in this array
    // and yields `undefined` when the head is not found there, so a head kept
    // outside the list is silently lost by a fork.
    const base = generateAutomergeUrl()
    const meta = buildModelMeta({
      objectShardUrls: [base],
      connectionShardUrls: [base],
      objectWriteHead: OBJECT_HEAD,
      connectionWriteHead: CONNECTION_HEAD,
    })
    expect(meta.objectShardUrls).toEqual([base, OBJECT_HEAD])
    expect(meta.connectionShardUrls).toEqual([base, CONNECTION_HEAD])
  })

  it('de-duplicates a head the caller ALSO passed inside the base list', () => {
    // `ModelMetaSeed` documents that the constructor "appends it if it is
    // absent", i.e. a caller may legitimately include the head in its base
    // list. No production call site does, so nothing else exercises
    // `withHeadLast`'s `.filter(url => url !== head)`. Without it the duplicate would appear
    // TWICE in the base list, and the read model overlays that list in order.
    const meta = buildModelMeta({
      objectShardUrls: [OBJECT_HEAD],
      connectionShardUrls: [CONNECTION_HEAD],
      objectWriteHead: OBJECT_HEAD,
      connectionWriteHead: CONNECTION_HEAD,
    })
    expect(meta.objectShardUrls).toEqual([OBJECT_HEAD])
    expect(meta.connectionShardUrls).toEqual([CONNECTION_HEAD])
  })
})
