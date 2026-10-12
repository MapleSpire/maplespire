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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { Repo } from '@automerge/automerge-repo'
import { interpretAsDocumentId, isValidAutomergeUrl, stringifyAutomergeUrl } from '@automerge/automerge-repo'
import {
  mintDocumentIdBytes, verifyDocumentId, verifyDocumentIdWithDisplacement,
  MINTED_ID_BYTES, MINT_VERSION,
  DISPLACED_SCAN_MAX_CANDIDATES, displacedScanTruncationsTotal,
} from './documentIdMint.js'

const SECRET = 'test-mint-secret'
const A = { landscapeId: 'L-a', versionId: 'V-a' }
const B = { landscapeId: 'L-b', versionId: 'V-b' }

/** Mints through the real encoder, reached the way the client produces these
 * ids: `create2` with an `idFactory`.
 *
 * `secret: null` means "mint the way production does" — from the environment.
 * A default parameter cannot express that: `undefined` selects the default,
 * which would silently test the fixed test key instead of the env. */
async function mintedDocumentId(workspace = A, secret: string | null = SECRET): Promise<string> {
  const repo = new Repo({ idFactory: async () => mintDocumentIdBytes(workspace, secret ?? undefined) })
  const handle = await repo.create2({ hello: 'world' })
  return String(handle.documentId)
}

