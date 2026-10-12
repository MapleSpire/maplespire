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
import { Repo, type AutomergeUrl } from '@automerge/automerge-repo'
import {
  deleteOverlayEntities,
  overlaySegmentUrls,
  writeOverlayEntities,
  type OverlayMetaLike,
} from './overlaySegments.js'
import { OVERLAY_WRITE_HEAD_VERSION } from './modelMeta.js'
import { WorkspaceDocIndex } from './rbac/docScope.js'

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
})
