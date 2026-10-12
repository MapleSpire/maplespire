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
import * as browser from './documentResolution'
import * as projector from '../../../server/src/readModel/documentResolution.js'

/**
 * ONE table of cases, run through BOTH copies of the module.
 *
 * The browser copy and `server/src/readModel/documentResolution.ts` are two
 * implementations of one contract, and they can drift on the most load-bearing
 * line — e.g. answering `ready` out of `DocHandle.state` for a document that
 * has not received a byte.
 *
 * Why this shape and not a source-text comparison of the two files:
 *
 *  - a text gate says "these differ", never "which one is right". Faced with a
 *    red one, making the files identical by ADDING `|| handleState === 'ready'`
 *    back to this side is just as easy as removing it there;
 *  - a text gate compares TEXT, and what has to agree is BEHAVIOUR. (Note both
 *    `syncedHandle` helpers import the package with `import type` only, so this
 *    whole table runs under the root install.)
 *  - the region a text gate can compare is exactly the region that never
 *    drifted. The real divergences are in the exports the two files do NOT
 *    share (see "Deliberately outside the table" below), so its scope would be
 *    carved to avoid them.
 *
 * ⚠ WHAT THIS FILE CANNOT SEE, and why the server keeps its own suite.
 * Everything here runs under the ROOT install of `@automerge/automerge-repo` —
 * including the `projector` row, because `syncedHandle` on both sides is a plain
 * property read over `import type` declarations and loads no package at all. The
 * server process runs under `server/node_modules`, a second install of the same
 * exactly-pinned version, and NOTHING here would notice if the two diverged. So
 * `server/src/readModel/documentResolution.test.ts` keeps a real-`Repo` case of
 * its own; that one is the only assertion in the tree that ever executes
 * against the package the server actually loads. Neither file is redundant and
 * neither is sufficient.
 *
 * Deliberately outside the table, because the two modules genuinely do not
 * share them — named here rather than left for the next reader to trip on:
 *   - `isRetryableDocumentResolutionError` — browser only;
 *   - `releaseUnavailableDocument` — in the projector's copy of this module, but
 *     in `handleRetry.ts` on the browser side;
 *   - the two error classes' field lists, which differ in nothing observable but
 *     are constructed differently.
 */

/** The surface both copies must implement, structurally. Declaring it here is
 *  what makes a REMOVED or RENAMED export on either side a compile error rather
 *  than a skipped case: `satisfies` below is checked against both. */
interface ResolutionModule {
  documentIdOf: (url: string) => string
  describeDocumentResolutionFailure: (
    url: string,
    error: unknown,
    outcome: 'unavailable' | 'invalid' | 'aborted' | 'unexpected',
    attempts?: number,
  ) => { documentId: string; outcome: string; errorName: string; errorMessage: string; attempts?: number }
  classifyDocumentResolutionError: (
    error: unknown,
    probeState?: () => 'ready' | 'loading' | 'unavailable' | 'deleted' | 'unknown',
  ) => 'unavailable' | 'invalid' | 'aborted' | 'unexpected'
  documentRepoState: (repo: Repo, url: string) => 'ready' | 'loading' | 'unavailable' | 'deleted' | 'unknown'
  DocumentTemporarilyUnavailableError: new (url: string, attempts: number, options?: { cause?: unknown }) => Error
  DocumentPermanentlyUnavailableError: new (url: string, options?: { cause?: unknown }) => Error
}

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, ResolutionModule]> = [
  ['browser', browser satisfies ResolutionModule],
  ['projector', projector satisfies ResolutionModule],
]

/**
 * A repo whose progress query reports `state`, as automerge-repo does.
 *
 * `docSynchronizers` is a GETTER derived from `handles`, not a snapshot and not
 * a second knob: the real `Repo` cannot have one without the other (their key
 * sets are equal in every reachable state, pinned against a real Repo by
 * `automergeRepoCompat.seam.test.ts`), and it is mutated in place. A fixture
 * offering `handles` alone models a repo that cannot exist, and would then stay
 * green over code reading the table production actually uses.
 */
