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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Repo,
  type Chunk,
  type StorageAdapterInterface,
  type StorageKey,
} from '@automerge/automerge-repo'
import { WorkspaceDocIndex, notifyWorkspaceDocumentsCreated } from './docScope.js'
import {
  noteServerCreationPlacement,
  purgeServerCreationPlacement,
  resetServerCreationPlacementForTest,
  serverCreationPlacementFor,
  placementForFence,
  serverCreationPlacementSnapshot,
} from './serverCreationPlacement.js'
import { createDocumentForWorkspace, WriteAuthorityLostError } from './workspaceWriter.js'
import { requireWriteAuthority } from '../syncCells/writeAuthority.js'

/**
 * THE ORDERING, OBSERVED THROUGH A REAL `Repo`.
 *
 * The property is a race, so it is measured against the thing that runs the
 * race. A hand-built fake would prove that this file calls
 * `noteServerCreationPlacement` before it calls `flush`; only a real `Repo`
 * with a real storage adapter proves that the note is in place when AUTOMERGE
 * decides to write, which is the moment the storage fence is asked and the only
 * moment that matters.
 *
 * The recording adapter is the fence's stand-in: it asks the same question the
 * `PostgresStorageAdapter` asks — `serverCreationPlacementFor(key[0])` — at the
 * same instant, and records the answer. `key[0]` is the documentId; Automerge's
 * storage keys are `[documentId, 'snapshot'|'incremental', …]`.
 */

/** Records what the placement seam answered at every save. */
class RecordingStorage implements StorageAdapterInterface {
  readonly saves: { documentId: string; placement: string | null }[] = []
  private readonly entries = new Map<string, { key: StorageKey; data: Uint8Array }>()

  private keyText(key: StorageKey): string {
    return key.join('/')
  }

  async load(key: StorageKey): Promise<Uint8Array | undefined> {
    return this.entries.get(this.keyText(key))?.data.slice()
  }

  async save(key: StorageKey, data: Uint8Array): Promise<void> {
    const documentId = key[0]!
    // THE FENCE'S QUESTION, ASKED WHERE THE FENCE ASKS IT. Recording the answer
    // rather than asserting here keeps the failure legible: an arm that threw
    // inside the adapter would surface as an Automerge internal error.
    const placement = serverCreationPlacementFor(documentId)
    this.saves.push({
      documentId,
      placement: placement ? `${placement.landscapeId}/${placement.versionId}` : null,
    })
    this.entries.set(this.keyText(key), { key: [...key], data: data.slice() })
  }

  async remove(key: StorageKey): Promise<void> {
    this.entries.delete(this.keyText(key))
  }

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

const WORKSPACE = { landscapeId: 'L-writer', versionId: 'V-writer' }

/** An ownership stub in the shape `requireWriteAuthority` reads. */
function ownership(overrides: { owns?: boolean; token?: string | null } = {}) {
  return {
    enabled: true,
    owns: () => overrides.owns ?? true,
    fencingToken: () => ('token' in overrides ? (overrides.token ?? null) : '7'),
  }
}

describe('B2-4 — server-created placement is known at save time', () => {
  beforeEach(() => resetServerCreationPlacementForTest())
  afterEach(() => resetServerCreationPlacementForTest())

  it('every save of a written document sees the authority’s workspace', async () => {
    const storage = new RecordingStorage()
    const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })
    // The claiming index is what `createClaimedDocument` reaches; a fake pool
    // answers the one statement, so this stays DB-free.
    new WorkspaceDocIndex(repo, {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('INSERT') && sql.includes('automerge_document_workspace')) {
          const first = params?.[0]
          const ids = Array.isArray(first) ? first as string[] : [String(first)]
          return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
        }
        return { rows: [], rowCount: 0 }
      },
    } as never)

    const authority = requireWriteAuthority(ownership(), WORKSPACE)
    const handle = await createDocumentForWorkspace({
      repo, authority, rootUrl: 'automerge:root-writer',
    }, { hello: 'world' })

    const documentId = String(handle.documentId)
    const saves = storage.saves.filter((save) => save.documentId === documentId)

