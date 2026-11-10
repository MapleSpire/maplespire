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

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Repo, type AutomergeUrl, type DocHandle } from '@automerge/automerge-repo'
import * as A from '@automerge/automerge'
import {
  createClaimedOverlaySegment,
  deleteOverlayEntities,
  OVERLAY_CONTENT_CHUNK_BYTES,
  OverlaySegmentAbortedError,
  overlayContentChunks,
  overlaySegmentUrls,
  writeOverlayEntities,
  type OverlayMetaLike,
} from './overlaySegments.js'
import { OVERLAY_WRITE_HEAD_VERSION } from './modelMeta.js'
import { WorkspaceDocIndex, setWorkspaceDocumentsRegistrationForTest } from './rbac/docScope.js'
import { serverCreationPlacementFor } from './rbac/serverCreationPlacement.js'

describe('bounded overlay segments', () => {
  it('splits a large batch, preserves last-wins order and deletes across segments', async () => {
    const repo = new Repo({})
    const meta = repo.create<OverlayMetaLike>({ objectShardUrls: [], connectionShardUrls: [] })
    await meta.whenReady()
    await writeOverlayEntities(repo, meta, 'objects', {
      a: { id: 'a', name: 'A' },
      b: { id: 'b', name: 'B' },
      c: { id: 'c', name: 'C' },
      d: { id: 'd', name: 'D' },
      e: { id: 'e', name: 'E' },
    }, 2)

    const urls = overlaySegmentUrls(meta.doc(), 'objects')
    expect(urls).toHaveLength(3)
    expect(meta.doc()?.objectShardUrls).toEqual(urls)
    expect(meta.doc()?.editsObjectShardUrl).toBe(urls.at(-1))
    // Against the constant, not `1`, so a producer that hardcodes the digit
    // after a protocol bump still fails.
    expect(meta.doc()?.editsOverlayWriteHeadVersion).toBe(OVERLAY_WRITE_HEAD_VERSION)
    const counts: number[] = []
    for (const url of urls) {
      const handle = await repo.find<{ objects: Record<string, unknown> }>(url as AutomergeUrl)
      await handle.whenReady()
      counts.push(Object.keys(handle.doc()?.objects ?? {}).length)
    }
    expect(counts).toEqual([2, 2, 1])

    await deleteOverlayEntities(repo, meta, 'objects', ['a', 'e'])
    const remaining: string[] = []
    for (const url of urls) {
      const handle = await repo.find<{ objects: Record<string, unknown> }>(url as AutomergeUrl)
      remaining.push(...Object.keys(handle.doc()?.objects ?? {}))
    }
    expect(remaining.sort()).toEqual(['b', 'c', 'd'])
  })

  it('a fresh segment is CLAIMED, and claimed before ModelMeta advertises it', async () => {
    // Guards against ModelMeta publishing a pointer to a segment no workspace
    // owns — invisible to the catalog walk, unattributable by the route gate,
    // unseen by the projector. Both kinds of event go into ONE ordered stream:
    // indices in two separate arrays say nothing about relative order.
    const events: string[] = []
    const repo = new Repo({})
    const meta = repo.create<OverlayMetaLike>({ objectShardUrls: [], connectionShardUrls: [] })
    await meta.whenReady()

    // The pointer's publication is what the claim must precede, so it is
    // observed rather than inferred: ModelMeta learns the URL inside
    // `createSegment`, after the claim.
    meta.on('change', ({ patchInfo }) => {
      const after = (patchInfo?.after ?? {}) as { objectShardUrls?: string[] }
      for (const url of after.objectShardUrls ?? []) {
        const advertise = `advertise:${url.replace(/^automerge:/, '')}`
        if (!events.includes(advertise)) events.push(advertise)
      }
    })

    // The claim is observed at the DB boundary, which is the only seam without
    // a subscription hook: constructing a `WorkspaceDocIndex` installs the
    // module-level registration that `notifyWorkspaceDocumentCreated` calls.
    // Same shape as `ai/core/modelOps.durability.test.ts`, and DB-free — the fake pool
    // answers the one statement that matters.
    const workspace = { landscapeId: 'L-overlay', versionId: 'V-overlay' }
    const claimingPool = {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.trim().startsWith('INSERT') && sql.includes('automerge_document_workspace')) {
          const first = params?.[0]
          const ids = Array.isArray(first) ? first as string[] : [String(first)]
          // The workspace comes from the insert's own parameters, so a claim
          // naming the WRONG workspace cannot satisfy this arm.
          for (const id of ids) events.push(`claim:${id}:${String(params?.[1])}/${String(params?.[2])}`)
          return { rows: ids.map((id) => ({ document_id: id })), rowCount: ids.length }
        }
        return { rows: [], rowCount: 0 }
      },
    }
    new WorkspaceDocIndex(repo, claimingPool as never)

    await writeOverlayEntities(repo, meta, 'objects', { a: { id: 'a' } }, 2, undefined, {
      workspace,
      rootUrl: 'automerge:root-overlay',
    })

    const urls = overlaySegmentUrls(meta.doc(), 'objects')
    expect(urls, 'no segment was created — this arm exercised nothing').toHaveLength(1)
    const segmentId = urls[0]!.replace(/^automerge:/, '')

    // Claimed to THIS workspace (read from the insert's parameters).
    const claimAt = events.indexOf(
      `claim:${segmentId}:${workspace.landscapeId}/${workspace.versionId}`,
    )
    const advertiseAt = events.indexOf(`advertise:${segmentId}`)
    expect(claimAt, `the fresh overlay segment was never claimed; saw ${JSON.stringify(events)}`)
      .toBeGreaterThan(-1)
    expect(advertiseAt, `ModelMeta never advertised the segment; saw ${JSON.stringify(events)}`)
      .toBeGreaterThan(-1)

    // AND BEFORE THE POINTER. Ordering is the half a claim-existence assertion
    // cannot see: claiming after `metaHandle.change` leaves exactly the window
    // where a restart publishes a link to an unclaimed document.
    expect(
      claimAt,
      `the segment was advertised before it was claimed; saw ${JSON.stringify(events)}`,
    ).toBeLessThan(advertiseAt)
  })

  // `x ?? (x = [])` / `?? (x = {})` yield the plain value the assignment was
  // given, not the document's proxy, so a write into it was silently dropped
  // whenever the field was absent (older ModelMeta, partial imports).
  it('a ModelMeta WITHOUT objectShardUrls still lists the segment it creates', async () => {
    const repo = new Repo({})
    const meta = repo.create<OverlayMetaLike>({})
    await meta.whenReady()
    await writeOverlayEntities(repo, meta, 'objects', { a: { id: 'a' } })

    const urls = overlaySegmentUrls(meta.doc(), 'objects')
    expect(urls).toHaveLength(1)
    expect(meta.doc()?.objectShardUrls).toEqual(urls)
  })

  it('a current segment WITHOUT its collection map still receives the write', async () => {
    const repo = new Repo({})
    const segment = repo.create<Record<string, unknown>>({ marker: 1 })
    await segment.whenReady()
    const meta = repo.create<OverlayMetaLike>({
      objectShardUrls: [segment.url], editsObjectShardUrl: segment.url, editsObjectShardUrls: [segment.url],
    })
    await meta.whenReady()
    await writeOverlayEntities(repo, meta, 'objects', { a: { id: 'a', name: 'A' } })

    expect(overlaySegmentUrls(meta.doc(), 'objects')).toEqual([segment.url])
    expect(segment.doc()?.objects).toEqual({ a: { id: 'a', name: 'A' } })
  })
})

