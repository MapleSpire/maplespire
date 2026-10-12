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

import { describe, it, expect, vi, afterEach } from 'vitest'
import { Repo, type DocumentId, type DocHandle } from '@automerge/automerge-repo'
import type { Chunk, StorageAdapterInterface, StorageKey } from '@automerge/automerge-repo'
import { startIdleEviction } from './automergeServer.js'
import { AutomergeResidencyLeases } from './automergeResidency.js'

/** Durable enough to re-resolve an evicted document, which is the only way to
 *  obtain a SECOND handle object for the same id. Same shape as the fixture in
 *  `automergeServer.test.ts`; duplicated rather than imported, because a
 *  `*.test.ts` importing another `*.test.ts` is fragile and server production
 *  code must never import from a testing directory. */
class MemoryStorage implements StorageAdapterInterface {
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()
  private keyText(key: StorageKey): string { return key.join('/') }
  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.entries.get(this.keyText(key))?.data.slice()
  }
  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    this.entries.set(this.keyText(key), { key: [...key], data: data.slice() })
  }
  async remove(key: StorageKey): Promise<void> { this.entries.delete(this.keyText(key)) }
  async loadRange(keyPrefix: StorageKey): Promise<Chunk[]> {
    return [...this.entries.values()]
      .filter(({ key }) => keyPrefix.every((part, index) => key[index] === part))
      .map(({ key, data }) => ({ key: [...key], data: data.slice() }))
  }
  async removeRange(keyPrefix: StorageKey): Promise<void> {
    for (const [text, { key }] of this.entries) {
      if (keyPrefix.every((part, index) => key[index] === part)) this.entries.delete(text)
    }
  }
}

/**
 * The idle sweep must not re-read `repo.handles` per document.
 *
 * `get handles()` rebuilds a whole `Record` per access (883 µs at 3 000
 * documents, 3 448 µs at 10 000), so one read per eviction candidate would cost
 * a full sweep 2.65 s at 3 000 documents and 34.5 s at 10 000. Holding the
 * snapshot across every `await` is a separate retention problem, covered by
 * `drainEntries` (here and in `automergeRepoCompat.seam.test.ts`).
 *
 * The assertion is on the NUMBER OF READS, never on a duration (a timing
 * assertion would be flaky), and is taken at TWO values of n, which makes it a
 * complexity assertion: equality between the two says "flat in n".
 */
