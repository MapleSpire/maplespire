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
import type { DocumentId } from '@automerge/automerge-repo'
import {
  DEFERRED_REFERENCES_KEY,
  DeferredReferenceQueue,
  ServerDurabilityWaiters,
  type DeferredReference,
} from './deferredReferences'
import { createMemoryKvStore } from '../modelQuery/kvStore'

const A = 'docA' as DocumentId
const B = 'docB' as DocumentId

/** Settles every promise callback queued so far. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('ServerDurabilityWaiters', () => {
  it('resolves a wait only when its own document is acknowledged', async () => {
    const waiters = new ServerDurabilityWaiters()
    let resolvedA = false
    void waiters.wait(A).then(() => { resolvedA = true })

    waiters.noteDurable([B])
    await flush()
    expect(resolvedA).toBe(false)

    waiters.noteDurable([A])
    await flush()
    expect(resolvedA).toBe(true)
    expect(waiters.pending).toBe(0)
  })

  it('resolves at once for a document already acknowledged in this session', async () => {
    const waiters = new ServerDurabilityWaiters()
    waiters.noteDurable([A])
    let resolved = false
    void waiters.wait(A).then(() => { resolved = true })
    await flush()
    expect(resolved).toBe(true)
  })

  it('clear() abandons pending waits and forgets acknowledgements (a new session asks again)', async () => {
    const waiters = new ServerDurabilityWaiters()
    let resolvedBefore = false
    void waiters.wait(A).then(() => { resolvedBefore = true })
    waiters.clear()
    waiters.noteDurable([B])
    await flush()
    expect(resolvedBefore).toBe(false)
    expect(waiters.pending).toBe(0)

    // The acknowledgement of B was noted after clear(); A's was never noted.
    let resolvedAfter = false
    void waiters.wait(A).then(() => { resolvedAfter = true })
    await flush()
    expect(resolvedAfter).toBe(false)
  })
})

describe('DeferredReferenceQueue', () => {
  const ref = (url: string): DeferredReference => ({ holderDocumentId: 'meta', field: 'objectShardUrls', url })

  it('persists added references, once each, and removes exactly the one named', async () => {
    const store = createMemoryKvStore()
    const queue = new DeferredReferenceQueue(() => store)
    await queue.add(ref('automerge:one'))
    await queue.add(ref('automerge:one'))
    await queue.add(ref('automerge:two'))
    await queue.add({ ...ref('automerge:two'), field: 'connectionShardUrls' })

    expect(await queue.list()).toEqual([
      ref('automerge:one'),
      ref('automerge:two'),
      { ...ref('automerge:two'), field: 'connectionShardUrls' },
    ])

    await queue.remove(ref('automerge:two'))
    expect(await queue.list()).toEqual([ref('automerge:one'), { ...ref('automerge:two'), field: 'connectionShardUrls' }])

    // A second queue over the same store (a reload) sees the same entries.
    expect(await new DeferredReferenceQueue(() => store).list()).toHaveLength(2)
  })

  it('loses neither of two concurrent adds (two tabs of one workspace)', async () => {
    const store = createMemoryKvStore()
    const queue = new DeferredReferenceQueue(() => store)
    await Promise.all([queue.add(ref('automerge:one')), queue.add(ref('automerge:two'))])
    expect((await queue.list()).map((r) => r.url).sort()).toEqual(['automerge:one', 'automerge:two'])
  })

  it('a remove racing another add keeps the add (both are one atomic update)', async () => {
    const store = createMemoryKvStore()
    const queue = new DeferredReferenceQueue(() => store)
    await queue.add(ref('automerge:one'))
    await Promise.all([queue.add(ref('automerge:two')), queue.remove(ref('automerge:one'))])
    expect(await queue.list()).toEqual([ref('automerge:two')])
  })

  it('counts resume failures and drops the entry at the limit', async () => {
    const store = createMemoryKvStore()
    const queue = new DeferredReferenceQueue(() => store)
    await queue.add(ref('automerge:one'))
    await queue.add(ref('automerge:two'))
    expect(await queue.noteResumeFailure(ref('automerge:one'), 2)).toBe(1)
    expect(await queue.list()).toEqual([{ ...ref('automerge:one'), resumeFailures: 1 }, ref('automerge:two')])
    expect(await queue.noteResumeFailure(ref('automerge:one'), 2)).toBe(2)
    expect(await queue.list()).toEqual([ref('automerge:two')])
  })

  it('ignores stored entries that are not references', async () => {
    const store = createMemoryKvStore()
    await store.set(DEFERRED_REFERENCES_KEY, [ref('automerge:ok'), { url: 'automerge:no-holder' }, null, 'x'])
    const queue = new DeferredReferenceQueue(() => store)
    expect(await queue.list()).toEqual([ref('automerge:ok')])
    await queue.add(ref('automerge:two'))
    expect(await store.get(DEFERRED_REFERENCES_KEY)).toEqual([ref('automerge:ok'), ref('automerge:two')])
  })

  it('keeps root registry-shard entries, with their write-head flag, beside model entries', async () => {
    const store = createMemoryKvStore()
    const registry: DeferredReference = { holderDocumentId: 'root', field: 'shardUrls', url: 'automerge:head', writeHead: true }
    await store.set(DEFERRED_REFERENCES_KEY, [
      ref('automerge:model'),
      registry,
      { holderDocumentId: 'root', field: 'registryWriteUrl', url: 'automerge:unknown-field' },
      { holderDocumentId: 'root', field: 'shardUrls', url: 'automerge:bad-flag', writeHead: 'yes' },
    ])
    const queue = new DeferredReferenceQueue(() => store)
    expect(await queue.list()).toEqual([ref('automerge:model'), registry])
  })
})