// Ported from the phase-3 QA lens (mutants S04, S05, S06): the ordinary
// rotator's child is the one caller that asks for an owner placement note.
describe('owner placement note on createClaimedOverlaySegment', () => {
  const WS = { landscapeId: 'L-place', versionId: 'V1' }
  let restore: () => void = () => {}
  afterEach(() => { restore(); restore = () => {}; vi.restoreAllMocks() })

  it('ownerPlacement: noted SYNCHRONOUSLY at the mint and present at the claim', async () => {
    const repo = new Repo({})
    const atClaim: Array<{ id: string; placement: unknown }> = []
    restore = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) => {
      for (const id of documentIds) atClaim.push({ id, placement: serverCreationPlacementFor(id) })
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    let minted: DocHandle<unknown> | null = null
    const create = repo.create.bind(repo)
    vi.spyOn(repo, 'create').mockImplementation(((initial: unknown) => {
      const handle = create(initial as never)
      minted = handle as DocHandle<unknown>
      return handle
    }) as never)
    const pending = createClaimedOverlaySegment(repo, 'objects', undefined, {
      workspace: WS, rootUrl: 'automerge:root', ownerPlacement: true,
    })
    // Same synchronous frame as the mint: no await has run yet.
    expect(minted, 'repo.create was not reached synchronously').not.toBeNull()
    expect(serverCreationPlacementFor(String(minted!.documentId))).toEqual(WS)
    const handle = await pending
    expect(atClaim).toEqual([{ id: String(handle.documentId), placement: WS }])
  })

  it('the static callers (no ownerPlacement) take NO placement note', async () => {
    const repo = new Repo({})
    const atClaim: Array<{ id: string; placement: unknown }> = []
    restore = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) => {
      for (const id of documentIds) atClaim.push({ id, placement: serverCreationPlacementFor(id) })
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    const meta = repo.create<OverlayMetaLike>({ objectShardUrls: [], connectionShardUrls: [] })
    await meta.whenReady()
    await writeOverlayEntities(repo, meta, 'objects', { a: { id: 'a' } }, 2, undefined, {
      workspace: WS, rootUrl: 'automerge:root',
    })
    expect(atClaim).toHaveLength(1) // anti-void: a segment was minted and claimed
    expect(atClaim[0]!.placement).toBeNull()
  })
})