function fakeRepo(state: string, overrides: Record<string, unknown> = {}): Repo {
  const handles = (overrides.handles ?? {}) as Record<string, unknown>
  return {
    findWithProgress: () => ({ peek: () => ({ state }) }),
    ...overrides,
    handles,
    get synchronizer() {
      return {
        docSynchronizers: Object.fromEntries(
          Object.entries(handles).map(([id, handle]) => [id, { query: { handle } }]),
        ),
      }
    },
  } as unknown as Repo
}

describe.each(IMPLEMENTATIONS)('documentResolution conformance — %s', (_name, module) => {
  const {
    classifyDocumentResolutionError,
    describeDocumentResolutionFailure,
    documentIdOf,
    documentRepoState,
    DocumentPermanentlyUnavailableError,
    DocumentTemporarilyUnavailableError,
  } = module

  it('reads the repo unavailability message as retryable WITHOUT probing', () => {
    const probe = vi.fn(() => 'unknown' as const)

    expect(classifyDocumentResolutionError(new Error('Document abc is unavailable'), probe)).toBe('unavailable')
    // Not an optimisation: `documentRepoState` CREATES the progress query when
    // none exists, so probing where the message already decided would
    // materialize documents on the failure path.
    expect(probe).not.toHaveBeenCalled()
  })

  it('never retries a deleted document or a malformed url', () => {
    for (const message of [
      'Document abc was deleted',
      "Invalid AutomergeUrl: 'nope'",
      'Invalid document URL: nope',
      'Invalid documentId: nope',
      'Invalid URL: contains multiple heads sections',
      'Invalid head in URL: zz',
    ]) {
      expect(classifyDocumentResolutionError(new Error(message)), message).toBe('invalid')
    }
  })

  it('propagates an unrelated failure instead of absorbing it into a retry loop', () => {
    const outage = Object.assign(new Error('terminating connection due to administrator command'), {
      code: '57P01',
    })

    expect(classifyDocumentResolutionError(outage)).toBe('unexpected')
  })

  it('maps every repo state to the same outcome on both sides', () => {
    const anonymous = new Error('boom')

    expect(classifyDocumentResolutionError(anonymous, () => 'unavailable')).toBe('unavailable')
    expect(classifyDocumentResolutionError(anonymous, () => 'deleted')).toBe('invalid')
    expect(classifyDocumentResolutionError(anonymous, () => 'ready')).toBe('unexpected')
    expect(classifyDocumentResolutionError(anonymous, () => 'unknown')).toBe('unexpected')
    // `loading` is NOT a licence to retry, and this line is the whole
    // reason the state was given a name: it pins the decision instead of
    // leaving it to fall out of the catch-all. Promoting it to `unavailable`
    // is a retry-policy change and must fail HERE first.
    expect(classifyDocumentResolutionError(anonymous, () => 'loading')).toBe('unexpected')
  })

  it('propagates cancellation untouched', () => {
    for (const name of ['AbortError', 'TimeoutError']) {
      const cancelled = Object.assign(new Error('cancelled'), { name })
      expect(classifyDocumentResolutionError(cancelled, () => 'unavailable'), name).toBe('aborted')
    }
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

  it('strips the scheme and any heads suffix', () => {
    expect(documentIdOf('automerge:abc?heads=zz')).toBe('abc')
    expect(documentIdOf('abc')).toBe('abc')
  })

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

  it('carries the same machine codes and retryability', () => {
    const temporary = new DocumentTemporarilyUnavailableError('automerge:abc?heads=zz', 4) as Error & {
      code: string; retryable: boolean; documentId: string; attempts: number
    }
    const permanent = new DocumentPermanentlyUnavailableError('automerge:abc') as Error & {
      code: string; retryable: boolean; documentId: string
    }

    expect(temporary.code).toBe('read_model_document_unavailable')
    expect(temporary.retryable).toBe(true)
    expect(temporary.documentId).toBe('abc')
    expect(temporary.attempts).toBe(4)
    expect(permanent.code).toBe('read_model_document_invalid')
    expect(permanent.retryable).toBe(false)
  })

  it('reports what the repo believes', () => {
    expect(documentRepoState(fakeRepo('unavailable'), 'automerge:a')).toBe('unavailable')
    expect(documentRepoState(fakeRepo('ready'), 'automerge:a')).toBe('ready')
    expect(documentRepoState(fakeRepo('loading'), 'automerge:a')).toBe('loading')
    // `deleted` is the arm that decides PERMANENT ABANDONMENT rather than
    // retry: it becomes `invalid` in `classifyDocumentResolutionError`, and
    // `projectorService` turns that into `DocumentPermanentlyUnavailableError`
    // instead of re-queueing. Deleting the clause would silently downgrade an
    // abandon to an `unexpected` raised at the caller.
    expect(documentRepoState(fakeRepo('deleted'), 'automerge:a')).toBe('deleted')
    expect(documentRepoState(fakeRepo('something-2.7-invented'), 'automerge:a')).toBe('unknown')
  })

  it('lets the cached handle report a deleted document the query has not caught up with', () => {
    // Second half of the same arm, and the one a fixture can reach: the handle
    // side. `DocHandle.delete()` leaves `state: 'deleted'` AND the handle in the
    // cache, and `repo.find` on it RESOLVES rather than throwing — so this
    // clause is the only thing that names the document terminal.
    expect(documentRepoState(fakeRepo('loading', {
      handles: { a: { documentId: 'a', state: 'deleted' } },
    }), 'automerge:a')).toBe('deleted')
  })

  it('lets the cached handle push the answer toward retry, never toward ready', () => {
    // These two clauses are 2.5 compatibility: `DocHandle.state` on the pinned
    // 2.6.0-alpha.2 is `ready` or `deleted` and NOTHING else, so `unavailable`
    // is a state the installed repo cannot produce. The fixture is therefore
    // OUT OF DOMAIN on purpose — and this shape of fixture (feeding the probe a
    // state the repo cannot reach) is exactly what can hide a defect, so it is
    // used only for the conservative direction. It may push toward retry.
    expect(documentRepoState(fakeRepo('loading', {
      handles: { a: { documentId: 'a', state: 'unavailable' } },
    }), 'automerge:a')).toBe('unavailable')

    // And it may never push toward `ready`, which is the defect itself: a
    // handle reads `ready` from the instant `find()` instantiates it.
    expect(documentRepoState(fakeRepo('loading', {
      handles: { a: { documentId: 'a', state: 'ready' } },
    }), 'automerge:a')).toBe('loading')
  })

  it('never throws when the repo cannot answer', () => {
    // The synchronizer is intact and the QUERY throws: without a synchronizer
    // the residency lookup would throw first and this case would pass while
    // never reaching the statement it names.
    const repo = fakeRepo('ready', { findWithProgress: () => { throw new Error('repo exploded') } })

    expect(documentRepoState(repo, 'automerge:a')).toBe('unknown')
  })

  it('never answers ready for a document that has not materialized', async () => {
    // The one case that runs against a real `Repo` rather than a fixture. Every
    // fixture above passes the query state in as a parameter, so all of them
    // would stay green over a probe that repeats the repo's own lie.
    const { Repo: RealRepo } = await import('@automerge/automerge-repo')
    const documentId = '2oqD6jdnyr3sv35Up38MapoQRMX7'
    const url = `automerge:${documentId}`
    const anyId = url as Parameters<Repo['findWithProgress']>[0]
    /** Reads that never settle — a cold store, i.e. the one condition that keeps
     *  a real `DocumentQuery` in `loading`: a source that is still trying. */
    const waiting: (() => void)[] = []
    const stall = <T>(value: T) => new Promise<T>((resolve) => { waiting.push(() => resolve(value)) })
    const repo = new RealRepo({
      storage: {
        load: () => stall<Uint8Array | undefined>(undefined),
        save: async () => undefined,
        remove: async () => undefined,
        loadRange: () => stall<never[]>([]),
        removeRange: async () => undefined,
      },
      network: [],
    })
    try {
      const pending = repo.find(anyId)
      pending.catch(() => undefined)
      await Promise.resolve()

      // The repo's own answer, pinned so a future automerge-repo that grows a
      // waiting state fails HERE rather than silently changing what these
      // modules report.
      expect((repo.handles as Record<string, { state?: string }>)[documentId]?.state).toBe('ready')
      expect(repo.findWithProgress(anyId).peek().state).toBe('loading')

      expect(documentRepoState(repo, url)).toBe('loading')
      expect(classifyDocumentResolutionError(new Error('boom'), () => documentRepoState(repo, url)))
        .toBe('unexpected')
    } finally {
      for (const resume of waiting.splice(0)) resume()
      await repo.shutdown().catch(() => undefined)
    }
  })
})
