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

import type { Repo } from '@automerge/automerge-repo'
import { describe, it, expect, vi } from 'vitest'
import {
  classifyDocumentResolutionError,
  describeDocumentResolutionFailure,
  documentIdOf,
  documentRepoState,
  releaseUnavailableDocument,
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './documentResolution.js'

/**
 * A repo whose progress query reports `state`, as automerge-repo does.
 *
 * `docSynchronizers` is DERIVED from `handles` rather than being a second
 * knob, because the real `Repo` cannot have one without the other: the two
 * key sets are equal in every reachable state, which is what lets production
 * read residency in O(1) instead of rebuilding the whole handle Record
 * (`automergeRepoCompat.seam.test.ts` pins that against a real Repo). A
 * fixture offering `handles` alone would model a repo that cannot exist, and
 * would then stay green over code reading the table production actually uses.
 */
function fakeRepo(state: string, overrides: Partial<Record<string, unknown>> = {}): Repo {
  const handles = (overrides.handles ?? {}) as Record<string, unknown>
  return {
    findWithProgress: () => ({ peek: () => ({ state }) }),
    ...overrides,
    handles,
    // A GETTER, not a snapshot: `removeFromCache` mutates `handles` in place,
    // so a table captured at construction stops matching the repo the moment a
    // test evicts anything.
    get synchronizer() {
      return {
        docSynchronizers: Object.fromEntries(
          Object.entries(handles).map(([id, handle]) => [id, { query: { handle } }]),
        ),
      }
    },
  } as unknown as Repo
}

describe('classifyDocumentResolutionError', () => {
  it('treats the repo unavailability message as retryable without probing the repo', () => {
    const probe = vi.fn(() => 'unknown' as const)

    expect(classifyDocumentResolutionError(new Error('Document abc is unavailable'), probe)).toBe('unavailable')
    expect(probe).not.toHaveBeenCalled()
  })

  it('never retries a deleted document or a malformed url', () => {
    const messages = [
      'Document abc was deleted',
      "Invalid AutomergeUrl: 'nope'",
      'Invalid document URL: nope',
      'Invalid documentId: nope',
      'Invalid URL: contains multiple heads sections',
      'Invalid head in URL: zz',
    ]

    for (const message of messages) {
      expect(classifyDocumentResolutionError(new Error(message))).toBe('invalid')
    }
  })

  it('propagates an unrelated failure instead of absorbing it into a retry loop', () => {
    const postgresOutage = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    })

    expect(classifyDocumentResolutionError(postgresOutage)).toBe('unexpected')
  })

  it('retries an unlabelled failure only when the repo state confirms unavailability', () => {
    const anonymous = new Error('boom')

    expect(classifyDocumentResolutionError(anonymous, () => 'unavailable')).toBe('unavailable')
    expect(classifyDocumentResolutionError(anonymous, () => 'deleted')).toBe('invalid')
    expect(classifyDocumentResolutionError(anonymous, () => 'ready')).toBe('unexpected')
    expect(classifyDocumentResolutionError(anonymous, () => 'unknown')).toBe('unexpected')
  })

  it('propagates cancellation untouched', () => {
    const aborted = Object.assign(new Error('aborted'), { name: 'AbortError' })

    expect(classifyDocumentResolutionError(aborted, () => 'unavailable')).toBe('aborted')
  })

  it('round-trips its own error types', () => {
    expect(classifyDocumentResolutionError(new DocumentTemporarilyUnavailableError('automerge:a', 3)))
      .toBe('unavailable')
    expect(classifyDocumentResolutionError(new DocumentPermanentlyUnavailableError('automerge:a')))
      .toBe('invalid')
  })

  it('handles non-Error rejections', () => {
    expect(classifyDocumentResolutionError('Document a is unavailable')).toBe('unavailable')
    expect(classifyDocumentResolutionError(undefined)).toBe('unexpected')
  })
})