describe('T11.3bis site A — le balayage au repos ne relit pas handles par document', () => {
  afterEach(() => { vi.useRealTimers() })

  /** A real Repo whose `handles` getter counts its own reads. Duplicated rather
   *  than shared: a `*.test.ts` importing another `*.test.ts` is fragile, and
   *  production must never import from a testing directory. */
  function countingRepo() {
    const repo = new Repo({ network: [] })
    let reads = 0
    const original = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(repo), 'handles')
    expect(original?.get, 'repo.handles doit rester un getter').toBeTypeOf('function')
    Object.defineProperty(repo, 'handles', {
      configurable: true,
      get() { reads += 1; return original!.get!.call(repo) },
    })
    return { repo, reads: () => reads }
  }

  /** The repo's cached document ids, read straight from the library so the
   *  assertion never routes through the seam it is checking. */
  const cachedHandlesOf = (repo: Repo) => Object.keys(repo.handles)

  /** One tracking sweep, then one evicting sweep, with the counter zeroed in
   *  between so the number describes the sweep that does the work. */
  async function countOneEvictingSweep(documentCount: number) {
    vi.useFakeTimers()
    const { repo, reads } = countingRepo()
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    for (let i = 0; i < documentCount; i += 1) repo.create({ objects: { [`o${i}`]: { id: `o${i}` } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)

    const timer = startIdleEviction(repo, root.url, residency, 1, 10)
    await vi.advanceTimersByTimeAsync(10)   // first sight: starts the grace period
    const before = reads()
    await vi.advanceTimersByTimeAsync(10)   // this one evicts
    clearInterval(timer)
    await residency.drain()

    const evicted = documentCount - (Object.keys(repo.handles).length - 1)
    return { sweepReads: reads() - before - 1 /* the read just above */, evicted }
  }

  it('un balayage complet lit repo.handles DEUX fois — le même nombre à n=50 et à n=200', async () => {
    const small = await countOneEvictingSweep(50)
    const large = await countOneEvictingSweep(200)

    expect(small.evicted, 'un balayage sans éviction ne prouve rien').toBe(50)
    expect(large.evicted, 'un balayage sans éviction ne prouve rien').toBe(200)

    // One read per candidate would give 53 and 203. A single extra read
    // elsewhere would give 3 and 3 — equal at both n — so the EXACT number is
    // what catches it, not the equality.
    expect(large.sweepReads, 'un instantané, plus le témoin handlesAfter').toBe(2)
    expect(small.sweepReads).toBe(2)
    // The equality is what makes this a complexity assertion: ×4 documents,
    // same cost.
    expect(large.sweepReads).toBe(small.sweepReads)
  })

  it('un handle périmé depuis l\'instantané n\'évince PAS le document qui a repris sa place', async () => {
    // Storage-backed: a document with no durable copy cannot be re-resolved
    // after eviction, and re-resolution is the only way to get a SECOND handle
    // object for the same id — which is the whole subject of this test.
    const repo = new Repo({ storage: new MemoryStorage(), network: [], saveDebounceRate: 0 })
    const residency = new AutomergeResidencyLeases(repo)
    const original = repo.create<{ n: number }>({ n: 1 })
    original.change((doc) => { doc.n = 2 })
    await repo.flush([original.documentId])
    const documentId = original.documentId
    const url = original.url

    // What the sweep holds: an entry taken at the start of the pass. Meanwhile
    // ANOTHER path evicted the document (partition failover,
    // `releaseUnavailableDocument`) and someone re-resolved it — a `find` after
    // eviction returns a NEW handle object.
    const stale: DocHandle<unknown> = original
    await repo.removeFromCache(documentId)
    const live = await repo.find(url)
    expect(live, 'la reprise doit produire un autre objet').not.toBe(stale)

    // This document is live: someone just asked for it. The sweep decided to
    // evict it from the OLD handle's idleness, which says nothing about the new
    // one. An `evict(id, handle)` that trusted the passed handle without
    // comparing it to the live one would census a dead object and evict a
    // document in use.
    expect(await residency.evict(documentId, stale)).toBe(false)
    expect(cachedHandlesOf(repo), 'le document repris est toujours là').toContain(documentId)

    // The healthy case stays healthy: with the right handle, it evicts.
    expect(await residency.evict(documentId, live)).toBe(true)
    expect(cachedHandlesOf(repo)).not.toContain(documentId)
  })

  it('le BALAYAGE transmet la poignée — un document repris en cours de passe survit', async () => {
    // The previous test pins `evict` as a unit. This one pins the WIRING: the
    // sweep, its only production caller, must pass the handle it holds.
    const repo = new Repo({ storage: new MemoryStorage(), network: [], saveDebounceRate: 0 })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    const created = []
    for (let i = 0; i < 4; i += 1) {
      const handle = repo.create<{ n: number }>({ n: i })
      handle.change((doc) => { doc.n = i + 1 })
      created.push(handle)
    }
    await repo.flush(created.map((handle) => handle.documentId))
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)

    // The snapshot's last document is evicted by ANOTHER path and re-resolved
    // while the pass runs, so when the loop reaches it the entry it holds no
    // longer designates the live document — what `evictWorkspaceDocumentCache`
    // and `releaseUnavailableDocument` do.
    const victim = created[created.length - 1]
    const victimUrl = victim.url
    const realEvict = residency.evict.bind(residency)
    let armed = true
    const evict = vi.spyOn(residency, 'evict').mockImplementation(async (documentId, expected) => {
      if (armed && documentId !== victim.documentId) {
        armed = false
        await repo.removeFromCache(victim.documentId)
        await repo.find(victimUrl)
      }
      return realEvict(documentId, expected)
    })

    const logged: Array<Record<string, unknown>> = []
    // Resident ids AT THE END OF THE PASS THAT REFUSED, captured from inside the
    // log call. The end of the TEST is the wrong moment to look: the refusal is
    // lifted by the next sweep, which takes a fresh snapshot and evicts the
    // document legitimately — the intended mechanism, not a leak.
    let residentAtFirstLog: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (typeof line === 'string' && line.includes('automerge.idle_eviction')) {
        if (logged.length === 0) residentAtFirstLog = Object.keys(repo.handles)
        logged.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    let calls: Array<[string, unknown]>
    try {
      const timer = startIdleEviction(repo, root.url, residency, 1, 10)
      await new Promise((resolve) => setTimeout(resolve, 25))
      await new Promise((resolve) => setTimeout(resolve, 25))
      clearInterval(timer)
      await residency.drain()
      // BEFORE `mockRestore`, which clears the recorded calls along with the
      // implementation — reading them afterwards yields an empty array and the
      // assertions below would pass vacuously.
      calls = evict.mock.calls.map((call) => [String(call[0]), call[1]])
    } finally {
      log.mockRestore()
      evict.mockRestore()
    }

    // Guard: the pass did work. Otherwise "nothing was evicted" would satisfy
    // the assertions below.
    expect(logged.length, 'aucune éviction : le test ne mesure rien').toBeGreaterThan(0)
    expect(calls.length, 'evict a bien été appelé par le balayage').toBeGreaterThan(1)
    expect(armed, 'le document victime a bien été repris en cours de passe').toBe(false)

    // Without the handle, the re-resolved document would be evicted from under
    // whoever just asked for it, and the orphan census would run on the dead
    // object.
    for (const [documentId, expected] of calls) {
      expect(expected, `le balayage doit transmettre la poignée pour ${documentId}`).toBeDefined()
    }
    expect(
      residentAtFirstLog,
      'le document repris a survécu à la passe qui l\'avait décidé',
    ).toContain(victim.documentId)
    // And the refusal is COUNTED: otherwise it would appear in neither
    // `evicted` nor any `skipped*`, and `evicted + skipped* + root ===
    // handlesBefore` would silently stop holding.
    expect(logged[0].skippedStaleHandle, 'le refus doit être visible dans le journal').toBe(1)
    expect(
      Number(logged[0].evicted) + Number(logged[0].skippedStaleHandle) + 1,
      'la charge utile doit rendre compte de chaque poignée de l\'instantané',
    ).toBe(logged[0].handlesBefore)
  })

  it('handlesAfter est une SECONDE mesure, jamais handlesBefore moins evicted', async () => {
    vi.useFakeTimers()
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    for (let i = 0; i < 4; i += 1) repo.create({ objects: { [`o${i}`]: { id: `o${i}` } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)

    // An eviction that ANNOUNCES without removing: the failure this field
    // exists to make visible.
    const removeFromCache = vi
      .spyOn(repo, 'removeFromCache')
      .mockImplementation(async () => {})
    const logged: Array<Record<string, unknown>> = []
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      if (typeof line === 'string' && line.includes('automerge.idle_eviction')) {
        logged.push(JSON.parse(line) as Record<string, unknown>)
      }
    })
    try {
      const timer = startIdleEviction(repo, root.url, residency, 1, 10)
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(10)
      clearInterval(timer)
      await residency.drain()
    } finally {
      log.mockRestore()
      removeFromCache.mockRestore()
    }

    expect(logged, 'aucune ligne d\'éviction : le test ne mesure rien').toHaveLength(1)
    const line = logged[0]
    expect(line.evicted, 'evict a compté ses évictions').toBe(4)
    // Deriving `handlesAfter: handlesBefore - evicted` would give 1: the witness
    // would move in the reassuring direction while nothing is actually removed.
    expect(line.handlesAfter, 'relire, pas dériver').toBe(line.handlesBefore)
    expect(line.handlesBefore).toBe(5)
  })
})

/**
 * The sweep must CONSUME its snapshot through `drainEntries`, not iterate an
 * array it keeps whole. A sweep that read `cachedHandles` once but iterated
 * normally would pass the read-count test above while retaining all n
 * documents until the end of the pass.
 */
describe('T11.3bis site A — le balayage libère ce qu\'il vient de traiter', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('chaque entrée de l\'instantané est libérée au fur et à mesure du balayage', async () => {
    const compat = await import('./automergeRepoCompat.js')
    const handed: Array<Array<readonly [string, unknown] | undefined>> = []
    // Capture the real generator BEFORE spying. Reading `compat.drainEntries`
    // from inside the mock would re-enter the mock, and the delegation would
    // never reach the implementation under test — a fixture that silently tests
    // nothing.
    const real = compat.drainEntries
    const drainEntries = vi.spyOn(compat, 'drainEntries').mockImplementation(function* (entries) {
      handed.push(entries as Array<readonly [string, unknown] | undefined>)
      yield* real(entries)
    })

    vi.useFakeTimers()
    const repo = new Repo({ network: [] })
    const root = repo.create({ modelUrl: '', shardUrls: [] as string[] })
    for (let i = 0; i < 6; i += 1) repo.create({ objects: { [`o${i}`]: { id: `o${i}` } } })
    const residency = new AutomergeResidencyLeases(repo)
    residency.protect(root)
    const timer = startIdleEviction(repo, root.url, residency, 1, 10)
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(10)
    clearInterval(timer)
    await residency.drain()
    drainEntries.mockRestore()

    // `for (const handle of Object.values(cachedHandles(repo)))` would keep the
    // read count at 2 while pinning all 7 documents for the whole pass.
    expect(handed.length, 'le balayage doit passer par drainEntries').toBeGreaterThan(0)
    for (const entries of handed) {
      expect(entries.length, 'l\'instantané n\'était pas vide').toBeGreaterThan(0)
      expect(
        entries.filter(Boolean),
        'à la fin de la passe, l\'instantané ne retient plus rien',
      ).toEqual([])
    }
    expect(Object.keys(repo.handles as Record<DocumentId, unknown>)).toHaveLength(1)
  })
})