    // `saveCalls > 0` FIRST. Every assertion below is over this array, and an
    // empty array satisfies `every()` — so without this line the arm passes
    // most loudly when Automerge wrote nothing at all.
    expect(saves.length, 'the repo never saved the document — this arm proved nothing').toBeGreaterThan(0)
    expect(
      saves.map((save) => save.placement),
      `a save saw no placement; ${JSON.stringify(storage.saves)}`,
    ).toEqual(saves.map(() => `${WORKSPACE.landscapeId}/${WORKSPACE.versionId}`))
  })

  it('the note is SYNCHRONOUS, and one yield before ready proves it has to be', async () => {
    // The note's SYNCHRONOUS position (before `await handle.whenReady()`) is
    // load-bearing, even though a plain Repo does not show it.
    //
    // THE MECHANISM: `repo.create()` schedules the document's first save on a
    // TIMER, while a fresh handle becomes ready on a MICROTASK. Ready wins only
    // because nothing yields between the two. Insert a single yield — an audit
    // write, a metrics call, a re-read of the authority, anything added to
    // `createClaimedDocument` — and the save lands FIRST, silently unfenced.
    //
    // So this arm widens the window deliberately: a repo whose `whenReady`
    // defers by one macrotask. With the note taken synchronously every save
    // sees it; move the note below the await and this goes red.
    const storage = new RecordingStorage()
    const real = new Repo({ storage, network: [], saveDebounceRate: 0 })
    new WorkspaceDocIndex(real, {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('INSERT') && sql.includes('automerge_document_workspace')) {
          const first = params?.[0]
          const ids = Array.isArray(first) ? first as string[] : [String(first)]
          return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
        }
        return { rows: [], rowCount: 0 }
      },
    } as never)

    // Only `whenReady` is deferred. The save timer is untouched, so this widens
    // the real window rather than inventing a different one.
    const deferredRepo = {
      create<T>(value: T) {
        const handle = real.create<T>(value)
        const inner = handle.whenReady.bind(handle)
        Object.defineProperty(handle, 'whenReady', {
          value: async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, 20))
            return (inner as (...a: unknown[]) => Promise<void>)(...args)
          },
          configurable: true,
        })
        return handle
      },
      flush: (ids: unknown) => real.flush(ids as never),
    }

    const authority = requireWriteAuthority(ownership(), WORKSPACE)
    const handle = await createDocumentForWorkspace({
      repo: deferredRepo as never, authority, rootUrl: 'automerge:root-writer',
    }, { hello: 'world' })

    const documentId = String(handle.documentId)
    const saves = storage.saves.filter((save) => save.documentId === documentId)
    expect(saves.length, 'no save landed inside the widened window — this arm proved nothing')
      .toBeGreaterThan(0)
    expect(
      saves.map((save) => save.placement),
      `a save landed before the placement was noted; ${JSON.stringify(storage.saves)}`,
    ).toEqual(saves.map(() => `${WORKSPACE.landscapeId}/${WORKSPACE.versionId}`))
  })

  it('the placement is gone once the claim lands, and the claim is what removes it', async () => {
    // Purge-on-claim, driven through the real notify path rather than by
    // calling `purgeServerCreationPlacement` — otherwise this asserts that a
    // function this file called does what this file called it to do.
    const claimed: string[] = []
    const repo = new Repo({ network: [] })
    new WorkspaceDocIndex(repo, {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('INSERT') && sql.includes('automerge_document_workspace')) {
          const first = params?.[0]
          const ids = Array.isArray(first) ? first as string[] : [String(first)]
          claimed.push(...ids)
          return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
        }
        return { rows: [], rowCount: 0 }
      },
    } as never)

    noteServerCreationPlacement('doc-claimed', WORKSPACE)
    noteServerCreationPlacement('doc-unclaimed', WORKSPACE)
    expect(serverCreationPlacementFor('doc-claimed')).toEqual(WORKSPACE)

    await notifyWorkspaceDocumentsCreated({
      ...WORKSPACE, rootUrl: 'automerge:root-writer', documentIds: ['doc-claimed'],
    })

    expect(claimed, 'the claim never reached the database — the purge would be untested').toContain('doc-claimed')
    expect(serverCreationPlacementFor('doc-claimed')).toBeNull()
    // AND ONLY THAT ONE. A purge that cleared the map would also satisfy the
    // line above, and would unfence every other document in flight.
    expect(serverCreationPlacementFor('doc-unclaimed')).toEqual(WORKSPACE)
  })

  it('a REFUSED claim leaves the placement intact — the purge is after the guards', async () => {
    // The purge runs AFTER the claim's guards, deliberately, and only this arm
    // checks that ordering.
    //
    // Why it matters: a claim that was refused did NOT land, so the durable
    // row the fence would read does not exist. Forgetting the placement there
    // unfences every retry of exactly the document whose claim is in trouble —
    // the case the map exists for, discarded at the moment of need.
    const repo = new Repo({ network: [] })
    // The claim INSERT matches nothing and the `versions` probe finds no row,
    // which is how `claimDocumentsBatch` reports `missingVersion` — the loudest
    // of the two refusals, and the one whose message names the ordering rule.
    new WorkspaceDocIndex(repo, {
      query: async () => ({ rows: [], rowCount: 0 }),
    } as never)

    noteServerCreationPlacement('doc-refused', WORKSPACE)

    await expect(notifyWorkspaceDocumentsCreated({
      ...WORKSPACE, rootUrl: 'automerge:root-writer', documentIds: ['doc-refused'],
    })).rejects.toThrow(/no versions row exists/)

    expect(
      serverCreationPlacementFor('doc-refused'),
      'a refused claim forgot where the document belongs — its retries are now unfenced',
    ).toEqual(WORKSPACE)
  })

  it('a READ does not evict, however many times the entry is read', async () => {
    // The word "LRU" usually implies the opposite, which is why this is asserted
    // by name: an evicting read would fence the first save and nothing after it.
    // The property the map needs is that an entry survives being read.
    noteServerCreationPlacement('doc-hot', WORKSPACE)
    for (let i = 0; i < 50; i += 1) {
      expect(serverCreationPlacementFor('doc-hot')).toEqual(WORKSPACE)
    }
    expect(serverCreationPlacementSnapshot().size).toBe(1)
    expect(serverCreationPlacementSnapshot().overflowCount).toBe(0)
  })

  it('neither side of the map can be corrupted by a caller mutating a key', () => {
    // BOTH DIRECTIONS are copied: a read side handing out the live object would
    // let a consumer mutating what it was given rewrite the map. The storage
    // call sites only read the two fields, which is exactly why this hazard
    // needs a test rather than vigilance.
    const mutableWrite = { landscapeId: 'L-write', versionId: 'V-write' }
    noteServerCreationPlacement('doc-alias', mutableWrite)
    mutableWrite.landscapeId = 'L-HIJACKED-VIA-WRITE'
    expect(serverCreationPlacementFor('doc-alias')).toEqual({
      landscapeId: 'L-write', versionId: 'V-write',
    })

    const handedOut = serverCreationPlacementFor('doc-alias')!
    handedOut.landscapeId = 'L-HIJACKED-VIA-READ'
    expect(
      serverCreationPlacementFor('doc-alias'),
      'a consumer mutating the returned key rewrote the map',
    ).toEqual({ landscapeId: 'L-write', versionId: 'V-write' })
  })

  it('re-noting at CAPACITY does not evict a live entry for nothing', () => {
    // WHAT THE `has` GUARD ACTUALLY BUYS. Not recency (`Map.set` on an existing
    // key does not move it), but this ceiling case: without the guard,
    // re-noting while full evicts the oldest entry and then re-`set`s a key
    // that is already there, losing a live placement and bumping the overflow
    // counter for nothing.
    const { capacity } = serverCreationPlacementSnapshot()
    for (let i = 0; i < capacity; i += 1) noteServerCreationPlacement(`fill-${i}`, WORKSPACE)
    expect(serverCreationPlacementSnapshot()).toMatchObject({ size: capacity, overflowCount: 0 })

    noteServerCreationPlacement('fill-5', WORKSPACE)

    expect(serverCreationPlacementSnapshot().overflowCount, 're-noting an existing key evicted something')
      .toBe(0)
    expect(serverCreationPlacementSnapshot().size).toBe(capacity)
    // AND THE OLDEST SURVIVED. `overflowCount === 0` alone would pass on an
    // eviction that forgot to count itself, which is the other way to be wrong.
    expect(serverCreationPlacementFor('fill-0')).toEqual(WORKSPACE)
  })

  it('the map is BOUNDED, and it counts what it dropped', async () => {
    const { capacity } = serverCreationPlacementSnapshot()
    for (let i = 0; i < capacity + 5; i += 1) {
      noteServerCreationPlacement(`doc-${i}`, WORKSPACE)
    }

    const after = serverCreationPlacementSnapshot()
    expect(after.size, 'the map grew past its capacity — this is a leak with a slow fuse').toBe(capacity)
    // THE COUNTER IS THE POINT. A silent eviction does not fail; it returns the
    // oldest documents to unconditional admission, and nothing else in the
    // process would say so.
    expect(after.overflowCount).toBe(5)
    // OLDEST OUT, NEWEST IN — stated because "bounded" alone is satisfied by a
    // map that drops the newest, which would forget the document most likely
    // still to be saved.
    expect(serverCreationPlacementFor('doc-0')).toBeNull()
    expect(serverCreationPlacementFor(`doc-${capacity + 4}`)).toEqual(WORKSPACE)
  })

  it('an authority that moved between the grant and the mint creates NOTHING', async () => {
    const storage = new RecordingStorage()
    const repo = new Repo({ storage, network: [], saveDebounceRate: 0 })

    // Granted while this cell owns the workspace…
    let owns = true
    const authority = requireWriteAuthority({
      enabled: true,
      owns: () => owns,
      fencingToken: () => '7',
    }, WORKSPACE)
    expect(authority.stillHeld()).toBe(true)

    // …and lost before the write, which is the case `stillHeld` exists for: a
    // handler that took its authority at the top and awaited three times.
    owns = false

    await expect(createDocumentForWorkspace({
      repo, authority, rootUrl: 'automerge:root-writer',
    }, { hello: 'world' })).rejects.toBeInstanceOf(WriteAuthorityLostError)

    // NO DOCUMENT WAS WRITTEN. "It threw" is only half — a mint that happened
    // and then threw would leave an unclaimed document behind.
    //
    // `storage-adapter-id` is excluded by name, not by a loose filter: a `Repo`
    // persists its own adapter identity under that key at construction, so it
    // is present in every run whether or not a document was ever created.
    const documentSaves = storage.saves.filter((save) => save.documentId !== 'storage-adapter-id')
    expect(documentSaves, `a document was saved despite the refusal: ${JSON.stringify(storage.saves)}`)
      .toHaveLength(0)
    expect(serverCreationPlacementSnapshot().size).toBe(0)
  })

  it('the FENCE sees nothing under the default mode, and sees the placement under refuse', () => {
    // The placement map exists by default; only the FENCE's view of it is
    // armed, by `SYNC_CELL_UNPLACED_CREATION=refuse`.
    //
    // The mechanism: `withFencedMutation` throws `StaleSyncCellWriteError` when
    // it has a workspace and no local token — `if (fenceWorkspace) { … if
    // (!localToken) throw }`. Handing it a placement for a document minted on a
    // cell that does NOT own the workspace turns an admitted save into a failed
    // one, and `SYNC_CELL_OWNERSHIP` is `on` in every supported manifest, so
    // arming it is a live behaviour change, not a latent one.
    //
    // The census still needs to COUNT these, which is why the raw read stays
    // ungated and only the fence's read is behind the flag: counting happens
    // under `observe`, and enforcement flips one variable.
    const previous = process.env.SYNC_CELL_UNPLACED_CREATION
    try {
      noteServerCreationPlacement('doc-gated', WORKSPACE)

      delete process.env.SYNC_CELL_UNPLACED_CREATION
      expect(
        placementForFence('doc-gated'),
        'the fence can see a server-created placement by default — this arms B2-9 early',
      ).toBeNull()
      // …while the census still can. If this were null too, there would be
      // nothing to count and enforcement could never be safely enabled.
      expect(serverCreationPlacementFor('doc-gated')).toEqual(WORKSPACE)

      // A TYPO IS `observe`, not `refuse`. The safe setting is the one nobody
      // has to type correctly.
      process.env.SYNC_CELL_UNPLACED_CREATION = 'refuze'
      expect(placementForFence('doc-gated')).toBeNull()

      process.env.SYNC_CELL_UNPLACED_CREATION = 'refuse'
      expect(placementForFence('doc-gated')).toEqual(WORKSPACE)
    } finally {
      if (previous === undefined) delete process.env.SYNC_CELL_UNPLACED_CREATION
      else process.env.SYNC_CELL_UNPLACED_CREATION = previous
    }
  })

  it('purging an id that was never noted is a no-op, not a throw', () => {
    // The claim path also handles documents this process did not mint — every
    // browser-created document reaching a claim batch. A purge that threw there
    // would turn an ordinary claim into a failed one.
    noteServerCreationPlacement('doc-kept', WORKSPACE)
    expect(() => purgeServerCreationPlacement(['doc-never-seen', 'doc-kept'])).not.toThrow()
    expect(serverCreationPlacementFor('doc-kept')).toBeNull()
    expect(serverCreationPlacementSnapshot().size).toBe(0)
  })
})
