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
  isRetryableDocumentResolutionError,
  DocumentPermanentlyUnavailableError,
  DocumentTemporarilyUnavailableError,
} from './documentResolution'

/**
 * Mirror of `server/src/readModel/documentResolution.test.ts`.
 *
 * The client copy of the classifier cannot import the server one (separate npm
 * package, `rootDir: ./src`, NodeNext vs bundler resolution), so this file
 * re-asserts the same classification table. If either copy is edited alone, the
 * two suites disagree and one of them fails — which is the point: retry
 * behaviour must not diverge between the browser and the projector.
 */

/** `#docSynchronizers` for a fake, DERIVED from its handle table and never a
 *  second knob. The real `Repo` keeps the two in lockstep — `#ensureQuery`
 *  attaches every source synchronously as it registers the query, and
 *  `removeFromCache` and `delete` drop both together — which is what lets
 *  production read residency in O(1) (`repoCompat.ts`) instead of rebuilding
 *  the whole handle Record per access. A fake that offers one table and not
 *  the other models a repo that cannot exist, and would stay green over code
 *  reading the table production actually consults. A getter, not a snapshot,
 *  because these tables are mutated in place. */
function syncLayerOver(handles: Record<string, unknown>) {
  return {
    get docSynchronizers() {
      return Object.fromEntries(
        Object.entries(handles).map(([id, handle]) => [id, { query: { handle } }]),
      )
    },
  }
}

/** A repo whose progress query reports `state`, as automerge-repo does. */
function fakeRepo(state: string, overrides: Partial<Record<string, unknown>> = {}): Repo {
  const handles = (overrides.handles ?? {}) as Record<string, unknown>
  return {
    findWithProgress: () => ({ peek: () => ({ state }) }),
    ...overrides,
    handles,
    synchronizer: syncLayerOver(handles),
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
    const storageOutage = Object.assign(new Error('IndexedDB quota exceeded'), {
      name: 'QuotaExceededError',
    })

    expect(classifyDocumentResolutionError(storageOutage)).toBe('unexpected')
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

/** The boot pipeline keys its resident/cached-root fallback on this predicate.
 * Its semantics are FIXED here: the `retryable` FIELD is the contract,
 * not the class identity — a failure re-thrown across a wrapper (batched
 * resolution, a cause chain) keeps its meaning — and the comparison is strict
 * `=== true` so no truthy garbage ever reads as retryable. */
describe('isRetryableDocumentResolutionError', () => {
  it('recognizes the two resolution classes by their declared retryable field', () => {
    expect(isRetryableDocumentResolutionError(new DocumentTemporarilyUnavailableError('automerge:a', 1))).toBe(true)
    expect(isRetryableDocumentResolutionError(new DocumentPermanentlyUnavailableError('automerge:a'))).toBe(false)
  })

  it('never reads a bare Error (or nothing at all) as retryable', () => {
    expect(isRetryableDocumentResolutionError(new Error('boom'))).toBe(false)
    expect(isRetryableDocumentResolutionError(null)).toBe(false)
    expect(isRetryableDocumentResolutionError(undefined)).toBe(false)
    expect(isRetryableDocumentResolutionError('Document a is unavailable')).toBe(false)
  })

  it('duck-types deliberately: retryable === true survives wrappers, anything else does not', () => {
    expect(isRetryableDocumentResolutionError({ retryable: true })).toBe(true)
    expect(isRetryableDocumentResolutionError({ retryable: 'true' })).toBe(false)
    expect(isRetryableDocumentResolutionError({ retryable: 1 })).toBe(false)
    expect(isRetryableDocumentResolutionError({ retryable: false })).toBe(false)
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
    // `loading` is its own answer. `unknown` is reserved for "the
    // probe could not ask", which is a different fact about a different subject.
    expect(documentRepoState(fakeRepo('loading'), 'automerge:a')).toBe('loading')
    expect(documentRepoState(fakeRepo('a-state-2.7-invented'), 'automerge:a')).toBe('unknown')
  })

  it('falls back to the cached handle state — the 2.5 clause, and ONLY that', () => {
    // Note: `DocHandle.state` is `deleted` or `ready` and nothing else in
    // 2.6.0-alpha.2, so this fixture is OUT OF THE PINNED REPO'S DOMAIN. The
    // branch it covers is the declared 2.5 compatibility clause in
    // `documentRepoState`, which is dead on the installed version.
    //
    // It is kept, not deleted, because the clause is kept: it can only push
    // the verdict toward "retry" or "give up", never toward "this document
    // has materialized", so it is safe in a way a `handleState === 'ready'`
    // short-circuit is not. A fixture of this shape must never stand in for a
    // state the REAL repo produces.
    const repo = fakeRepo('loading', { handles: { a: { documentId: 'a', state: 'unavailable' } } })

    expect(documentRepoState(repo, 'automerge:a')).toBe('unavailable')
  })

  it('never throws when the repo cannot answer', () => {
    // Sync layer intact, query throwing: without a synchronizer the residency
    // lookup would throw FIRST and this test would pass without ever reaching
    // the statement it is named for.
    const repo = fakeRepo('ready', {
      findWithProgress: () => { throw new Error('repo exploded') },
    })

    expect(documentRepoState(repo, 'automerge:a')).toBe('unknown')
  })
})

/**
 * The probe must not repeat the repo's own misleading `ready`.
 *
 * `DocHandle.state` is `deleted` or `ready` AND NOTHING ELSE in 2.6.0-alpha.2
 * (`this.#document.deleted ? "deleted" : "ready"`): there is no waiting state to
 * report, so the handle reads `ready` from the instant `find()` instantiates it
 * — for a document that has not received a single byte. A probe that
 * short-circuits on `handleState === 'ready'` would make every downstream
 * recovery guarded on `!== 'ready'` (e.g. `releaseUnavailableDocument`) unable
 * to run. A fixture that passes the probe state in as a parameter would
 * fabricate a state the real repo cannot produce and hide this.
 *
 * So this one runs against a REAL `Repo`, and pins BOTH halves: the repo's
 * handle really does say `ready`, and our probe really must not.
 */
describe('documentRepoState against a real 2.6 Repo', () => {
  /** A storage adapter whose reads never settle — a cold IndexedDB, or the one
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
      // waiting state fails HERE rather than silently re-enabling the eviction.
      expect((repo.handles as Record<string, { state?: string }>)[documentId]?.state).toBe('ready')
      expect(repo.findWithProgress(anyId).peek().state).toBe('loading')

      // Ours. `loading` is the repo answering precisely — in flight — and it
      // classifies as `unexpected`, never as a licence to call the document
      // materialized.
      expect(documentRepoState(repo, url)).toBe('loading')
    } finally {
      storage.release()
      await repo.shutdown().catch(() => undefined)
    }
  })
})