describe('document resolution errors', () => {
  it('carries a bounded machine code and the original cause', () => {
    const cause = new Error('Document a is unavailable')
    const error = new DocumentTemporarilyUnavailableError('automerge:abc?heads=zz', 4, { cause })

    expect(error.code).toBe('read_model_document_unavailable')
    expect(error.retryable).toBe(true)
    expect(error.documentId).toBe('abc')
    expect(error.attempts).toBe(4)
    expect(error.cause).toBe(cause)
  })

  it('marks a permanently unresolvable reference as non-retryable', () => {
    const error = new DocumentPermanentlyUnavailableError('automerge:abc')

    expect(error.code).toBe('read_model_document_invalid')
    expect(error.retryable).toBe(false)
  })
})

describe('describeDocumentResolutionFailure', () => {
  it('logs an identifier and a bounded message, never document payload', () => {
    const failure = describeDocumentResolutionFailure(
      'automerge:abc?heads=deadbeef',
      new Error('x'.repeat(5_000)),
      'unexpected',
      2,
    )

    expect(failure).toMatchObject({ documentId: 'abc', outcome: 'unexpected', errorName: 'Error', attempts: 2 })
    expect(failure.errorMessage.length).toBe(200)
  })
})

describe('documentIdOf', () => {
  it('strips the scheme and any heads suffix', () => {
    expect(documentIdOf('automerge:abc?heads=zz')).toBe('abc')
    expect(documentIdOf('abc')).toBe('abc')
  })
})

describe('documentRepoState', () => {
  it('reports what the repo believes', () => {
    expect(documentRepoState(fakeRepo('unavailable'), 'automerge:a')).toBe('unavailable')
    expect(documentRepoState(fakeRepo('ready'), 'automerge:a')).toBe('ready')
    // `loading` is its own answer. `unknown` is reserved for "the probe could
    // not ask", which is a different fact about a different subject.
    expect(documentRepoState(fakeRepo('loading'), 'automerge:a')).toBe('loading')
    expect(documentRepoState(fakeRepo('a-state-2.7-invented'), 'automerge:a')).toBe('unknown')
  })

  it('falls back to the cached handle state', () => {
    // OUT OF DOMAIN ON PURPOSE. `DocHandle.state` on the pinned 2.6.0-alpha.2 is
    // `ready` or `deleted` and NOTHING else, so no real repo produces the
    // `unavailable` below: these two clauses are 2.5 compatibility. Keep the
    // case, but never read it as evidence about the installed version — a
    // fixture feeding the probe a state the repo cannot reach can keep a suite
    // green over a real defect (see the real-Repo case below).
    const repo = fakeRepo('loading', { handles: { a: { documentId: 'a', state: 'unavailable' } } })

    expect(documentRepoState(repo, 'automerge:a')).toBe('unavailable')
  })

  it('never throws when the repo cannot answer', () => {
    // A repo whose SYNCHRONIZER is intact and whose query throws: without the
    // synchronizer the residency lookup would throw first, and this test would
    // pass while never reaching the statement it names.
    const repo = fakeRepo('ready', {
      findWithProgress: () => { throw new Error('repo exploded') },
    })

    expect(documentRepoState(repo, 'automerge:a')).toBe('unknown')
  })
})

describe('releaseUnavailableDocument', () => {
  it('evicts only a document the repo actually reports as unavailable', async () => {
    const removeFromCache = vi.fn(async () => undefined)
    const unavailable = fakeRepo('unavailable', {
      handles: { a: { documentId: 'a', state: 'unavailable' } },
      removeFromCache,
    })

    await expect(releaseUnavailableDocument(unavailable, 'automerge:a')).resolves.toBe(true)
    expect(removeFromCache).toHaveBeenCalledWith('a')
  })

  it('leaves a healthy document cache entry alone', async () => {
    const removeFromCache = vi.fn(async () => undefined)
    const ready = fakeRepo('ready', {
      handles: { a: { documentId: 'a', state: 'ready' } },
      removeFromCache,
    })

    await expect(releaseUnavailableDocument(ready, 'automerge:a')).resolves.toBe(false)
    expect(removeFromCache).not.toHaveBeenCalled()
  })
})

