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
import { Repo, type DocumentId } from '@automerge/automerge-repo'
import { syncedHandle } from './repoCompat.js'

/** Wait for the STATE, never a duration. A fixed `setTimeout` is a bet on
 *  machine speed: flaky under load, and wasted time otherwise. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition jamais atteinte')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * The upstream invariant the BROWSER seam (`syncedHandle`) depends on.
 *
 * `server/src/automergeRepoCompat.seam.test.ts` establishes the same thing on
 * the server, and this is not a duplicate: the root and `server/` each have
 * their own `package-lock.json` and their own
 * `node_modules/@automerge/automerge-repo`, and the server test only runs
 * against `server/`'s install. Upgrading only the ROOT dependency could make
 * `syncedHandle` return `undefined` for every document with no gate noticing,
 * and its only consumer (`documentResolution.ts`, `documentRepoState`) would
 * silently read that as `'unknown'` on the offline-recovery path.
 *
 * ⚠ Any new eviction path added to the browser bundle must add its case to
 * the first test below.
 */
describe('T11.3bis — la couture repo.handles (navigateur)', () => {
  const expectAgreement = (repo: Repo, moment: string) => {
    const queries = Object.keys(repo.handles).sort()
    const synchronizers = Object.keys(repo.synchronizer.docSynchronizers).sort()
    expect(synchronizers, `${moment} : docSynchronizers ⊄ queries`).toEqual(queries)
    for (const id of queries) {
      expect(
        syncedHandle(repo, id),
        `${moment} : syncedHandle doit rendre L'OBJET de repo.handles pour ${id}`,
      ).toBe(repo.handles[id as DocumentId])
    }
  }

  it('#docSynchronizers et #queries portent les mêmes clés à chaque étape du cycle de vie', async () => {
    const repo = new Repo({ network: [] })
    expectAgreement(repo, 'repo neuf')

    const created = repo.create<{ n: number }>({ n: 1 })
    expectAgreement(repo, 'après create, MÊME tour')
    await Promise.resolve()
    expectAgreement(repo, 'après create, microtâche suivante')

    // The loading window: `query.peek()` says `loading` then `unavailable`
    // while `handle.state` says `ready`. This is the state most likely to
    // desynchronize the two tables, so it is the one to cover.
    const donor = new Repo({ network: [] })
    const absent = donor.create<{ n: number }>({ n: 2 })
    const absentQuery = repo.findWithProgress(absent.url)
    expectAgreement(repo, 'pendant le chargement d\'un document absent')
    await until(() => absentQuery.peek().state === 'unavailable')
    expectAgreement(repo, 'une fois le document absent déclaré indisponible')

    await repo.removeFromCache(created.documentId)
    expectAgreement(repo, 'après removeFromCache')
    expect(Object.keys(repo.handles)).not.toContain(created.documentId)

    // `removeFromCache` is the ONLY eviction path in the browser bundle —
    // `handleRetry.ts` uses it, and `CollectionSynchronizer.detach`, the only
    // operation that could make `syncedHandle` disagree, has no caller here.
  })

  it('rend l\'objet du cache pour un document résident', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create<{ n: number }>({ n: 1 })
    // A seam that always returned `undefined` (what a root-only dependency
    // upgrade could produce) would pass the key-equality check above on an
    // empty repo, but not this one.
    expect(syncedHandle(repo, handle.documentId)).toBe(handle)
    expect(syncedHandle(repo, handle.documentId)?.doc()).toEqual({ n: 1 })
  })

  it('un identifiant inconnu rend undefined SANS créer de requête', () => {
    const repo = new Repo({ network: [] })
    const donor = new Repo({ network: [] })
    const documentId = donor.create<{ n: number }>({ n: 1 }).url.replace('automerge:', '')

    const before = Object.keys(repo.handles).length
    expect(syncedHandle(repo, documentId)).toBeUndefined()
    // Guards against `repo.findWithProgress(id).peek().handle`: same answer,
    // but `findWithProgress` calls `#ensureQuery`, so probing would
    // materialize — and in a tab, resurrect documents eviction just released.
    expect(Object.keys(repo.handles).length, 'sonder ne doit rien matérialiser').toBe(before)
  })
})