describe('createClaimedOverlaySegment content (G4-16b phase 4, a fold product)', () => {
  it('the fields are in the creating change, and extra fields can neither replace the entity map nor pre-fill writeBatchIds', async () => {
    const repo = new Repo({})
    const restore = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) =>
      ({ claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }))
    try {
      const handle = await createClaimedOverlaySegment(repo, 'objects', undefined,
        { workspace: { landscapeId: 'L-content', versionId: 'V1' }, rootUrl: 'automerge:root' },
        {
          entities: { a: { id: 'a', name: 'A' } },
          fields: { objects: { evil: { id: 'evil' } }, writeBatchIds: ['forged'], foldedFromUrls: ['automerge:x'] },
        })
      const doc = handle.doc() as unknown as Record<string, unknown>
      expect(doc.foldedFromUrls).toEqual(['automerge:x'])
      expect(doc.objects).toEqual({ a: { id: 'a', name: 'A' } })
      expect(doc.writeBatchIds).toEqual([])
      // The marker is born with the document, the entities after it.
      const changes = A.getAllChanges(handle.doc() as A.Doc<unknown>)
      expect(changes).toHaveLength(2)
      const atBirth = A.view(handle.doc() as A.Doc<unknown>, [A.decodeChange(changes[0]!).hash]) as Record<string, unknown>
      expect(atBirth.foldedFromUrls).toEqual(['automerge:x'])
      expect(atBirth.objects).toEqual({})
    } finally {
      restore()
    }
  })

  it('G4-16 M3: a large content is written in bounded changes, one timer tick apart, all before the claim', async () => {
    const repo = new Repo({})
    // ~1 KiB entities: several chunks at the 8 KiB budget.
    const entities = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      [`e${i}`, { id: `e${i}`, name: `entity ${i}`, notes: 'n'.repeat(1_000) }]))
    let seenAtClaim: Record<string, unknown> | undefined
    let handleRef: DocHandle<unknown> | undefined
    const restore = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) => {
      seenAtClaim = (handleRef?.doc() as Record<string, Record<string, unknown>> | undefined)?.objects
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    let ticks = 0
    const ticker = setInterval(() => { ticks += 1 }, 0)
    try {
      const created = createClaimedOverlaySegment(repo, 'objects', (handle) => { handleRef = handle },
        { workspace: { landscapeId: 'L-chunks', versionId: 'V1' }, rootUrl: 'automerge:root' },
        { entities, fields: { foldedFromUrls: ['automerge:x'] } })
      const handle = await created
      const chunks = overlayContentChunks(entities)
      expect(chunks.length).toBeGreaterThanOrEqual(4)
      // One change per chunk after the creating one.
      expect(A.getAllChanges(handle.doc() as A.Doc<unknown>)).toHaveLength(1 + chunks.length)
      // The timers ran between the chunks: the event loop was given back.
      expect(ticks).toBeGreaterThanOrEqual(chunks.length - 1)
      expect((handle.doc() as Record<string, unknown>).objects).toEqual(entities)
      // Whole before anything is told about it.
      expect(seenAtClaim).toEqual(entities)
    } finally {
      clearInterval(ticker)
      restore()
    }
  })
})