/**
 * The probe must not repeat the repo's own lie.
 *
 * `DocHandle.state` is `deleted` or `ready` AND NOTHING ELSE in 2.6.0-alpha.2
 * (`this.#document.deleted ? "deleted" : "ready"`): there is no waiting state to
 * report, so the handle reads `ready` from the instant `find()` instantiates it
 * — for a document that has not received a single byte. The probe must never
 * short-circuit on `handleState === 'ready'`.
 * `documentResolution.conformance.test.ts` runs ONE table of cases through BOTH
 * the browser and server modules. This case stays here as well because it is
 * the only assertion in the tree that runs against `server/node_modules`, a
 * second install of the same pinned package; the conformance suite runs under
 * the root one.
 *
 * The two clauses ABOVE the `ready` arm still consult `handleState`, and must:
 * they can only push the answer toward "retry" or "give up", never toward "this
 * document has materialized". They are 2.5 compatibility; 2.6 never produces
 * them.
 *
 * Every fixture in this file passes the query state in as a parameter, so all of
 * them would stay green over the wrong answer — a fabricated state the real repo
 * cannot produce. This one runs against a REAL `Repo` and pins BOTH halves: the
 * repo's handle really does say `ready`, and our probe really must not.
 */
describe('documentRepoState against a real 2.6 Repo', () => {
  /** A storage adapter whose reads never settle — a cold table, or the one
   * condition that keeps a real `DocumentQuery` in `loading`: a source that is
   * still trying. `release()` lets the repo shut down instead of hanging. */
  function stallingStorage() {
    const waiting: (() => void)[] = []
    const stall = <T>(value: T) => new Promise<T>((resolve) => { waiting.push(() => resolve(value)) })
    return {
      adapter: {
        load: () => stall<Uint8Array | undefined>(undefined),
        save: async () => undefined,
        remove: async () => undefined,
        loadRange: () => stall<never[]>([]),
        removeRange: async () => undefined,
      },
      release: () => { for (const resume of waiting.splice(0)) resume() },
    }
  }

  it('never answers ready for a document that has not materialized', async () => {
    const { Repo: RealRepo } = await import('@automerge/automerge-repo')
    const documentId = '2oqD6jdnyr3sv35Up38MapoQRMX7'
    const url = `automerge:${documentId}`
    const anyId = url as Parameters<Repo['findWithProgress']>[0]
    const storage = stallingStorage()
    const repo = new RealRepo({ storage: storage.adapter, network: [] })
    try {
      // The attempt that instantiates the handle. It cannot settle while the
      // only source is still reading, which is the whole point.
      const pending = repo.find(anyId)
      pending.catch(() => undefined)
      await Promise.resolve()

      // The repo's own answer, pinned so a future automerge-repo that grows a
      // waiting state fails HERE rather than silently changing what this
      // module reports.
      expect((repo.handles as Record<string, { state?: string }>)[documentId]?.state).toBe('ready')
      expect(repo.findWithProgress(anyId).peek().state).toBe('loading')

      // Ours. `loading` is the repo answering precisely — in flight — and it
      // classifies as `unexpected`, never as a licence to call the document
      // materialized.
      expect(documentRepoState(repo, url)).toBe('loading')

      // And what the two production callers do with it, asserted rather than
      // reasoned about: neither may treat a loading document as resolved.
      expect(classifyDocumentResolutionError(new Error('boom'), () => documentRepoState(repo, url)))
        .toBe('unexpected')
      await expect(releaseUnavailableDocument(repo, url)).resolves.toBe(false)
    } finally {
      storage.release()
      await repo.shutdown().catch(() => undefined)
    }
  })
})
