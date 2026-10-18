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
import { Repo, type DocumentId, type StorageAdapterInterface } from '@automerge/automerge-repo'
import * as compat from './automergeRepoCompat.js'
import { syncedHandle, cachedHandles, drainEntries } from './automergeRepoCompat.js'

/** Wait for a STATE, never a fixed duration: a fixed `setTimeout` is a bet on
 *  machine speed — flaky under load, wasted time otherwise. */
async function until(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition jamais atteinte')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/**
 * The `repo.handles` seam, and the upstream invariant it depends on.
 *
 * `syncedHandle` answers in O(1) a question `repo.handles[id]` answers in
 * O(n). That is only legitimate if both tables hold the SAME keys in every
 * reachable state — a property of `@automerge/automerge-repo` that upstream
 * neither documents nor tests, and that any rework of
 * `CollectionSynchronizer` can break. The dependency is pinned exactly
 * (`2.6.0-alpha.2`, no caret), so a version bump is deliberate and this suite
 * is what must fail.
 *
 * ⚠ Any NEW eviction path added to the process must add its case to the
 * first test below. A path that removed from `#queries` without removing from
 * `#docSynchronizers` would blind `syncedHandle`: in `projectorService` a
 * watcher pinned to a dead handle would permanently blind the resident sweep,
 * and that diagram would stop projecting with no error anywhere.
 */
describe('T11.3bis — la couture repo.handles', () => {
  /** The two tables `syncedHandle` and `cachedHandles` read, side by side. */
  const keysOf = (repo: Repo) => ({
    queries: Object.keys(repo.handles).sort(),
    synchronizers: Object.keys(repo.synchronizer.docSynchronizers).sort(),
  })

  const expectAgreement = (repo: Repo, moment: string) => {
    const { queries, synchronizers } = keysOf(repo)
    expect(synchronizers, `${moment}: docSynchronizers ⊄ queries`).toEqual(queries)
    for (const id of queries) {
      expect(
        syncedHandle(repo, id),
        `${moment}: syncedHandle doit rendre L'OBJET de repo.handles pour ${id}`,
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
    await new Promise((resolve) => setImmediate(resolve))
    expectAgreement(repo, 'après create, macrotâche suivante')

    // A document this repo has never seen, with no storage and no peer: the
    // loading window, where `query.peek()` says `loading` then `unavailable`
    // while `handle.state` says `ready`. This is the state most likely to
    // desynchronise the two tables, so it must be covered.
    const donor = new Repo({ network: [] })
    const absent = donor.create<{ n: number }>({ n: 2 })
    const absentQuery = repo.findWithProgress(absent.url)
    expectAgreement(repo, 'pendant le chargement d\'un document absent')
    await until(() => absentQuery.peek().state === 'unavailable')
    expectAgreement(repo, 'après que le document absent soit déclaré indisponible')

    await repo.removeFromCache(created.documentId)
    expectAgreement(repo, 'après removeFromCache')

    const doomed = repo.create<{ n: number }>({ n: 3 })
    repo.delete(doomed.url)
    expectAgreement(repo, 'après repo.delete')
    expect(Object.keys(repo.handles), 'repo.delete retire du cache').not.toContain(
      doomed.documentId,
    )
  })

  it('un identifiant inconnu rend undefined SANS créer de requête', () => {
    const repo = new Repo({ network: [] })
    const donor = new Repo({ network: [] })
    const url = donor.create<{ n: number }>({ n: 1 }).url
    const documentId = url.replace('automerge:', '')

    const before = Object.keys(repo.handles).length
    expect(syncedHandle(repo, documentId)).toBeUndefined()
    // `repo.findWithProgress(id).peek().handle` would give the right answer
    // AND resurrect the document — `findWithProgress` calls `#ensureQuery`
    // (`Repo.js`), so probing would materialise, and the idle sweep would
    // fight its own probe.
    expect(Object.keys(repo.handles).length, 'sonder ne doit rien matérialiser').toBe(before)
  })

  it('cachedHandles rend une COPIE jetable — en supprimer une entrée n\'évince rien', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create<{ n: number }>({ n: 1 })

    const snapshot = cachedHandles(repo) as Record<string, unknown>
    delete snapshot[handle.documentId]

    expect(snapshot[handle.documentId], 'la copie, elle, a bien perdu l\'entrée').toBeUndefined()
    expect(
      syncedHandle(repo, handle.documentId),
      'mais le document est TOUJOURS résident — six sites de cet arbre ont cru le contraire',
    ).toBe(handle)
    expect(cachedHandles(repo)[handle.documentId]).toBe(handle)
    expect(cachedHandles(repo), 'deux lectures ne sont même pas le même objet')
      .not.toBe(cachedHandles(repo))
  })

  it('le type interdit la suppression sans cast — c\'est la seule chose qui attrape cette classe', () => {
    const repo = new Repo({ network: [] })
    const handle = repo.create<{ n: number }>({ n: 1 })
    // @ts-expect-error TS2542 — `Readonly<Record<…>>`: the index is read-only.
    // No syntax-only ESLint rule can follow a local alias, so the type is the
    // only guard against deleting through one.
    delete cachedHandles(repo)[handle.documentId]
  })

  it('automergeRepoCompat n\'expose plus detachAutomergeDocument', () => {
    // `CollectionSynchronizer.detach` is the ONLY operation that can make
    // `syncedHandle` unfaithful: it removes from `#docSynchronizers` while
    // leaving `#queries`, and a later `repo.find` returns the cached handle
    // without re-attaching, so the invisibility is permanent. Keeping it out
    // of the seam keeps it unreachable from production code; re-adding it
    // means converting `syncedHandle` call sites back to `cachedHandles`.
    // Presence first: on an empty namespace the absence below would pass
    // without proving anything.
    expect(Object.keys(compat)).toContain('syncedHandle')
    expect(Object.keys(compat)).toContain('cachedHandles')
    expect(Object.keys(compat)).not.toContain('detachAutomergeDocument')
  })

  it('DocHandle.state ne filtre PAS les documents non matérialisés', async () => {
    const repo = new Repo({ network: [] })
    const donor = new Repo({ network: [] })
    const absent = donor.create<{ n: number }>({ n: 1 })
    const query = repo.findWithProgress(absent.url)
    const documentId = absent.documentId

    await until(() => query.peek().state === 'unavailable')

    // A `state !== 'ready'` guard does not filter what it appears to: a
    // never-materialised document is `ready`.
    expect(query.peek().state).toBe('unavailable')
    expect(repo.handles[documentId]?.state, 'le handle se dit ready').toBe('ready')
    expect(repo.handles[documentId]?.heads()).toHaveLength(0)
    expect(repo.handles[documentId]?.doc()).toEqual({})
  })

  it('un handle supprimé par DocHandle.delete() RESTE dans le cache — la garde ready n\'est pas morte', () => {
    // `repo.delete()` removes from `#queries` in the same synchronous block, so
    // a cached handle is never seen `deleted` — which tempts the conclusion
    // that every `state !== 'ready'` guard is structurally dead. It is not:
    // `DocHandle.delete()` called alone flips the state WITHOUT touching the
    // cache. The guards are dead only for lack of a caller, so they stay.
    const repo = new Repo({ network: [] })
    const handle = repo.create<{ n: number }>({ n: 1 })
    handle.delete()

    expect(handle.state).toBe('deleted')
    expect(cachedHandles(repo)[handle.documentId], 'toujours dans le cache').toBe(handle)
    expect(syncedHandle(repo, handle.documentId), 'et toujours vu par la couture').toBe(handle)
  })

  it('les sources d\'une requete s\'appellent storage et automerge-sync', async () => {
    // `durableHeads.ts` waits on `peek().sources.storage` and on nothing else.
    // `sources` is typed `Record<string, SourceState>`, so tsc cannot see a
    // rename upstream: `sources.storage` would read `undefined`, the wait would
    // end at once, and a document held only in storage would answer
    // `durable:false` until a retry. Pin the names on the library contract.
    const storage: StorageAdapterInterface = {
      load: async () => undefined,
      save: async () => {},
      remove: async () => {},
      loadRange: async () => [],
      removeRange: async () => {},
    }
    const repo = new Repo({ storage, network: [] })
    const absent = new Repo({ network: [] }).create<{ n: number }>({ n: 1 })
    const query = repo.findWithProgress(absent.url)
    expect(Object.keys(query.peek().sources).sort()).toEqual(['automerge-sync', 'storage'])
    expect(query.peek().sources.storage, 'storage starts pending').toBe('pending')
    await until(() => query.peek().sources.storage === 'unavailable')
  })
})

/**
 * `drainEntries` releases each snapshot entry as it is consumed, so a sweep
 * that awaits between entries does not keep every evicted document reachable
 * until the pass ends.
 *
 * Retention is otherwise observable only through the garbage collector. Here
 * the caller owns the array, so the assertions read its slots: deterministic,
 * no `--expose-gc`, no `skipIf`.
 */
describe('T11.3bis — drainEntries libere au fur et a mesure', () => {
  const entriesOf = (n: number): Array<readonly [string, { id: number }] | undefined> =>
    Array.from({ length: n }, (_unused, index) => [String(index), { id: index }] as const)

  it('chaque case est videe AVANT que la suivante soit rendue', () => {
    const entries = entriesOf(5)
    const seenAt: Array<Array<number>> = []
    for (const [key] of drainEntries(entries)) {
      // What the consumer can still reach from the array while it holds `key`.
      seenAt.push(entries.flatMap((entry) => (entry ? [entry[1].id] : [])))
      expect(key).toBeTypeOf('string')
    }
    // Without `entries[index] = undefined` the array would keep all 5 entries
    // on every turn — the very documents the sweep has just evicted.
    expect(seenAt).toEqual([[1, 2, 3, 4], [2, 3, 4], [3, 4], [4], []])
  })

  it('un consommateur qui s\'arrete en cours ne laisse rien d\'epingle derriere lui', () => {
    const entries = entriesOf(5)
    for (const [key] of drainEntries(entries)) if (key === '2') break
    // Clearing the slot AFTER the `yield` would leave entry 2 pinned when the
    // consumer breaks early (e.g. a per-sweep budget).
    expect(entries.slice(0, 3), 'tout ce qui a ete rendu est libere').toEqual([
      undefined, undefined, undefined,
    ])
    expect(entries.slice(3).every(Boolean), 'ce qui n\'a pas ete atteint est intact').toBe(true)
  })

  it('les trous de l\'instantane sont sautes sans etre rendus', () => {
    const entries = entriesOf(3)
    entries[1] = undefined
    expect([...drainEntries(entries)].map(([key]) => key)).toEqual(['0', '2'])
  })
})