describe('workspace-bound document ids', () => {
  it('binds a minted id to the workspace it was minted for', async () => {
    const id = await mintedDocumentId(A)
    expect(verifyDocumentId(A, id, SECRET)).toEqual({ kind: 'bound' })
  })

  // The whole point. A peer routed to B presenting an id minted for A must not
  // be admitted, and must not fall through to the index either — the id CLAIMS
  // a binding, and the binding is not to B.
  it('refuses another workspace an id minted for A, and does not call it unminted', async () => {
    const id = await mintedDocumentId(A)
    expect(verifyDocumentId(B, id, SECRET)).toEqual({ kind: 'foreign' })
  })

  it('refuses an id minted under a key that was never ours', async () => {
    const id = await mintedDocumentId(A, 'a-different-secret')
    expect(verifyDocumentId(A, id, SECRET)).toEqual({ kind: 'foreign' })
  })

  // KEY ROTATION. The test above and these differ by one thing — whether the
  // other key WAS ours. Verifying under the current secret alone would make
  // every already-minted id return `foreign` after a rotation, which the gate
  // turns into a hard deny with no index fallback. The cases use two different
  // NON-EMPTY secrets on purpose: removing the key is a different scenario.
  describe('key rotation', () => {
    const OLD = 'the-retired-secret'
    const NEW = 'the-current-secret'
    let saved: { current?: string; previous?: string }
    beforeEach(() => {
      saved = { current: process.env.AUTH_SECRET, previous: process.env.AUTH_SECRET_PREVIOUS }
    })
    afterEach(() => {
      if (saved.current === undefined) delete process.env.AUTH_SECRET
      else process.env.AUTH_SECRET = saved.current
      if (saved.previous === undefined) delete process.env.AUTH_SECRET_PREVIOUS
      else process.env.AUTH_SECRET_PREVIOUS = saved.previous
    })

    it('honours an id minted under the retired key while it is still declared', async () => {
      const beforeRotation = await mintedDocumentId(A, OLD)
      process.env.AUTH_SECRET = NEW
      process.env.AUTH_SECRET_PREVIOUS = OLD
      expect(verifyDocumentId(A, beforeRotation)).toEqual({ kind: 'bound' })
    })

    it('mints only under the current key, never a retired one', async () => {
      process.env.AUTH_SECRET = NEW
      process.env.AUTH_SECRET_PREVIOUS = OLD
      const minted = await mintedDocumentId(A, null)
      expect(verifyDocumentId(A, minted, NEW)).toEqual({ kind: 'bound' })
      expect(verifyDocumentId(A, minted, OLD)).toEqual({ kind: 'foreign' })
    })

    it('still binds the workspace across the overlap — a retired key is not a skeleton key', async () => {
      const beforeRotation = await mintedDocumentId(A, OLD)
      process.env.AUTH_SECRET = NEW
      process.env.AUTH_SECRET_PREVIOUS = OLD
      expect(verifyDocumentId(B, beforeRotation)).toEqual({ kind: 'foreign' })
    })

    it('refuses the retired key once it is withdrawn', async () => {
      const beforeRotation = await mintedDocumentId(A, OLD)
      process.env.AUTH_SECRET = NEW
      delete process.env.AUTH_SECRET_PREVIOUS
      expect(verifyDocumentId(A, beforeRotation)).toEqual({ kind: 'foreign' })
    })

    it('ignores blank entries rather than deriving a key every deployment shares', async () => {
      const id = await mintedDocumentId(A, NEW)
      process.env.AUTH_SECRET = NEW
      process.env.AUTH_SECRET_PREVIOUS = '  , ,'
      expect(verifyDocumentId(A, id)).toEqual({ kind: 'bound' })
      // The blank entries must not have become keys of their own: an id minted
      // under the empty string would then verify. It cannot even be produced —
      // `mintKeys('')` falls through to the environment because '' is falsy —
      // so assert the derived set directly instead of pretending otherwise.
      const derivedFromBlank = await mintedDocumentId(A, ' ')
      expect(verifyDocumentId(A, derivedFromBlank)).toEqual({ kind: 'foreign' })
    })
  })

  // Legacy documents are the overwhelming majority and must keep working. The
  // caller distinguishes them by `unminted` and falls back to the durable index,
  // so a wrong answer here is a platform-wide outage rather than a nuisance.
  it('reports an ordinary random document id as unminted, never as foreign', async () => {
    const repo = new Repo({})
    for (let i = 0; i < 50; i += 1) {
      const handle = repo.create({ n: i })
      expect(verifyDocumentId(A, String(handle.documentId), SECRET)).toEqual({ kind: 'unminted' })
    }
  })

  it('reports an unknown scheme version as unminted, so a future format is not a denial', async () => {
    const repo = new Repo({
      idFactory: async () => {
        const bytes = Buffer.from(mintDocumentIdBytes(A, SECRET))
        bytes[0] = MINT_VERSION + 7
        return Uint8Array.from(bytes)
      },
    })
    const handle = await repo.create2({})
    expect(verifyDocumentId(A, String(handle.documentId), SECRET)).toEqual({ kind: 'unminted' })
  })

  it('rejects a tampered tag', async () => {
    const repo = new Repo({
      idFactory: async () => {
        const bytes = Buffer.from(mintDocumentIdBytes(A, SECRET))
        bytes[MINTED_ID_BYTES - 1] ^= 0x01
        return Uint8Array.from(bytes)
      },
    })
    const handle = await repo.create2({})
    expect(verifyDocumentId(A, String(handle.documentId), SECRET)).toEqual({ kind: 'foreign' })
  })

  // The separator matters: workspace ids are opaque strings and nothing stops
  // one from being a prefix of another's concatenation. Without the NUL
  // delimiters, ('ab','c') and ('a','bc') would produce the same tag input and
  // an id minted for one workspace would verify for the other.
  it('does not let concatenation collide two different workspaces', async () => {
    const left = { landscapeId: 'ab', versionId: 'c' }
    const right = { landscapeId: 'a', versionId: 'bc' }
    const id = await mintedDocumentId(left)
    expect(verifyDocumentId(left, id, SECRET)).toEqual({ kind: 'bound' })
    expect(verifyDocumentId(right, id, SECRET)).toEqual({ kind: 'foreign' })
  })

  it('produces a document id automerge accepts, and one that survives url canonicalisation', async () => {
    const id = await mintedDocumentId(A)
    const url = stringifyAutomergeUrl({ documentId: id })
    expect(isValidAutomergeUrl(url)).toBe(true)
    expect(String(interpretAsDocumentId(url))).toBe(id)
    // And through decorated url forms, which must not change the id (a
    // tenancy boundary relies on it).
    for (const suffix of ['/', '#', '/x']) {
      expect(String(interpretAsDocumentId(`${url}${suffix}`))).toBe(id)
    }
  })

  it('mints distinct ids for the same workspace', async () => {
    const ids = new Set<string>()
    for (let i = 0; i < 25; i += 1) ids.add(await mintedDocumentId(A))
    expect(ids.size).toBe(25)
  })

  // The end-to-end contract between the two halves of the scheme, without a
  // server: what the mint endpoint puts on the wire (base64 of the raw bytes)
  // must survive the client's decode + `create2` and come back verifiable.
  // Getting this wrong produces ids that mint fine and never admit, which would
  // surface as "my new diagram does not sync" long after the fact.
  it('survives the wire encoding the mint endpoint uses', async () => {
    const onTheWire = Buffer.from(mintDocumentIdBytes(A, SECRET)).toString('base64')

    // ...client side.
    const bytes = Uint8Array.from(Buffer.from(onTheWire, 'base64'))
    const repo = new Repo({ idFactory: async () => bytes })
    const handle = await repo.create2({ created: 'offline, from a pooled id' })

    expect(verifyDocumentId(A, String(handle.documentId), SECRET)).toEqual({ kind: 'bound' })
    expect(verifyDocumentId(B, String(handle.documentId), SECRET)).toEqual({ kind: 'foreign' })
  })

  // A pooled id is used once, minted well before use. Nothing about the document
  // it ends up naming can be predicted at mint time, so the tag must not depend
  // on the content — `idFactory` receives the initial heads and this scheme
  // deliberately ignores them.
  it('binds the workspace and nothing about the document', async () => {
    const bytes = mintDocumentIdBytes(A, SECRET)
    const first = await new Repo({ idFactory: async () => bytes }).create2({ shape: 'one' })
    const second = await new Repo({ idFactory: async () => bytes }).create2({ totally: 'different' })
    expect(String(first.documentId)).toBe(String(second.documentId))
    expect(verifyDocumentId(A, String(first.documentId), SECRET)).toEqual({ kind: 'bound' })
    expect(verifyDocumentId(A, String(second.documentId), SECRET)).toEqual({ kind: 'bound' })
  })

  // DENIAL OF SERVICE. `documentIdToBinary` is `bs58check.decodeUnsafe`, whose
  // inner loop is O(n^2) in the input length, and nothing upstream bounds a
  // documentId — `CollectionSynchronizer.onSyncMessage` only checks truthiness
  // and `syncWriteGate` takes the raw CBOR field. Measured: 100,000
  // characters blocks the event loop for ~4.5 s, and this function is
  // on the inbound sync path. The guard must come BEFORE the decode, so a
  // length check on the DECODED bytes is not a guard at all.
  it('does not decode an oversized document id', () => {
    const huge = '2'.repeat(100_000)
    const startedAt = process.hrtime.bigint()
    expect(verifyDocumentId(A, huge, SECRET)).toEqual({ kind: 'unminted' })
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
    expect(ms, `took ${ms.toFixed(0)} ms — the decode ran`).toBeLessThan(50)
  })

  // Inside a gate an exception is a FAULT, not a verdict
  // (`stageAwareAccessCheck` awaits the raw check). `decodeUnsafe` throws `TypeError: Expected String` for a non-string,
  // and the call sits outside the gate's own try/catch.
  it('returns a verdict rather than throwing for a non-string document id', () => {
    for (const bad of [12345, 12345n, null, undefined, {}, [], Symbol('x')]) {
      expect(() => verifyDocumentId(A, bad as unknown as string, SECRET)).not.toThrow()
      expect(verifyDocumentId(A, bad as unknown as string, SECRET)).toEqual({ kind: 'unminted' })
    }
  })

  it('refuses to mint without a secret rather than minting under an empty key', () => {
    const saved = process.env.AUTH_SECRET
    delete process.env.AUTH_SECRET
    try {
      expect(() => mintDocumentIdBytes(A)).toThrow(/AUTH_SECRET is required/)
    } finally {
      if (saved !== undefined) process.env.AUTH_SECRET = saved
    }
  })

  // Pins the decode-LENGTH guard on its own. A legacy-length id
  // (16 bytes) whose first byte happens to equal MINT_VERSION passes the
  // version-byte check; without the length guard it reaches timingSafeEqual
  // with a short buffer — a RangeError INSIDE the gate, i.e. a gateFault
  // fail-closed verdict for ~1/256 of perfectly ordinary legacy documents, on
  // every message. The 50-random-ids test misses this shape probabilistically.
  it('a legacy-length id whose first byte is MINT_VERSION is unminted, never a fault', async () => {
    const bytes = randomBytes(16)
    bytes[0] = MINT_VERSION
    const repo = new Repo({ idFactory: async () => bytes })
    const id = String((await repo.create2({ legacy: true })).documentId)
    expect(verifyDocumentId(A, id, SECRET)).toEqual({ kind: 'unminted' })
  })

  // The harness canary. With no AUTH_SECRET in the harness, `mintKeys()` is
  // empty and `verifyDocumentId` returns `unminted` before comparing a single
  // tag, so every env-keyed consumer (the docScope gates above all) would
  // exercise only the legacy fall-through while looking green.
  // server/vitest.setup.ts injects the secret before every test file; this
  // test fails BY NAME if that wiring is ever lost.
  it('harness canary: the verification body runs under this suite', async () => {
    expect(
      process.env.AUTH_SECRET,
      'vitest.setup.ts must inject AUTH_SECRET before every test file (slice D0)',
    ).toBeTruthy()
    // Minted from the ENVIRONMENT and verified from the environment — exactly
    // the production shape, no explicit-secret escape hatch.
    const id = await mintedDocumentId(A, null)
    expect(verifyDocumentId(A, id)).toEqual({ kind: 'bound' })
    // The discriminating half: a dead verification body answers `unminted`
    // here, never `foreign` — `foreign` can only come from a tag comparison
    // that actually ran.
    expect(verifyDocumentId(B, id)).toEqual({ kind: 'foreign' })
  })

  // The four-way verdict. The synchronous verify cannot
  // tell "another landscape" (a security boundary) from "a sibling version of
  // the route's own landscape" (the repoint shape); the displacement scan can,
  // by recomputing the tag over (route landscape × candidate version) under
  // every key in the rotation window.
  describe('displacement — the four-way verdict', () => {
    const V1 = { landscapeId: 'L-repoint', versionId: 'V-one' }
    const V2 = { landscapeId: 'L-repoint', versionId: 'V-two' }

    it('an id minted for V1 is displaced, not foreign, for a V2 route of the same landscape', async () => {
      const id = await mintedDocumentId(V1)
      await expect(
        verifyDocumentIdWithDisplacement(V2, id, async () => ['V-one', 'V-two'], SECRET),
      ).resolves.toEqual({ kind: 'displaced' })
      // Displacement is a REFINEMENT: the synchronous verdict for the same
      // input still refuses, which is what keeps every caller that never asks
      // for the refinement exactly as strict as before.
      expect(verifyDocumentId(V2, id, SECRET)).toEqual({ kind: 'foreign' })
    })

    it('the scan finds the minted version even when the route version lists first', async () => {
      // Every other fixture lists the minted version first, so a scan
      // truncated to the FIRST candidate would still pass them all —
      // position within the (newest-first) list must not
      // decide the verdict inside the cap. Route version first, minted
      // version second.
      const id = await mintedDocumentId(V1)
      await expect(
        verifyDocumentIdWithDisplacement(V2, id, async () => ['V-two', 'V-one'], SECRET),
      ).resolves.toEqual({ kind: 'displaced' })
    })

    // The candidate ceiling. The scan is candidates × keys HMACs on the sync
    // thread, synchronous once the list arrives — CPU the branch deadline
    // cannot bound. The cap must (a) stop consumption at exactly
    // DISPLACED_SCAN_MAX_CANDIDATES, (b) verdict `foreign` for a match beyond
    // the cut (hard deny, lifted like every foreign: the holder reconnecting
    // on its minted route verifies `bound` O(1)), and (c) leave an observable
    // trace. Regressions caught: no cap → `consumed` reads the whole list AND
    // the verdict flips to `displaced`; cap without counter → the truncation
    // delta stays 0; slice instead of an index bound → the copy consumes every
    // element and `consumed` overshoots.
    it('scans at most DISPLACED_SCAN_MAX_CANDIDATES: a match beyond the cut stays foreign, and the truncation is counted', async () => {
      const id = await mintedDocumentId(V1)
      const noise = Array.from({ length: DISPLACED_SCAN_MAX_CANDIDATES }, (_, i) => `V-noise-${i}`)
      // The minted version sits ONE PAST the cut — the smallest overshoot the
      // cap must refuse to reach.
      const oversized = [...noise, 'V-one']
      let consumed = 0
      const counting = new Proxy(oversized, {
        get(target, prop, receiver) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) consumed += 1
          return Reflect.get(target, prop, receiver)
        },
      })
      const truncationsBefore = displacedScanTruncationsTotal()
      await expect(
        verifyDocumentIdWithDisplacement(V2, id, async () => counting, SECRET),
      ).resolves.toEqual({ kind: 'foreign' })
      expect(consumed, 'the scan must consume exactly the cap, never the tail').toBe(DISPLACED_SCAN_MAX_CANDIDATES)
      expect(displacedScanTruncationsTotal() - truncationsBefore, 'a truncated list must leave a trace').toBe(1)
    })

    // The cap must not break the nominal refinement: an oversized list whose
    // match sits INSIDE the cap still refines to `displaced`, and an untruncated
    // scan still counts nothing. Catches the cap applied as skip-first-N, or
    // the truncation counted on every scan.
    it('a match inside the cap still refines to displaced on an oversized list', async () => {
      const id = await mintedDocumentId(V1)
      const noise = Array.from({ length: DISPLACED_SCAN_MAX_CANDIDATES + 50 }, (_, i) => `V-noise-${i}`)
      const truncationsBefore = displacedScanTruncationsTotal()
      await expect(
        verifyDocumentIdWithDisplacement(V2, id, async () => ['V-one', ...noise], SECRET),
      ).resolves.toEqual({ kind: 'displaced' })
      expect(displacedScanTruncationsTotal() - truncationsBefore).toBe(1)

      // Control: a list AT the cap is not truncated and counts nothing.
      const atCap = ['V-one', ...noise.slice(0, DISPLACED_SCAN_MAX_CANDIDATES - 1)]
      await expect(
        verifyDocumentIdWithDisplacement(V2, id, async () => atCap, SECRET),
      ).resolves.toEqual({ kind: 'displaced' })
      expect(displacedScanTruncationsTotal() - truncationsBefore).toBe(1)
    })

    // The 1/min warn, pinned in BOTH directions: the rate-limit forced to
    // `return` (a landscape past the cap becomes SILENT except for the
    // counter) and the rate-limit removed (a mismatch storm on a big
    // landscape becomes a warn per scanned message). Fake timers drive the
    // 60 s window deterministically.
    it('warns once per minute per landscape on truncation — suppressed inside the window, re-armed past it', async () => {
      // Minted under REAL timers: Repo internals may lean on the clock.
      const W2 = { landscapeId: 'L-warn-rate', versionId: 'V-route' }
      const id = await mintedDocumentId({ landscapeId: 'L-warn-rate', versionId: 'V-minted' })
      const oversized = Array.from(
        { length: DISPLACED_SCAN_MAX_CANDIDATES + 1 },
        (_, i) => `V-noise-${i}`,
      )
      const scanOnce = () => verifyDocumentIdWithDisplacement(W2, id, async () => oversized, SECRET)

      vi.useFakeTimers()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        await scanOnce()
        expect(warn).toHaveBeenCalledTimes(1)
        // Production's LIMIT cap+1 makes cap+1 a FLOOR, and
        // the message says so instead of printing a wrong exact figure.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(
          `at least ${DISPLACED_SCAN_MAX_CANDIDATES + 1} candidate versions`,
        ))

        // Same landscape, same window: counted, never re-warned.
        await scanOnce()
        expect(warn, 'rate-limit removed → this reads 2').toHaveBeenCalledTimes(1)

        // Past the window the warn re-arms — a landscape STILL past the cap
        // keeps saying so, once a minute.
        vi.advanceTimersByTime(61_000)
        await scanOnce()
        expect(warn, 'rate-limit forced to always-return → this stays 1').toHaveBeenCalledTimes(2)
      } finally {
        warn.mockRestore()
        vi.useRealTimers()
      }
    })

    it('an id minted for another landscape stays foreign whatever versions the list offers', async () => {
      const id = await mintedDocumentId(B)
      // The candidate-list analogue of the "index that would admit" trick: a
      // POISONED list — as an unfiltered `SELECT id FROM versions` would
      // produce — containing the exact version the id was minted for (V-b).
      // The verdict must not move: the tag binds (landscape, version) JOINTLY
      // and the scan recomputes under the ROUTE's landscape, so no candidate
      // list, however wrong, can turn an inter-landscape id into `displaced`.
      await expect(
        verifyDocumentIdWithDisplacement(A, id, async () => ['V-b', 'V-a', 'V-one'], SECRET),
      ).resolves.toEqual({ kind: 'foreign' })
    })

    describe('across key rotation', () => {
      const OLD = 'the-retired-displacement-secret'
      const NEW = 'the-current-displacement-secret'
      let saved: { current?: string; previous?: string }
      beforeEach(() => {
        saved = { current: process.env.AUTH_SECRET, previous: process.env.AUTH_SECRET_PREVIOUS }
      })
      afterEach(() => {
        if (saved.current === undefined) delete process.env.AUTH_SECRET
        else process.env.AUTH_SECRET = saved.current
        if (saved.previous === undefined) delete process.env.AUTH_SECRET_PREVIOUS
        else process.env.AUTH_SECRET_PREVIOUS = saved.previous
      })

      // Rotation must traverse the SCAN, not only the route-version check:
      // an id minted before the rotation AND before the repoint has to come
      // out `displaced`, or rotation+repoint together produce a permanent
      // platform-wide deny.
      it('an id minted under a retired-but-declared key for V1 is displaced on V2', async () => {
        const beforeRotation = await mintedDocumentId(V1, OLD)
        process.env.AUTH_SECRET = NEW
        process.env.AUTH_SECRET_PREVIOUS = OLD
        await expect(
          verifyDocumentIdWithDisplacement(V2, beforeRotation, async () => ['V-one', 'V-two']),
        ).resolves.toEqual({ kind: 'displaced' })
      })

      it('an id under a retired-then-withdrawn key stays foreign even with the right version list', async () => {
        const beforeRotation = await mintedDocumentId(V1, OLD)
        process.env.AUTH_SECRET = NEW
        delete process.env.AUTH_SECRET_PREVIOUS
        await expect(
          verifyDocumentIdWithDisplacement(V2, beforeRotation, async () => ['V-one', 'V-two']),
        ).resolves.toEqual({ kind: 'foreign' })
      })
    })

    // The DoS guards run BEFORE the scan, structurally: the version list is a
    // SQL round trip in production, so a scan that ran for arbitrary garbage
    // would hand any routed peer a database query per message — and a scan
    // that ran before the LENGTH guard would reopen the O(n²) decode this
    // module measures at ~4.5 s per 100k-character message.
    it('the displaced scan never runs for an unminted input', async () => {
      const consulted: string[] = []
      const listSpy = async (landscapeId: string) => {
        consulted.push(landscapeId)
        return ['V-one', 'V-two']
      }

      const huge = '2'.repeat(100_000)
      const startedAt = process.hrtime.bigint()
      await expect(verifyDocumentIdWithDisplacement(A, huge, listSpy, SECRET))
        .resolves.toEqual({ kind: 'unminted' })
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6
      expect(ms, `took ${ms.toFixed(0)} ms — the decode ran`).toBeLessThan(50)

      const legacy = String(new Repo({}).create({ legacy: true }).documentId)
      await expect(verifyDocumentIdWithDisplacement(A, legacy, listSpy, SECRET))
        .resolves.toEqual({ kind: 'unminted' })
      await expect(verifyDocumentIdWithDisplacement(A, 12345 as unknown as string, listSpy, SECRET))
        .resolves.toEqual({ kind: 'unminted' })

      // And the NOMINAL path stays answered-not-consulted: a bound id must
      // never cost the round trip either.
      const bound = await mintedDocumentId(A)
      await expect(verifyDocumentIdWithDisplacement(A, bound, listSpy, SECRET))
        .resolves.toEqual({ kind: 'bound' })

      expect(consulted, 'the version list must never be consulted off the mismatch path').toEqual([])
    })
  })
})
