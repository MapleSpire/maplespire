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
import { Repo, decodeHeads, type DocHandle, type DocumentId } from '@automerge/automerge-repo'
import * as Automerge from '@automerge/automerge'
import { residentHeads, syncStateLookupMetrics } from './automergeServer.js'

/**
 * Declared here rather than imported, deliberately: `detach` is the ONE
 * operation that can make `syncedHandle` disagree with the document cache, so
 * `automergeRepoCompat.ts` does not export it and production code cannot reach
 * it. Pinning the divergence is its only legitimate use.
 * `CollectionSynchronizer.detach` is declared upstream, so no cast is needed
 * and a rename breaks the build.
 */
function detachDocument(repo: Repo, documentId: DocumentId): void {
  repo.synchronizer.detach(documentId)
}

/**
 * `residentHeads` must stay OFF `repo.handles`.
 *
 * The concern is cost, not correctness: `repo.handles` is a getter that
 * rebuilds a whole `Record` per access, and this function's caller runs once
 * per `sync-state` — after every generateSyncMessage and receiveSyncMessage.
 * Measured with `--cpu-prof` at 25 peers / 211 resident documents: 4 839 ms of
 * a 74 s profile, the largest non-idle frame.
 *
 * An O(n) version returns the same heads, so the assertion is on the ACCESS
 * COUNT, the only thing that separates them.
 */
describe('T11.0 — residentHeads ne touche jamais repo.handles', () => {
  /** A real Repo, with `handles` instrumented to count reads. */
  function countingRepo() {
    const repo = new Repo({ network: [] })
    let handlesReads = 0
    const original = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(repo), 'handles',
    )
    expect(original?.get, 'repo.handles must still be a getter').toBeTypeOf('function')
    Object.defineProperty(repo, 'handles', {
      configurable: true,
      get() { handlesReads += 1; return original!.get!.call(repo) },
    })
    return { repo, reads: () => handlesReads }
  }

  it('résout les têtes d\'un document résident sans lire handles UNE SEULE FOIS', () => {
    const { repo, reads } = countingRepo()
    const handle = repo.create<{ n: number }>({ n: 1 })
    handle.change((d) => { d.n = 2 })

    const before = reads()
    const heads = residentHeads(repo, handle.documentId)
    expect(heads, 'un document résident doit répondre').toBeDefined()
    expect(heads!.length).toBeGreaterThan(0)
    // `repo.handles[documentId]?.…` would return the same heads with +1 read.
    expect(reads() - before).toBe(0)
  })

  it('reste à ZÉRO lecture sur 500 appels — c\'est la cadence réelle du site', () => {
    const { repo, reads } = countingRepo()
    const handle = repo.create<{ n: number }>({ n: 1 })
    const before = reads()
    for (let i = 0; i < 500; i += 1) residentHeads(repo, handle.documentId)
    // Not "small": ZERO. A per-event site has no budget for an O(n) getter.
    expect(reads() - before).toBe(0)
  })

  it('rend undefined SYNCHRONEMENT pour un document absent, sans lire handles', () => {
    const { repo, reads } = countingRepo()
    const before = reads()
    // `repo.find()` here would NEVER SETTLE with a network adapter attached and
    // no peer connected, so a miss has to be a synchronous undefined.
    expect(residentHeads(repo, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA')).toBeUndefined()
    expect(reads() - before).toBe(0)
  })

  it('ne matérialise PAS un document absent — le repo n\'enfle pas', () => {
    const { repo } = countingRepo()
    repo.create<{ n: number }>({ n: 1 })
    const sizeBefore = Object.keys(repo.handles).length
    for (let i = 0; i < 50; i += 1) residentHeads(repo, `absent-${i}`)
    // A lookup that resurrected or minted a handle would be a leak.
    expect(Object.keys(repo.handles).length).toBe(sizeBefore)
  })

  it('rend EXACTEMENT ce que rendait l\'ancienne expression (hex brut)', () => {
    const { repo } = countingRepo()
    const handle = repo.create<{ n: number }>({ n: 1 })
    handle.change((d) => { d.n = 2 })

    // The `repo.handles` form: bs58check out of `heads()`, decoded straight back.
    const legacy = decodeHeads(
      (repo.handles as Record<string, DocHandle<unknown>>)[handle.documentId].heads()!,
    )
    expect(residentHeads(repo, handle.documentId)).toEqual(legacy)
    // And the same thing the synchronizer compares `sharedHeads` against.
    expect(residentHeads(repo, handle.documentId))
      .toEqual(Automerge.getHeads(handle.fullDoc()))
  })

  /**
   * The ONE behavioural divergence from a `repo.handles` lookup, pinned because
   * it is a property of the library.
   *
   * `CollectionSynchronizer.detach(id)` removes the `docSynchronizers` entry but
   * does NOT touch `repo.#queries`, from which `get handles()` is derived. The
   * document stays in `repo.handles`, leaves `docSynchronizers`, and a later
   * `repo.find()` returns the cached handle WITHOUT re-attaching. Production
   * code has no caller of `detach`.
   *
   * Bounded impact if it ever happens: a `sync-state` can still arrive for the
   * detached document and `serviceLatency.observe` is not called, so a latency
   * interval stays open until `abandoned` (10 min). No user data is at stake,
   * and the `misses` counter makes the case visible. A fallback to
   * `repo.handles` on a miss would put the O(n) getter back on the hot path.
   */
  it('après detach, le document reste dans handles et sort de docSynchronizers', () => {
    const { repo } = countingRepo()
    const handle = repo.create<{ n: number }>({ n: 1 })
    handle.change((d) => { d.n = 2 })
    expect(residentHeads(repo, handle.documentId)).toBeDefined()

    detachDocument(repo, handle.documentId)

    // A `repo.handles` lookup would still answer here — that is the divergence.
    expect(Object.keys(repo.handles)).toContain(handle.documentId)
    expect(residentHeads(repo, handle.documentId)).toBeUndefined()
  })

  it('un miss est COMPTÉ — sans quoi l\'extinction ressemble à une amélioration', () => {
    const { repo } = countingRepo()
    const before = { ...syncStateLookupMetrics }
    residentHeads(repo, 'AAAAAAAAAAAAAAAAAAAAAAAAAAA')
    // If the lookup stopped resolving (upstream rename, mass detach), `totalMs`
    // would DROP — a miss is cheaper than a hit — and look like an
    // improvement. `misses` distinguishes "nothing to do" from "finds nothing".
    expect(syncStateLookupMetrics.misses - before.misses).toBe(1)
    expect(syncStateLookupMetrics.count - before.count).toBe(1)
  })

  it('suit les changements — ce n\'est pas une valeur figée au premier appel', () => {
    const { repo } = countingRepo()
    const handle = repo.create<{ n: number }>({ n: 1 })
    const first = residentHeads(repo, handle.documentId)
    handle.change((d) => { d.n = 99 })
    const second = residentHeads(repo, handle.documentId)
    // Memoising the lookup per documentId would freeze the metric at the
    // first heads — `isCaughtUp` would then be answered against a stale head
    // for ever, which is the same class of defect as mixing encodings.
    expect(second).not.toEqual(first)
    expect(second).toEqual(Automerge.getHeads(handle.fullDoc()))
  })
})