describe('createClaimedOverlaySegment content: the yield between changes (QA)', () => {
  it('QA: every change after the first is preceded by a setTimeout(0) of its own', async () => {
    const repo = new Repo({})
    const entities = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
      [`e${i}`, { id: `e${i}`, name: `entity ${i}`, notes: 'n'.repeat(1_000) }]))
    const restore = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) =>
      ({ claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }))
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    try {
      const chunks = overlayContentChunks(entities)
      const before = timeouts.mock.calls.filter((call) => call[1] === 0).length
      await createClaimedOverlaySegment(repo, 'objects', undefined,
        { workspace: { landscapeId: 'L-yield', versionId: 'V1' }, rootUrl: 'automerge:root' }, { entities })
      const zero = timeouts.mock.calls.filter((call) => call[1] === 0).length - before
      expect(zero).toBeGreaterThanOrEqual(chunks.length)
    } finally {
      timeouts.mockRestore()
      restore()
    }
  })
})

describe('createClaimedOverlaySegment content: `proceed` stops the build (G4-16 M3 review)', () => {
  const entities = Object.fromEntries(Array.from({ length: 40 }, (_, i) =>
    [`e${i}`, { id: `e${i}`, name: `entity ${i}`, notes: 'n'.repeat(1_000) }]))
  const run = async (proceed: () => boolean) => {
    const claimed: string[] = []
    const restore = setWorkspaceDocumentsRegistrationForTest(async ({ documentIds }) => {
      claimed.push(...documentIds)
      return { claimed: documentIds, alreadyOurs: [], foreign: [], missingVersion: false }
    })
    let handle: DocHandle<unknown> | undefined
    try {
      const outcome = await createClaimedOverlaySegment(new Repo({}), 'objects', (touched) => { handle = touched },
        { workspace: { landscapeId: 'L-abort', versionId: 'V1' }, rootUrl: 'automerge:root' },
        { entities, proceed }).then(() => 'claimed', (error: unknown) => error)
      return { outcome, claimed, handle }
    } finally {
      restore()
    }
  }

  it('false between two chunks: no further change, no claim, and the error names the document', async () => {
    let asked = 0
    const { outcome, claimed, handle } = await run(() => { asked += 1; return asked <= 2 })
    expect(outcome).toBeInstanceOf(OverlaySegmentAbortedError)
    expect((outcome as OverlaySegmentAbortedError).documentId).toBe(String(handle!.documentId))
    expect(claimed).toEqual([])
    // The creating change and the two chunks asked for before the refusal.
    expect(A.getAllChanges(handle!.doc() as A.Doc<unknown>)).toHaveLength(3)
  })

  it('false only after the last chunk: everything written, but no claim', async () => {
    const chunks = overlayContentChunks(entities).length
    let asked = 0
    const { outcome, claimed, handle } = await run(() => { asked += 1; return asked <= chunks })
    expect(outcome).toBeInstanceOf(OverlaySegmentAbortedError)
    expect(claimed).toEqual([])
    expect((handle!.doc() as Record<string, unknown>).objects).toEqual(entities)
  })

  it('control: always true claims it', async () => {
    const { outcome, claimed, handle } = await run(() => true)
    expect(outcome).toBe('claimed')
    expect(claimed).toEqual([String(handle!.documentId)])
  })
})

describe('overlayContentChunks', () => {
  it('cuts in insertion order at the byte budget; an entity over the budget is alone; nothing gives no chunk', () => {
    const small = (id: string) => ({ id, v: 'x'.repeat(30) })
    const entities = { a: small('a'), b: small('b'), big: { id: 'big', v: 'y'.repeat(200) }, c: small('c') }
    const chunks = overlayContentChunks(entities, 60)
    expect(chunks.map((chunk) => chunk.map(([id]) => id))).toEqual([['a'], ['b'], ['big'], ['c']])
    const pairs = overlayContentChunks(entities, 100)
    expect(pairs.map((chunk) => chunk.map(([id]) => id))).toEqual([['a', 'b'], ['big'], ['c']])
    expect(overlayContentChunks({})).toEqual([])
    expect(overlayContentChunks(entities).flat().map(([id]) => id)).toEqual(['a', 'b', 'big', 'c'])
    expect(OVERLAY_CONTENT_CHUNK_BYTES).toBe(8_192)
  })
})
